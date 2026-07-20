import { useEffect, useRef } from 'react';
import type { Workspace, ContainerContent } from '../../shared/types';
import { getSqlWorkbench, type SqlWorkbenchHandle } from '../components/sql/sqlWorkbenchRegistry';
import { classifyBatch } from '../components/sql/sqlClassify';

// ─── Agent SQL bridge (renderer side) ────────────────────────────────────────
// Receives an agent's SQL command (forwarded from main, keyed by reqId), resolves
// the caller's workspace from the live layout, picks a SQL pane in THAT workspace,
// and drives it through the workbench registry so results surface in the panel.
// The main-side bridge is a thin relay + the authoritative read gate; the renderer
// owns the layout + the live SQL connections.
//
// WRITE GATE: every command carries `writeAllowed`, read from main on each call.
// The renderer classifies statements (it has the tokenizer) but can never
// self-grant write — if a statement is a write and writeAllowed is false we
// refuse the WHOLE batch. So write enforcement stays authoritative in main.
//
// CONTAINER POLICY (workspace-scoped, never cross-workspace):
//   • exactly one SQL pane → use it.
//   • none → for commands that need a pane we AUTO-CREATE one (low friction; the
//     agent then runs `use <conn>` to connect it). `list`/`connections` work
//     without one.
//   • multiple → act on the FIRST and report `targetedMultiple` so the agent
//     knows there were others (keeps the surface simple; no --container needed).

interface BridgeDeps {
  workspaces: Workspace[];
  // Content-agnostic container creator (same one the browser/terminal bridges use).
  createContainer: (workspaceId: string, content: ContainerContent) => string;
}

type Reply = { ok: boolean; data?: Record<string, unknown>; error?: string };

const HELP = {
  usage: 'splitgrid-sql <command> [args]   (acts on the SQL pane in YOUR workspace)',
  commands: [
    'list                         — SQL panes in this workspace + which is targeted',
    'connections                  — saved SQL connections (label, dialect, host, db)',
    'use <conn> [database]        — switch the target pane to a saved connection',
    'open <conn>                  — create a SQL pane if none, then `use <conn>`',
    'tables [schema]              — tables/views in a schema (default current)',
    'columns <table> [schema]     — columns with type / nullable / PK',
    'ddl <table> [schema]         — the table\'s DDL text',
    'query <sql>                  — run SQL (surfaces in a tab); write-gated',
    'explain <sql>                — EXPLAIN the SQL (read)',
    'export <table> <format> <path> [schema]  — export a table to a file (csv|json|sql|xlsx)',
    'import <table> <csvpath> [schema]        — import a CSV into a table (write-gated)',
    'screenshot [path]            — capture the app window to a PNG (handled in main)',
  ],
};

const MAX_TABLE_ROWS = 100;

export function useSqlAgentBridge(deps: BridgeDeps): void {
  // The IPC listener is registered once; read live state through a ref so it
  // always sees the current workspaces without re-subscribing.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const handle = async (payload: { reqId: string; terminal: string; argv: string[]; writeAllowed: boolean }): Promise<void> => {
      const { reqId, terminal, argv, writeAllowed } = payload;
      let reply: Reply;
      try {
        reply = await runSqlCommand(depsRef.current, terminal, argv, !!writeAllowed);
      } catch (err) {
        reply = { ok: false, error: (err as Error).message || 'internal_error' };
      }
      window.electronAPI.sendSqlResult({ reqId, ...reply });
    };

    const unsub = window.electronAPI.onSqlCommand((payload) => { void handle(payload); });
    return unsub;
  }, []);
}

// SQL containers in a workspace.
function sqlContainersOf(ws: Workspace): Array<{ id: string }> {
  return ws.containers.filter((c) => c.content.type === 'sql').map((c) => ({ id: c.id }));
}

// Render rows[] + columns[] as a compact monospace text table, capped at
// MAX_TABLE_ROWS rows with a truncation note. Wide cells are clipped.
function renderTextTable(columns: string[], rows: Array<Record<string, unknown>>): string {
  if (columns.length === 0) return '(no columns)';
  const MAX_CELL = 40;
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return 'NULL';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    s = s.replace(/\n/g, ' ');
    if (s.length > MAX_CELL) s = `${s.slice(0, MAX_CELL - 1)}…`;
    return s;
  };
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const widths = columns.map((c) => c.length);
  const body = shown.map((r) => columns.map((c, i) => {
    const text = cell(r[c]);
    if (text.length > widths[i]) widths[i] = text.length;
    return text;
  }));
  const sep = (ch: string) => widths.map((w) => ch.repeat(w + 2)).join('+');
  const line = (cells: string[]) => `|${cells.map((t, i) => ` ${t.padEnd(widths[i])} `).join('|')}|`;
  const out: string[] = [];
  out.push(sep('-'));
  out.push(line(columns));
  out.push(sep('='));
  for (const r of body) out.push(line(r));
  out.push(sep('-'));
  if (rows.length > shown.length) out.push(`… ${rows.length - shown.length} more rows (showing ${shown.length} of ${rows.length})`);
  return out.join('\n');
}

