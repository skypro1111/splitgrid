import type { ServerResponse } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserWindow, ipcMain, webContents } from 'electron';
import { BROWSER_TOKEN } from './agent-browser-bridge';
import { isAgentSqlControlEnabled, isAgentSqlWriteEnabled } from './local-shell-manager';

// ─── Agent SQL bridge ────────────────────────────────────────────────────────
// An agent running inside a splitgrid terminal can run queries, inspect schema and
// export results against the workspace's SQL component through the bundled
// `splitgrid-sql` helper, which POSTs to /sql on the same local server as the
// browser + terminal bridges + activity hooks (:19558). This bridge is a thin
// relay: it validates the per-run token, correlates the request with a reqId, and
// forwards the command to the renderer. The renderer is the single source of truth
// for which SQL connections exist (the SQL workbench lives there), so — like the
// terminal bridge — there is no post-processing here: we just round-trip the argv
// and write the renderer's reply back as the HTTP response.
//
// Reuses BROWSER_TOKEN as the shared per-run agent secret (injected into the env
// as $SPLITGRID_SQL_TOKEN): running arbitrary SQL is privileged, so every /sql
// call must carry it.

const REQUEST_TIMEOUT_MS = 35_000;

interface BridgeResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface Pending {
  resolve: (result: BridgeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingById = new Map<string, Pending>();
let reqCounter = 0;
let started = false;

// Resolve which window OWNS a given terminal (its creating window's webContents
// id). Injected by ipc-handlers from the existing sessionOwner map, which is
// already maintained on terminal create/close + window close. We use it to route
// a /sql command to the window that holds the CALLING terminal — not just the
// focused one — so cross-window setups (a terminal driving its SQL pane while
// another window is focused) resolve their workspace correctly.
let ownerResolver: ((terminalId: string) => number | undefined) | null = null;
export function setSqlOwnerResolver(fn: (terminalId: string) => number | undefined): void {
  ownerResolver = fn;
}

// The window that owns `terminal` (per the resolver), if it's still alive.
function ownerWindow(terminal: string): BrowserWindow | null {
  const wcId = terminal ? ownerResolver?.(terminal) : undefined;
  if (wcId == null) return null;
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(wc);
  return win && !win.isDestroyed() ? win : null;
}

function targetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
}

// Capture the whole owning window (all panes in their real layout) to a PNG and
// return the path. Handled entirely in main — capturePage() is a main-side
// webContents capability, so this never round-trips to the renderer. Read-only
// (no DB access), so it's allowed whenever SQL control is on. Used for UI work:
// `splitgrid-sql screenshot [path]` so the SQL panel can be reviewed visually.
async function captureWindow(win: BrowserWindow, target?: string): Promise<BridgeResult> {
  try {
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    let file = target && target.trim() ? target.trim() : '';
    if (!file) {
      const dir = path.join(os.tmpdir(), 'splitgrid-sql-shots');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      file = path.join(dir, `shot-${reqCounter}-${Date.now()}.png`);
    } else {
      if (!path.isAbsolute(file)) file = path.resolve(file);
      const dir = path.dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    writeFileSync(file, png);
    const size = img.getSize();
    return { ok: true, data: { command: 'screenshot', path: file, width: size.width, height: size.height, bytes: png.length } };
  } catch (err) {
    return { ok: false, error: 'screenshot_failed', data: { message: (err as Error).message } };
  }
}

export function startSqlBridge(): void {
  if (started) return;
  started = true;

  // Renderer replies here once it has resolved the caller's workspace + run the
  // command against the live SQL connections.
  ipcMain.on('sql:result', (_e, payload: { reqId?: string; ok?: boolean; data?: Record<string, unknown>; error?: string }) => {
    const reqId = payload?.reqId;
    if (!reqId) return;
    const pending = pendingById.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingById.delete(reqId);
    pending.resolve({ ok: !!payload.ok, data: payload.data, error: payload.error });
  });
}

/**
 * Run one agent SQL command: forward the argv to the renderer (which owns the SQL
 * workbench + connections), await the reqId-correlated reply, and return it.
 * Transport-agnostic — used by both the HTTP endpoint and the WSL file bridge.
 * The caller is responsible for token validation.
 */
export async function processSqlCommand(terminal: string, argv: string[]): Promise<BridgeResult> {
  // Hard gate: refuse all SQL commands unless the user opted into SQL control.
  // The /sql endpoint reuses the SHARED agent token, so an agent that only has
  // browser/terminal control still holds it and could POST here — env-injection
  // gating alone is not enough. We refuse WITHOUT forwarding to the renderer (the
  // renderer never even sees the command), authoritative in main. Covers both
  // transports (HTTP /sql + the WSL file bridge) since both funnel through here.
  // Mirrors the terminal bridge's terminalControlEnabled hard-refuse.
  if (!isAgentSqlControlEnabled()) {
    return { ok: false, error: 'sql_disabled', data: { message: 'SQL agent access is disabled. Ask the user to enable it in Settings → Agent integrations.' } };
  }
  if (argv.length === 0) {
    return { ok: false, error: 'empty_command', data: { message: 'usage: splitgrid-sql <cmd> [args]' } };
  }

  // Prefer the window that owns the calling terminal (so its workspace resolves
  // regardless of focus / multi-window); fall back to the focused/any window
  // when the owner is unknown (e.g. a terminal spawned before integrations).
  const win = ownerWindow(terminal) ?? targetWindow();
  if (!win) return { ok: false, error: 'no_window' };

  // `screenshot [path]` — captured in main from the owning window; no renderer
  // round-trip needed. Lets the SQL UI be reviewed visually during dev/polish.
  if (argv[0] === 'screenshot') return captureWindow(win, argv[1]);

  const reqId = `s${++reqCounter}`;
  return new Promise<BridgeResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingById.delete(reqId);
      resolve({ ok: false, error: 'timeout' });
    }, REQUEST_TIMEOUT_MS);
    pendingById.set(reqId, { resolve, timer });
    // `writeAllowed` is read from main on EVERY command and shipped to the
    // renderer in the payload. The renderer classifies statements (it owns the
    // tokenizer) but cannot self-grant write — the authoritative value always
    // originates here. So the WRITE gate stays authoritative in main even though
    // the classification lives in the renderer.
    win.webContents.send('sql:command', { reqId, terminal, argv, writeAllowed: isAgentSqlWriteEnabled() });
  });
}

// Flatten a BridgeResult into the wire shape agents consume: { ok, ...data, error? }.
export function flattenSqlResult(r: BridgeResult): Record<string, unknown> {
  return { ok: r.ok, ...(r.data ?? {}), ...(r.error ? { error: r.error } : {}) };
}

/**
 * Handle a POST /sql request. Validates the token, then runs the command and
 * writes the resolved JSON result.
 */
export async function handleSqlRequest(raw: Buffer, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  let parsed: { terminal?: unknown; token?: unknown; argv?: unknown };
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    reply(400, { ok: false, error: 'invalid_json' });
    return;
  }

  if (parsed.token !== BROWSER_TOKEN) {
    reply(403, { ok: false, error: 'unauthorized' });
    return;
  }
  const terminal = typeof parsed.terminal === 'string' ? parsed.terminal : '';
  const argv = Array.isArray(parsed.argv) ? parsed.argv.filter((a): a is string => typeof a === 'string') : [];

  const result = await processSqlCommand(terminal, argv);
  reply(200, flattenSqlResult(result));
}
