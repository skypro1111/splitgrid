import { useEffect, useRef } from 'react';
import type {
  Workspace, Container, ContainerContent, TerminalSessionInfo,
  LocalShellConfig, SavedConnection,
} from '../../shared/types';

// ─── Agent terminal bridge (renderer side) ───────────────────────────────────
// Receives an agent's terminal command (forwarded from main, keyed by reqId),
// resolves the caller's workspace from the live layout, and runs the command
// against the terminals IN THAT WORKSPACE ONLY. The renderer owns both the
// layout (which terminal belongs to which workspace) and the terminal I/O
// surface (sendData / getSessionBuffer / getTerminalProcessTree via electronAPI),
// so the main-side bridge is a pure relay. Scope rule: an agent may only see and
// drive terminals in its own workspace; any other target id is rejected.

interface BridgeDeps {
  workspaces: Workspace[];
  // Create a filled container (any content) in a specific workspace, splitting
  // its focused/first pane. The workspace function is historically named
  // `createBrowserContainer` but is content-agnostic — we use it for terminals too.
  createContainer: (workspaceId: string, content: ContainerContent) => string;
  // Remove a container from whichever workspace holds it (closes the pane).
  removeContainer: (containerId: string) => void;
  // Spawn a local PTY / connect a saved SSH session (async; returns its info).
  createLocalTerminal: (config?: LocalShellConfig) => Promise<TerminalSessionInfo>;
  connectSaved: (savedId: string) => Promise<TerminalSessionInfo>;
  // Kill a terminal session (PTY / SSH channel).
  closeSession: (id: string) => Promise<void>;
  // Saved SSH connections, so an agent can open one by name.
  savedConnections: SavedConnection[];
}

type Reply = { ok: boolean; data?: Record<string, unknown>; error?: string };

const HELP = {
  usage: 'splitgrid-terminal <command> [args]   (acts on terminals in YOUR workspace only)',
  commands: [
    'list                         — terminals in this workspace (id, label, status, cwd)',
    'read <id> [--tail N]         — recent output of a terminal (default last 200 lines)',
    'info <id>                    — a terminal\'s label, status, cwd, shell, type',
    'tree <id>                    — the terminal\'s live process tree (local only)',
    'send <id> <text...>          — type text + Enter (runs it as a command)',
    'type <id> <text...>          — type text WITHOUT Enter',
    'key  <id> <name>             — send a key: enter|tab|esc|up|down|left|right|',
    '                               home|end|pageup|pagedown|backspace|delete|space|',
    '                               ctrl-c|ctrl-d|ctrl-z|ctrl-l|ctrl-<letter>',
    'open [label]                 — open a new LOCAL terminal in this workspace',
    'open ssh <connection>        — open an SSH terminal from a saved connection',
    'connections                  — list saved SSH connections (name + host) for `open ssh`',
    'close <id>                   — close a terminal in this workspace (kills it + its pane)',
  ],
};

const DEFAULT_TAIL_LINES = 200;

// Named keys → the bytes a PTY expects. ctrl-<letter> is computed (see toKeyBytes).
const NAMED_KEYS: Record<string, string> = {
  enter: '\n', return: '\n', tab: '\t', esc: '\x1b', escape: '\x1b', space: ' ',
  backspace: '\x7f', delete: '\x1b[3~', del: '\x1b[3~',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
};

// Resolve a key name to the bytes to write. Supports named keys above and any
// control combo: ctrl-c / ctrl+c / ^c → 0x03, etc.
function toKeyBytes(name: string): string | null {
  const k = name.toLowerCase();
  if (k in NAMED_KEYS) return NAMED_KEYS[k];
  const m = /^(?:ctrl[-+]|\^)([a-z])$/.exec(k);
  if (m) return String.fromCharCode(m[1].charCodeAt(0) - 96); // 'a'(97) → 1 (Ctrl-A)
  return null;
}

// Strip the noisiest ANSI so a buffer is readable to an agent: SGR/CSI control
// sequences and OSC strings. Cursor-move sequences may remain — this is a "good
// enough to read" pass, not a full terminal render.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]/g;
function cleanOutput(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '');
}

