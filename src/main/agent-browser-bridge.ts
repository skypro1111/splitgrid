import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerResponse } from 'node:http';
import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { webviewFocusPreloadPath } from './agent-hooks/paths';
import { handleNetworkOp } from './agent-browser-network';
import { sendKey, printPdf, clipboardOp, setViewport, handleCookies, captureFullPage } from './agent-browser-extra';

// ─── Agent browser bridge ────────────────────────────────────────────────────
// An agent running inside a splitgrid terminal drives its embedded <webview>
// browser pane through the bundled `splitgrid-browser` helper, which POSTs to
// /browser on the same local server as the activity hooks (:19558). This bridge
// is a thin relay: it validates a per-run token, correlates the request with a
// reqId, forwards the command to the renderer (single source of truth for which
// browsers exist + the live webviews), and writes the renderer's reply back as
// the HTTP response. Screenshots come back as base64 and are spilled to a temp
// PNG so the agent gets a path it can read.

// Per-app-run secret, injected into the terminal env as $SPLITGRID_BROWSER_TOKEN.
// `eval` runs arbitrary JS in a page on an external request, so every /browser
// call must carry this token.
export const BROWSER_TOKEN = randomBytes(24).toString('hex');

const REQUEST_TIMEOUT_MS = 35_000;

