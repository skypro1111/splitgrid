import type { ServerResponse } from 'node:http';
import { BrowserWindow, ipcMain, webContents } from 'electron';
import { BROWSER_TOKEN } from './agent-browser-bridge';

// ─── Agent terminal bridge ───────────────────────────────────────────────────
// An agent running inside a splitgrid terminal can inspect and drive the OTHER
// terminals in its workspace through the bundled `splitgrid-terminal` helper, which
// POSTs to /terminal on the same local server as the browser bridge + activity
// hooks (:19558). This bridge is a thin relay: it validates the per-run token,
// correlates the request with a reqId, and forwards the command to the renderer.
// The renderer is the single source of truth for which terminals belong to which
// workspace (the layout lives there) and already owns the terminal I/O surface
// (sendData / getSessionBuffer / getProcessTree via electronAPI), so — unlike the
// browser bridge — there is no post-processing here: we just round-trip the argv
// and write the renderer's reply back as the HTTP response.
//
// Reuses BROWSER_TOKEN as the shared per-run agent secret (injected into the env
// as $SPLITGRID_TERMINAL_TOKEN): writing to another terminal runs arbitrary commands
// in that shell, so every /terminal call must carry it.

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

// Cross-terminal control sub-opt-in (agentTerminalControl). The /terminal route
// is wired unconditionally and the shared BROWSER_TOKEN authorizes it, so the
// token alone is NOT enough to honour the user's choice: when they enable browser
// control but leave terminal control OFF, the agent still holds the token. This
// flag is the real gate — driving sibling terminals is RCE-equivalent, so every
// command is refused unless terminal control is explicitly on. Mirrors the env-
// injection gate in local-shell-manager; set together from agent-integrations.
let terminalControlEnabled = false;
export function setTerminalControlEnabled(enabled: boolean): void {
  terminalControlEnabled = enabled;
}

// Resolve which window OWNS a given terminal (its creating window's webContents
// id). Injected by ipc-handlers from the existing sessionOwner map, which is
// already maintained on terminal create/close + window close. We use it to route
// a /terminal command to the window that holds the CALLING terminal — not just
// the focused one — so cross-window setups (a terminal driving siblings while
// another window is focused) resolve their workspace correctly.
let ownerResolver: ((terminalId: string) => number | undefined) | null = null;
export function setTerminalOwnerResolver(fn: (terminalId: string) => number | undefined): void {
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

export function startTerminalBridge(): void {
  if (started) return;
  started = true;

  // Renderer replies here once it has resolved the caller's workspace + run the
  // command against the live terminal sessions.
  ipcMain.on('terminal-agent:result', (_e, payload: { reqId?: string; ok?: boolean; data?: Record<string, unknown>; error?: string }) => {
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
 * Run one agent terminal command: forward the argv to the renderer (which owns
 * the layout + terminal I/O), await the reqId-correlated reply, and return it.
 * Transport-agnostic — used by both the HTTP endpoint and the WSL file bridge.
 * The caller is responsible for token validation.
 */
export async function processTerminalCommand(terminal: string, argv: string[]): Promise<BridgeResult> {
  // Hard gate: refuse all cross-terminal commands unless the user opted into
  // terminal control — not just browser control. Covers both transports (HTTP
  // /terminal and the WSL file bridge) since both funnel through here.
  if (!terminalControlEnabled) {
    return { ok: false, error: 'terminal_control_disabled', data: { message: 'Cross-terminal control is disabled. Enable it in Settings → Agent integrations.' } };
  }
  if (argv.length === 0) {
    return { ok: false, error: 'empty_command', data: { message: 'usage: splitgrid-terminal <cmd> [args]' } };
  }

  // Prefer the window that owns the calling terminal (so its workspace resolves
  // regardless of focus / multi-window); fall back to the focused/any window
  // when the owner is unknown (e.g. a terminal spawned before integrations).
  const win = ownerWindow(terminal) ?? targetWindow();
  if (!win) return { ok: false, error: 'no_window' };

  const reqId = `t${++reqCounter}`;
  return new Promise<BridgeResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingById.delete(reqId);
      resolve({ ok: false, error: 'timeout' });
    }, REQUEST_TIMEOUT_MS);
    pendingById.set(reqId, { resolve, timer });
    win.webContents.send('terminal-agent:command', { reqId, terminal, argv });
  });
}

// Flatten a BridgeResult into the wire shape agents consume: { ok, ...data, error? }.
export function flattenTerminalResult(r: BridgeResult): Record<string, unknown> {
  return { ok: r.ok, ...(r.data ?? {}), ...(r.error ? { error: r.error } : {}) };
}

/**
 * Handle a POST /terminal request. Validates the token, then runs the command
 * and writes the resolved JSON result.
 */
export async function handleTerminalRequest(raw: Buffer, res: ServerResponse): Promise<void> {
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

  const result = await processTerminalCommand(terminal, argv);
  reply(200, flattenTerminalResult(result));
}