// Pull a leading `--tail N` (or `--tail=N`) out of the args; return the value and
// the remaining positional args.
function takeTail(rest: string[]): { tail?: number; rest: string[] } {
  const out: string[] = [];
  let tail: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--tail' || a === '-n') { const v = Number(rest[++i]); if (Number.isFinite(v)) tail = Math.floor(v); continue; }
    const m = /^--tail=(\d+)$/.exec(a);
    if (m) { tail = Number(m[1]); continue; }
    out.push(a);
  }
  return { tail, rest: out };
}

export function useTerminalAgentBridge(deps: BridgeDeps): void {
  // The IPC listener is registered once; read live state through a ref so it
  // always sees the current workspaces without re-subscribing.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const handle = async (payload: { reqId: string; terminal: string; argv: string[] }): Promise<void> => {
      const { reqId, terminal, argv } = payload;
      let reply: Reply;
      try {
        reply = await runCommand(depsRef.current, terminal, argv);
      } catch (err) {
        reply = { ok: false, error: (err as Error).message || 'internal_error' };
      }
      window.electronAPI.sendTerminalResult({ reqId, ...reply });
    };

    const unsub = window.electronAPI.onTerminalCommand((payload) => { void handle(payload); });
    return unsub;
  }, []);
}

// Terminal containers in a workspace (local + SSH), keyed by their terminalId.
function terminalsOf(ws: Workspace): Array<{ id: string; container: Container }> {
  return ws.containers
    .filter((c) => c.content.type === 'terminal' && !!c.content.terminalId)
    .map((c) => ({ id: c.content.terminalId!, container: c }));
}