async function runSqlCommand(deps: BridgeDeps, terminal: string, argv: string[], writeAllowed: boolean): Promise<Reply> {
  const { workspaces, createContainer } = deps;
  const cmd = (argv[0] || '').toLowerCase();
  const rest = argv.slice(1);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === '') {
    return { ok: true, data: { ...HELP } };
  }

  // Caller's workspace = the one holding its terminal. Refuse rather than guess
  // (guessing could drive a SQL pane in the wrong window/workspace).
  const callerWs =
    workspaces.find((ws) => ws.containers.some((c) => c.content.terminalId === terminal)) ?? null;
  if (!callerWs) {
    return { ok: false, error: 'no_workspace', data: { message: 'cannot locate the calling terminal\'s workspace' } };
  }

  const panes = sqlContainersOf(callerWs);

  // `list` — SQL panes in this workspace + each one's connection/dialect/db state.
  if (cmd === 'list') {
    const targetId = panes[0]?.id;
    return {
      ok: true,
      data: {
        workspace: callerWs.name,
        targeted: targetId ?? null,
        panes: panes.map((p) => {
          const h = getSqlWorkbench(p.id);
          const info = h?.getInfo();
          return {
            id: p.id,
            targeted: p.id === targetId,
            connected: info?.connected ?? false,
            connection: info?.connectionName ?? null,
            dialect: info?.dialect ?? null,
            database: info?.database ?? null,
            schema: info?.schema ?? null,
          };
        }),
      },
    };
  }

  // Resolve a workbench handle to act on (any open pane has the same registry of
  // saved connections, so `connections` can use the first too — but it doesn't
  // strictly need one).
  const resolveHandle = (): { handle: SqlWorkbenchHandle | null; id: string | null; multiple: boolean } => {
    if (panes.length === 0) return { handle: null, id: null, multiple: false };
    const id = panes[0].id;
    return { handle: getSqlWorkbench(id) ?? null, id, multiple: panes.length > 1 };
  };

  // `connections` — saved SQL connections (no secrets). Available even with no
  // pane open (falls back to the electronAPI read).
  if (cmd === 'connections' || cmd === 'conns') {
    const { handle } = resolveHandle();
    if (handle) {
      return { ok: true, data: { connections: handle.listConnections() } };
    }
    const saved = await window.electronAPI.sqlGetSavedConnections();
    return {
      ok: true,
      data: { connections: saved.map((c) => ({ id: c.id, label: c.label, dialect: c.dialect, host: c.host, port: c.port, database: c.database })) },
    };
  }

  // `open <conn>` — ensure a SQL pane exists, then connect it.
  if (cmd === 'open') {
    const conn = rest.join(' ').trim();
    if (!conn) return { ok: false, error: 'missing_connection', data: { message: 'usage: open <connection name|id>  (run: connections)' } };
    let id = panes[0]?.id;
    let created = false;
    if (!id) {
      id = createContainer(callerWs.id, { type: 'sql', label: 'SQL Client' });
      created = true;
    }
    // The freshly-created pane registers its handle on mount; poll briefly.
    const handle = await waitForHandle(id);
    if (!handle) return { ok: false, error: 'pane_not_ready', data: { surface: id, created, message: 'SQL pane is still mounting; retry the command' } };
    try {
      const info = await handle.useConnection(conn);
      return { ok: true, data: { surface: id, created, ...info } };
    } catch (err) {
      return { ok: false, error: 'connect_failed', data: { surface: id, created, message: (err as Error).message } };
    }
  }

  // All remaining commands need a pane. Auto-create one if none exists.
  let { handle, id, multiple } = resolveHandle();
  if (!handle) {
    id = createContainer(callerWs.id, { type: 'sql', label: 'SQL Client' });
    handle = await waitForHandle(id);
    multiple = false;
    if (!handle) return { ok: false, error: 'pane_not_ready', data: { surface: id, message: 'opened a SQL pane; retry the command' } };
  }
  const note = multiple ? { targetedMultiple: panes.length, surface: id } : { surface: id };

  switch (cmd) {
    case 'use': {
      const conn = rest[0];
      if (!conn) return { ok: false, error: 'missing_connection', data: { message: 'usage: use <connection name|id> [database]', ...note } };
      const database = rest[1];
      try {
        const info = await handle.useConnection(conn, database);
        return { ok: true, data: { ...note, ...info } };
      } catch (err) {
        return { ok: false, error: 'connect_failed', data: { ...note, message: (err as Error).message } };
      }
    }
    case 'tables': {
      const schema = rest[0];
      const tables = handle.listTables(schema);
      return { ok: true, data: { ...note, schema: schema ?? handle.getInfo().schema, count: tables.length, tables } };
    }
    case 'columns': {
      const table = rest[0];
      if (!table) return { ok: false, error: 'missing_table', data: { message: 'usage: columns <table> [schema]', ...note } };
      const cols = await handle.listColumns(table, rest[1]);
      const text = renderTextTable(
        ['column', 'type', 'nullable', 'pk'],
        cols.map((c) => ({ column: c.column, type: c.dataType, nullable: c.nullable, pk: c.primaryKey })),
      );
      return { ok: true, data: { ...note, table, count: cols.length, columns: cols, output: text } };
    }
    case 'ddl': {
      const table = rest[0];
      if (!table) return { ok: false, error: 'missing_table', data: { message: 'usage: ddl <table> [schema]', ...note } };
      try {
        const ddl = await handle.getDdl(table, rest[1]);
        return { ok: true, data: { ...note, table, ddl } };
      } catch (err) {
        return { ok: false, error: 'ddl_failed', data: { ...note, message: (err as Error).message } };
      }
    }
    case 'query': {
      const sql = rest.join(' ').trim();
      if (!sql) return { ok: false, error: 'missing_sql', data: { message: 'usage: query <sql>', ...note } };
      const cls = classifyBatch(sql);
      if (cls.hasWrite && !writeAllowed) {
        return { ok: false, error: 'write_blocked', data: { ...note, message: 'This statement modifies data/schema. Ask the user to enable "Allow agents to modify data" in Settings.' } };
      }
      try {
        const r = await handle.runQuery(sql);
        const text = renderTextTable(r.columns, r.rows);
        return { ok: true, data: { ...note, rowCount: r.rowCount, durationMs: r.durationMs, columns: r.columns, command: r.command, output: text } };
      } catch (err) {
        return { ok: false, error: 'query_failed', data: { ...note, message: (err as Error).message } };
      }
    }
    case 'explain': {
      const sql = rest.join(' ').trim();
      if (!sql) return { ok: false, error: 'missing_sql', data: { message: 'usage: explain <sql>', ...note } };
      // EXPLAIN (without ANALYZE) is a read — no write gate.
      try {
        const r = await handle.explain(sql);
        const text = renderTextTable(r.columns, r.rows);
        return { ok: true, data: { ...note, rowCount: r.rowCount, durationMs: r.durationMs, output: text } };
      } catch (err) {
        return { ok: false, error: 'explain_failed', data: { ...note, message: (err as Error).message } };
      }
    }
    case 'export': {
      const table = rest[0];
      const format = (rest[1] || '').toLowerCase();
      const filePath = rest[2];
      const schema = rest[3];
      if (!table || !format || !filePath) {
        return { ok: false, error: 'usage', data: { message: 'usage: export <table> <csv|json|sql|xlsx> <path> [schema]', ...note } };
      }
      if (!['csv', 'json', 'sql', 'xlsx'].includes(format)) {
        return { ok: false, error: 'bad_format', data: { message: 'format must be csv|json|sql|xlsx', ...note } };
      }
      // Export is a READ of the DB (the file it writes the agent could write via
      // shell anyway), so it's allowed under the read gate.
      try {
        const r = await handle.exportTable(table, format as 'csv' | 'json' | 'sql' | 'xlsx', filePath, schema);
        return { ok: true, data: { ...note, table, format, ...r } };
      } catch (err) {
        return { ok: false, error: 'export_failed', data: { ...note, message: (err as Error).message } };
      }
    }
    case 'import': {
      const table = rest[0];
      const csvPath = rest[1];
      const schema = rest[2];
      if (!table || !csvPath) {
        return { ok: false, error: 'usage', data: { message: 'usage: import <table> <csvpath> [schema]', ...note } };
      }
      // Import mutates the table → WRITE gated.
      if (!writeAllowed) {
        return { ok: false, error: 'write_blocked', data: { ...note, message: 'Importing modifies data. Ask the user to enable "Allow agents to modify data" in Settings.' } };
      }
      try {
        const r = await handle.importCsv(table, csvPath, schema);
        return { ok: true, data: { ...note, table, ...r } };
      } catch (err) {
        return { ok: false, error: 'import_failed', data: { ...note, message: (err as Error).message } };
      }
    }
    default:
      return { ok: false, error: 'unknown_command', data: { message: `unknown command: ${cmd}`, ...note } };
  }
}

// A freshly-created SQL pane registers its handle on mount (an effect). Poll the
// registry briefly so `open`/auto-create commands can act on it the same turn.
async function waitForHandle(id: string, timeoutMs = 4000): Promise<SqlWorkbenchHandle | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = getSqlWorkbench(id);
    if (h) return h;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}
