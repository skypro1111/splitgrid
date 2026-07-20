import { clipboard, webContents } from 'electron';
import { writeFileSync } from 'node:fs';

// ─── Agent browser: main-process control surface ─────────────────────────────
// Commands that must run in MAIN (not as injected page JS) because they need
// Electron webContents/session APIs: real keystrokes (sendInputEvent), PDF
// export (printToPDF), clipboard, cookies (session), viewport emulation
// (enableDeviceEmulation), and full-page screenshots (CDP captureBeyondViewport).
// The renderer resolves the target pane and hands back its GUEST webContents id;
// these helpers act on that id. Mirrors the network module's split (CDP in main).

function liveWc(wcId: number): Electron.WebContents {
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) throw new Error('browser_not_ready');
  return wc;
}

// Electron accelerator-style modifier names for sendInputEvent.
const MODS: Record<string, string> = {
  ctrl: 'control', control: 'control', cmd: 'meta', command: 'meta', meta: 'meta',
  alt: 'alt', option: 'alt', shift: 'shift',
};

// Printable single chars also need a `char` event so the page receives input.
function isPrintable(key: string): boolean {
  return key.length === 1;
}

/**
 * Send a real key press to the guest page. `key` may be a combo like
 * "Control+a" / "cmd+Enter"; the last token is the key, the rest are modifiers.
 * Dispatches keyDown (+ char for printables) + keyUp via the native input
 * pipeline, so it triggers default actions (form submit on Enter, etc.) that
 * synthetic DOM events miss.
 */
export function sendKey(wcId: number, combo: string): Record<string, unknown> {
  const wc = liveWc(wcId);
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  if (!key) return { ok: false, error: 'missing_key' };
  const modifiers = parts.map((p) => MODS[p.toLowerCase()]).filter(Boolean) as string[];
  try {
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: modifiers as never });
    if (isPrintable(key) && modifiers.every((m) => m === 'shift')) {
      wc.sendInputEvent({ type: 'char', keyCode: key, modifiers: modifiers as never });
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: modifiers as never });
    return { ok: true, pressed: key, modifiers };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Export the current page to a PDF file (writes to `file`, returns the path). */
export async function printPdf(wcId: number, file: string): Promise<Record<string, unknown>> {
  const wc = liveWc(wcId);
  const data = await wc.printToPDF({ printBackground: true });
  writeFileSync(file, data);
  return { ok: true, pdf: file };
}

/** Read or write the system clipboard (text). */
export function clipboardOp(op: string, text?: string): Record<string, unknown> {
  if (op === 'write') {
    clipboard.writeText(text ?? '');
    return { ok: true, wrote: true };
  }
  return { ok: true, text: clipboard.readText() };
}

/**
 * Emulate a viewport size on the guest pane (enableDeviceEmulation), or reset to
 * the real pane size. Note: this is device-size emulation, not a window resize.
 */
export function setViewport(wcId: number, width?: number, height?: number, reset = false): Record<string, unknown> {
  const wc = liveWc(wcId);
  if (reset || !width || !height) {
    wc.disableDeviceEmulation();
    return { ok: true, viewport: 'reset' };
  }
  wc.enableDeviceEmulation({
    screenPosition: 'desktop',
    screenSize: { width, height },
    viewSize: { width, height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 0,
    scale: 1,
  } as never);
  return { ok: true, viewport: { width, height } };
}

/** List or clear cookies in the pane's session (shared across same-partition panes). */
export async function handleCookies(op: string, wcId: number): Promise<Record<string, unknown>> {
  const wc = liveWc(wcId);
  const ses = wc.session;
  if (op === 'clear') {
    await ses.clearStorageData({ storages: ['cookies'] });
    return { ok: true, cleared: true };
  }
  // list — for the current page URL when available, else the whole session.
  let url = '';
  try { url = wc.getURL(); } catch { /* not ready */ }
  const cookies = url && /^https?:/.test(url)
    ? await ses.cookies.get({ url })
    : await ses.cookies.get({});
  return {
    ok: true,
    count: cookies.length,
    cookies: cookies.slice(0, 200).map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate,
    })),
  };
}

/**
 * Full-page screenshot via CDP (captureBeyondViewport), which the renderer's
 * capturePage() can't do (viewport only). Attaches a transient debugger, so it
 * fails with `debugger_busy` if network capture (or devtools) already holds it —
 * the caller falls back to a viewport capture in that case. Returns a PNG buffer.
 */
export async function captureFullPage(wcId: number): Promise<Buffer> {
  const wc = liveWc(wcId);
  if (wc.debugger.isAttached()) throw new Error('debugger_busy');
  wc.debugger.attach('1.3');
  try {
    await wc.debugger.sendCommand('Page.enable');
    const metrics = (await wc.debugger.sendCommand('Page.getLayoutMetrics')) as {
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    };
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const clip = size
      ? { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
      : undefined;
    const shot = (await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      ...(clip ? { clip } : {}),
    })) as { data: string };
    return Buffer.from(shot.data, 'base64');
  } finally {
    try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* gone */ }
  }
}
