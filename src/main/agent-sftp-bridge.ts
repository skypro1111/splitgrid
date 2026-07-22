import type { ServerResponse } from 'node:http';
import { BrowserWindow, ipcMain, webContents } from 'electron';
import { BROWSER_TOKEN } from './agent-browser-bridge';
import { isAgentSftpControlEnabled, isAgentSftpWriteEnabled } from './local-shell-manager';

// ─── Agent SFTP bridge ───────────────────────────────────────────────────────
// An agent running inside a splitgrid terminal can move files between the machine
// and the workspace's remote hosts through the bundled `splitgrid-sftp` helper,
// which POSTs to /sftp on the same local server as the browser + terminal + SQL
// bridges (:19558). Without this an agent has no path to SFTP at all — the SSH
// credentials live encrypted in main and never reach the shell — which is why
// agents resorted to base64-ing files through an SSH pane or standing up an
// HTTP server to move a file.
//
// Like the terminal and SQL bridges this is a thin relay: validate the per-run
// token, correlate on a reqId, forward the argv to the renderer. The renderer
// owns the layout (which workspace the caller sits in), the workspace's sync
// config and the SSH panes, so target resolution and path confinement live
// there — see useSftpAgentBridge.
//
// Reuses BROWSER_TOKEN as the shared per-run agent secret (injected as
// $SPLITGRID_SFTP_TOKEN): writing files to a remote host is privileged, so every
// /sftp call must carry it.

// Transfers are slower than a query or a keystroke: a multi-file push over a
// slow link routinely outlives the 35s the other bridges allow.
const REQUEST_TIMEOUT_MS = 180_000;

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
// id). Injected by ipc-handlers from the existing sessionOwner map. We use it to
// route a /sftp command to the window that holds the CALLING terminal — not just
// the focused one — so a transfer started from a background window still
// resolves that window's workspace (and therefore its sync targets).
let ownerResolver: ((terminalId: string) => number | undefined) | null = null;
export function setSftpOwnerResolver(fn: (terminalId: string) => number | undefined): void {
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

export function startSftpBridge(): void {
  if (started) return;
  started = true;

  // Renderer replies here once it has resolved the caller's workspace + run the
  // transfer against the live SFTP sessions.
  ipcMain.on('sftp-agent:result', (_e, payload: { reqId?: string; ok?: boolean; data?: Record<string, unknown>; error?: string }) => {
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
 * Run one agent SFTP command: forward the argv to the renderer (which owns the
 * workspace layout, its sync targets and the SSH panes), await the reqId-
 * correlated reply, and return it. Transport-agnostic — used by both the HTTP
 * endpoint and the WSL file bridge. The caller validates the token.
 */
export async function processSftpCommand(terminal: string, argv: string[]): Promise<BridgeResult> {
  // Hard gate, authoritative in main: the /sftp endpoint reuses the SHARED agent
  // token, so an agent with only browser/terminal control still holds it and
  // could POST here. We refuse without forwarding, so the renderer never even
  // sees the command. Mirrors the terminal + SQL bridges.
  if (!isAgentSftpControlEnabled()) {
    return { ok: false, error: 'sftp_disabled', data: { message: 'SFTP agent access is disabled. Ask the user to enable it in Settings → Agent integrations.' } };
  }
  if (argv.length === 0) {
    return { ok: false, error: 'empty_command', data: { message: 'usage: splitgrid-sftp <cmd> [args]' } };
  }

  const win = ownerWindow(terminal) ?? targetWindow();
  if (!win) return { ok: false, error: 'no_window' };

  const reqId = `f${++reqCounter}`;
  return new Promise<BridgeResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingById.delete(reqId);
      resolve({ ok: false, error: 'timeout' });
    }, REQUEST_TIMEOUT_MS);
    pendingById.set(reqId, { resolve, timer });
    // `writeAllowed` is read from main on EVERY command and shipped with the
    // payload. The renderer classifies commands (it knows which ones mutate a
    // remote) but can never self-grant write — the authoritative value always
    // originates here, so the write gate stays enforced in main.
    win.webContents.send('sftp-agent:command', { reqId, terminal, argv, writeAllowed: isAgentSftpWriteEnabled() });
  });
}

// Flatten a BridgeResult into the wire shape agents consume: { ok, ...data, error? }.
export function flattenSftpResult(r: BridgeResult): Record<string, unknown> {
  return { ok: r.ok, ...(r.data ?? {}), ...(r.error ? { error: r.error } : {}) };
}

/**
 * Handle a POST /sftp request. Validates the token, then runs the command and
 * writes the resolved JSON result.
 */
export async function handleSftpRequest(raw: Buffer, res: ServerResponse): Promise<void> {
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

  const result = await processSftpCommand(terminal, argv);
  reply(200, flattenSftpResult(result));
}