interface Pending {
  resolve: (result: BridgeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BridgeResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

const pendingById = new Map<string, Pending>();
let reqCounter = 0;
let started = false;

function screenshotDir(): string {
  return path.join(app.getPath('temp'), 'splitgrid-browser');
}

// Fresh screenshot scratch dir each run — these are ephemeral verification
// artifacts, no reason to keep them across launches.
function resetScreenshotDir(): void {
  const dir = screenshotDir();
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[browser-bridge] screenshot dir reset failed:', (err as Error).message);
  }
}

// Cap the scratch dir so a long session of screenshots doesn't grow unbounded.
function pruneScreenshots(cap = 50): void {
  const dir = screenshotDir();
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => path.join(dir, f));
    if (files.length <= cap) return;
    // readdir order is stable enough; drop the lexicographically-lowest (oldest
    // reqId counter) until under cap.
    files.sort();
    for (const f of files.slice(0, files.length - cap)) {
      try { rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  } catch { /* dir may not exist yet */ }
}

// Resolve which window OWNS a given terminal (its creating window's webContents
// id). Injected by ipc-handlers from the shared sessionOwner map. We route a
// /browser command to the window that holds the CALLING terminal — not just the
// focused one — so an agent driving its browser pane targets ITS window even
// when another window is focused (multi-window setups).
let ownerResolver: ((terminalId: string) => number | undefined) | null = null;
export function setBrowserOwnerResolver(fn: (terminalId: string) => number | undefined): void {
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

export function startBrowserBridge(): void {
  if (started) return;
  started = true;
  resetScreenshotDir();

  // Synchronous so the renderer can read it at preload load and set a webview's
  // `preload` attribute before the guest attaches.
  ipcMain.on('browser:webview-preload-url', (e) => {
    e.returnValue = pathToFileURL(webviewFocusPreloadPath()).toString();
  });

  // Renderer replies here once it has resolved the target + run the command.
  ipcMain.on('browser:result', (_e, payload: { reqId?: string; ok?: boolean; data?: Record<string, unknown>; error?: string }) => {
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
 * Run one agent browser command: forward the argv to the renderer (which owns the
 * webviews), await the reqId-correlated reply, then post-process screenshots
 * (base64 → temp PNG path) and network ops (CDP in main). Returns the resolved
 * result. Transport-agnostic — used by both the HTTP endpoint and the WSL file
 * bridge. The caller is responsible for token validation.
 */
export async function processBrowserCommand(terminal: string, argv: string[]): Promise<BridgeResult> {
  if (argv.length === 0) {
    return { ok: false, error: 'empty_command', data: { message: 'usage: splitgrid-browser <cmd> [args]' } };
  }

  // Prefer the window that owns the calling terminal (so its workspace resolves
  // regardless of focus / multi-window); fall back to the focused/any window when
  // the owner is unknown (e.g. a terminal spawned before integrations).
  const win = ownerWindow(terminal) ?? targetWindow();
  if (!win) return { ok: false, error: 'no_window' };

  const reqId = `r${++reqCounter}`;
  const result = await new Promise<BridgeResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingById.delete(reqId);
      resolve({ ok: false, error: 'timeout' });
    }, REQUEST_TIMEOUT_MS);
    pendingById.set(reqId, { resolve, timer });
    win.webContents.send('browser:command', { reqId, terminal, argv });
  });

  // Network capture runs in main (CDP debugger lives on the main-process
  // webContents). The renderer resolves the target pane and hands back its guest
  // webContents id + the requested sub-op.
  if (result.ok && result.data && typeof result.data.networkOp === 'string') {
    const { networkOp, netWebContentsId, ...rest } = result.data;
    try {
      const netData = handleNetworkOp(networkOp as string, netWebContentsId as number);
      result.data = { ...rest, ...netData };
      result.ok = netData.ok !== false;
    } catch (err) {
      result.data = { ...rest, error: (err as Error).message };
      result.ok = false;
    }
  }

  // Real keystroke (press) via sendInputEvent — needs the native input pipeline.
  if (result.ok && result.data && typeof result.data.inputWebContentsId === 'number') {
    const { inputWebContentsId, inputKey, ...rest } = result.data;
    result.data = { ...rest, ...sendKey(inputWebContentsId as number, String(inputKey ?? '')) };
    result.ok = result.data.ok !== false;
  }

  // Viewport emulation (set device size / reset).
  if (result.ok && result.data && typeof result.data.viewportWebContentsId === 'number') {
    const { viewportWebContentsId, viewportWidth, viewportHeight, viewportReset, ...rest } = result.data;
    try {
      result.data = { ...rest, ...setViewport(viewportWebContentsId as number, viewportWidth as number, viewportHeight as number, !!viewportReset) };
    } catch (err) { result.data = { ...rest, error: (err as Error).message }; result.ok = false; }
  }

  // Cookies (list / clear) on the pane's session.
  if (result.ok && result.data && typeof result.data.cookieWebContentsId === 'number') {
    const { cookieWebContentsId, cookieOp, ...rest } = result.data;
    try {
      result.data = { ...rest, ...(await handleCookies(String(cookieOp ?? 'list'), cookieWebContentsId as number)) };
    } catch (err) { result.data = { ...rest, error: (err as Error).message }; result.ok = false; }
  }

  // PDF export.
  if (result.ok && result.data && typeof result.data.pdfWebContentsId === 'number') {
    const { pdfWebContentsId, ...rest } = result.data;
    try {
      const dir = screenshotDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${reqId}.pdf`);
      result.data = { ...rest, ...(await printPdf(pdfWebContentsId as number, file)) };
    } catch (err) { result.data = { ...rest, error: (err as Error).message }; result.ok = false; }
  }

  // Clipboard (read / write) — no webContents needed.
  if (result.ok && result.data && typeof result.data.clipboardOp === 'string') {
    const { clipboardOp: cop, clipboardText, ...rest } = result.data;
    result.data = { ...rest, ...clipboardOp(cop as string, clipboardText as string | undefined) };
  }

  // Capture a screenshot in the main process from the guest webContents id, then
  // spill it to a temp PNG and hand back the path. capturePage() here (main) is
  // robust, unlike <webview>.capturePage() in the renderer. `fullPage` uses CDP
  // (captureBeyondViewport); if the debugger is busy it falls back to viewport.
  if (result.ok && result.data && typeof result.data.captureWebContentsId === 'number') {
    const { captureWebContentsId, fullPage, ...rest } = result.data;
    try {
      const wc = webContents.fromId(captureWebContentsId as number);
      if (!wc || wc.isDestroyed()) {
        result.data = { ...rest, error: 'browser_not_ready' };
        result.ok = false;
      } else {
        let png: Buffer;
        let captured: 'full' | 'viewport' = 'viewport';
        if (fullPage) {
          try { png = await captureFullPage(captureWebContentsId as number); captured = 'full'; }
          catch { png = (await wc.capturePage()).toPNG(); } // debugger busy → viewport
        } else {
          png = (await wc.capturePage()).toPNG();
        }
        const dir = screenshotDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${reqId}.png`);
        writeFileSync(file, png);
        result.data = { ...rest, screenshot: file, ...(fullPage ? { captured } : {}) };
        pruneScreenshots();
      }
    } catch (err) {
      result.data = { ...rest, screenshotError: (err as Error).message };
      result.ok = false;
    }
  }

  return result;
}

// Flatten a BridgeResult into the wire shape agents consume: { ok, ...data, error? }.
export function flattenBridgeResult(r: BridgeResult): Record<string, unknown> {
  return { ok: r.ok, ...(r.data ?? {}), ...(r.error ? { error: r.error } : {}) };
}

/**
 * Handle a POST /browser request. Validates the token, then runs the command and
 * writes the resolved JSON result.
 */
export async function handleBrowserRequest(raw: Buffer, res: ServerResponse): Promise<void> {
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

  const result = await processBrowserCommand(terminal, argv);
  reply(200, flattenBridgeResult(result));
}