async function runCommand(deps: BridgeDeps, terminal: string, argv: string[]): Promise<Reply> {
  const { workspaces } = deps;
  const cmd = (argv[0] || '').toLowerCase();
  const rawRest = argv.slice(1);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === '') {
    return { ok: true, data: { ...HELP } };
  }

  // Caller's workspace = the one holding its terminal. Fall back to the sole
  // workspace if the terminal can't be located (e.g. just closed).
  const callerWs =
    workspaces.find((ws) => ws.containers.some((c) => c.content.terminalId === terminal)) ??
    (workspaces.length === 1 ? workspaces[0] : null);
  if (!callerWs) {
    return { ok: false, error: 'unknown_terminal', data: { message: 'cannot locate the calling terminal\'s workspace' } };
  }

  const siblings = terminalsOf(callerWs);
  const inScope = (id: string): boolean => siblings.some((t) => t.id === id);

  // Live session info for every terminal, fetched once (status/cwd/shell live in main).
  let sessions: TerminalSessionInfo[] = [];
  try { sessions = await window.electronAPI.getActiveSessions(); } catch { sessions = []; }
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  if (cmd === 'list') {
    return {
      ok: true,
      data: {
        workspace: callerWs.name,
        terminals: siblings.map((t) => {
          const s = sessionById.get(t.id);
          return {
            id: t.id,
            label: t.container.content.customName?.trim() || t.container.content.label || s?.label || 'Terminal',
            type: t.container.content.terminalType || s?.type || 'local',
            status: s?.status ?? 'unknown',
            cwd: t.container.content.cwd || s?.cwd,
            mine: t.id === terminal,
          };
        }),
      },
    };
  }

  // `connections` — saved SSH connections an agent can open by name.
  if (cmd === 'connections' || cmd === 'conns') {
    return {
      ok: true,
      data: {
        connections: deps.savedConnections.map((c) => ({
          id: c.id, label: c.label, host: c.host, username: c.username, port: c.port,
        })),
      },
    };
  }

  // `open [label]` — new LOCAL terminal in this workspace;
  // `open ssh <connection>` — SSH terminal from a saved connection.
  if (cmd === 'open') {
    if ((rawRest[0] || '').toLowerCase() === 'ssh') {
      const query = rawRest.slice(1).join(' ').trim();
      if (!query) {
        return { ok: false, error: 'missing_connection', data: { message: 'usage: open ssh <connection name|id>  (run: connections)' } };
      }
      const conns = deps.savedConnections;
      const q = query.toLowerCase();
      const match =
        conns.find((c) => c.id === query) ??
        conns.find((c) => c.label.toLowerCase() === q) ??
        conns.find((c) => c.label.toLowerCase().includes(q));
      if (!match) {
        return { ok: false, error: 'unknown_connection', data: { message: 'no saved SSH connection matches; run: connections', query, available: conns.map((c) => c.label) } };
      }
      try {
        const info = await deps.connectSaved(match.id);
        deps.createContainer(callerWs.id, {
          type: 'terminal', terminalType: 'ssh', terminalId: info.id,
          connectionId: match.id, label: match.label,
        });
        return { ok: true, data: { id: info.id, label: match.label, type: 'ssh', connection: match.label, opened: true } };
      } catch (err) {
        return { ok: false, error: 'open_failed', data: { message: (err as Error).message, connection: match.label } };
      }
    }
    // Local terminal. Treat a leading "local" as the keyword, the rest as a label.
    const words = rawRest.slice();
    if ((words[0] || '').toLowerCase() === 'local') words.shift();
    const label = words.join(' ').trim() || undefined;
    const cwd = callerWs.workingDirectory ?? undefined;
    try {
      const info = await deps.createLocalTerminal({ cwd, label });
      deps.createContainer(callerWs.id, {
        type: 'terminal', terminalType: 'local', terminalId: info.id,
        label: label ?? info.label, cwd: cwd ?? info.cwd, shell: info.shell,
      });
      return { ok: true, data: { id: info.id, label: label ?? info.label, type: 'local', opened: true } };
    } catch (err) {
      return { ok: false, error: 'open_failed', data: { message: (err as Error).message } };
    }
  }

  // All remaining commands target a specific terminal id (the first positional).
  const targetId = rawRest[0];
  if (!targetId) return { ok: false, error: 'missing_id', data: { message: `usage: ${cmd} <id> …  (run: list)` } };
  if (!inScope(targetId)) {
    return { ok: false, error: 'out_of_scope', data: { message: 'no such terminal in your workspace; run: list', id: targetId } };
  }
  const rest = rawRest.slice(1);
  const session = sessionById.get(targetId);

  switch (cmd) {
    case 'info': {
      const t = siblings.find((x) => x.id === targetId)!;
      return {
        ok: true,
        data: {
          id: targetId,
          label: t.container.content.customName?.trim() || t.container.content.label || session?.label || 'Terminal',
          type: t.container.content.terminalType || session?.type || 'local',
          status: session?.status ?? 'unknown',
          cwd: t.container.content.cwd || session?.cwd,
          shell: session?.shell,
          mine: targetId === terminal,
        },
      };
    }
    case 'read': {
      const { tail } = takeTail(rest);
      let buf = '';
      try { buf = await window.electronAPI.getSessionBuffer(targetId); } catch { buf = ''; }
      const cleaned = cleanOutput(buf);
      const lines = cleaned.split('\n');
      const n = tail && tail > 0 ? tail : DEFAULT_TAIL_LINES;
      const slice = lines.slice(-n);
      return { ok: true, data: { id: targetId, lines: slice.length, truncated: lines.length > slice.length, output: slice.join('\n') } };
    }
    case 'tree': {
      try {
        const tree = await window.electronAPI.getTerminalProcessTree(targetId);
        return { ok: true, data: { id: targetId, processes: tree } };
      } catch (err) {
        return { ok: false, error: 'tree_failed', data: { id: targetId, message: (err as Error).message } };
      }
    }
    case 'send': {
      const text = rest.join(' ');
      window.electronAPI.sendData(targetId, `${text}\n`);
      return { ok: true, data: { id: targetId, sent: text } };
    }
    case 'type': {
      const text = rest.join(' ');
      if (!text) return { ok: false, error: 'missing_text', data: { message: 'usage: type <id> <text...>' } };
      window.electronAPI.sendData(targetId, text);
      return { ok: true, data: { id: targetId, typed: text } };
    }
    case 'key': {
      const name = rest[0];
      if (!name) return { ok: false, error: 'missing_key', data: { message: 'usage: key <id> <name>  e.g. key <id> ctrl-c' } };
      const bytes = toKeyBytes(name);
      if (bytes == null) return { ok: false, error: 'unknown_key', data: { message: `unknown key: ${name}` } };
      window.electronAPI.sendData(targetId, bytes);
      return { ok: true, data: { id: targetId, key: name.toLowerCase() } };
    }
    case 'close': {
      // Kill the session, then remove its pane from the workspace.
      const container = siblings.find((t) => t.id === targetId)?.container;
      try { await deps.closeSession(targetId); } catch { /* may already be gone */ }
      if (container) deps.removeContainer(container.id);
      return { ok: true, data: { id: targetId, closed: true, mine: targetId === terminal } };
    }
    default:
      return { ok: false, error: 'unknown_command', data: { message: `unknown command: ${cmd}` } };
  }
}
