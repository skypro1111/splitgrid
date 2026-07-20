import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Smoke E2E: launch the REAL app (dev electron on the forge-vite build — a
// packaged binary is fused RunAsNode:false and can't be driven) against a throw-
// away userData dir (so it never collides with a running instance's single-
// instance lock). Catches catastrophic boot/IPC/preload breakage that the unit
// suite can't see. Run with `npm run test:e2e`.

let app: ElectronApplication;
let window: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'splitgrid-e2e-'));
  app = await electron.launch({
    args: [path.join('.vite', 'build', 'main.js'), `--user-data-dir=${userDataDir}`],
    timeout: 45_000,
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close().catch(() => { /* already gone */ });
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('the main process boots and exposes a window', async () => {
  expect(window).toBeTruthy();
  expect(await window.title()).toMatch(/splitgrid/i);
});

test('the renderer mounts (React content is present, no white screen)', async () => {
  await expect
    .poll(() => window.evaluate(() => document.body?.childElementCount ?? 0), { timeout: 20_000 })
    .toBeGreaterThan(0);
});

test('the preload bridge is wired (window.electronAPI is exposed)', async () => {
  const apiShape = await window.evaluate(() => {
    const api = (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI;
    return api ? { hasPlatform: typeof api.platform === 'string', hasCreateSession: typeof api.createSession === 'function' } : null;
  });
  expect(apiShape).not.toBeNull();
  expect(apiShape!.hasPlatform).toBe(true);
  expect(apiShape!.hasCreateSession).toBe(true);
});

test('a local terminal spawns and the PTY echoes back (full IPC round-trip)', async () => {
  // Drive the real round-trip through the preload IPC directly (renderer → main →
  // node-pty → shell → back), independent of how xterm renders — which is what we
  // actually want to know works: PTY spawn + bidirectional terminal IPC.
  const got = await window.evaluate(
    (marker) =>
      new Promise<string>((resolve, reject) => {
        const api = (window as unknown as {
          electronAPI: {
            onData(cb: (sid: string, data: string) => void): () => void;
            createLocalTerminal(config?: unknown): Promise<{ id: string }>;
            sendData(id: string, data: string): void;
          };
        }).electronAPI;
        let buf = '';
        const off = api.onData((_sid, data) => {
          buf += data;
          if (buf.includes(marker)) { off(); resolve(buf); }
        });
        const timer = setTimeout(() => { off(); reject(new Error('no echo; tail=' + buf.slice(-200))); }, 25_000);
        api
          .createLocalTerminal()
          .then((info) => {
            // Let the shell print its prompt, then run a command that emits the marker.
            setTimeout(() => api.sendData(info.id, `echo ${marker}\n`), 1_200);
          })
          .catch((e: Error) => { clearTimeout(timer); off(); reject(e); });
      }),
    'SPLITGRID_E2E_MARKER',
  );
  expect(got).toContain('SPLITGRID_E2E_MARKER');
});

test('⌘/Ctrl+K toggles the Fast chat palette regardless of which inner element is focused', async () => {
  // The crux of the always-on hotkey: the keystroke is intercepted in the MAIN
  // process (before-input-event) and forwarded over IPC, so it fires no matter
  // which inner surface holds focus.
  //
  // We inject the key via webContents.sendInputEvent rather than
  // page.keyboard.press: Playwright's CDP-injected keys do NOT trigger Electron's
  // before-input-event (verified), whereas sendInputEvent travels the same path a
  // real OS keystroke does — i.e. it actually exercises the production handler.
  const isMac = process.platform === 'darwin';

  // Move focus onto a real inner element first (not the document default).
  await window.evaluate(() => {
    document.querySelector<HTMLElement>('button, [tabindex], input, textarea')?.focus();
  });

  const paletteVisible = () =>
    window.evaluate(() =>
      // Not-configured palette renders this hint; configured renders the
      // "Ask anything…" textarea placeholder. Either means it's open.
      !!document.querySelector('textarea[placeholder*="Fast chat is not configured"]') ||
      document.body.innerText.includes('Set an OpenAI-compatible endpoint') ||
      !!document.querySelector('textarea[placeholder*="Ask anything"]'),
    );

  const pressHotkey = () =>
    app.evaluate(({ BrowserWindow }, mac) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const modifiers = (mac ? ['meta'] : ['control']) as unknown as ('meta' | 'control')[];
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'k', modifiers });
    }, isMac);

  expect(await paletteVisible()).toBe(false);
  await pressHotkey();
  await expect.poll(paletteVisible, { timeout: 5_000 }).toBe(true);
  // Toggle closes it again.
  await pressHotkey();
  await expect.poll(paletteVisible, { timeout: 5_000 }).toBe(false);
});

test('a custom hotkey saved in settings is honoured (toggles the palette)', async () => {
  const isMac = process.platform === 'darwin';
  const paletteVisible = () =>
    window.evaluate(() =>
      !!document.querySelector('textarea[placeholder*="Fast chat is not configured"]') ||
      document.body.innerText.includes('Set an OpenAI-compatible endpoint'));

  // Rebind to <mod>+J and let the save propagate to the main-process matcher.
  await window.evaluate(async (mac) => {
    const api = (window as unknown as { electronAPI: {
      getAppSettings(): Promise<Record<string, unknown>>;
      saveAppSettings(s: Record<string, unknown>): Promise<void>;
    } }).electronAPI;
    const cur = await api.getAppSettings();
    await api.saveAppSettings({ ...cur, quickChatHotkey: mac ? { key: 'j', meta: true } : { key: 'j', control: true } });
  }, isMac);

  expect(await paletteVisible()).toBe(false);
  await app.evaluate(({ BrowserWindow }, mac) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const modifiers = (mac ? ['meta'] : ['control']) as unknown as ('meta' | 'control')[];
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'j', modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'j', modifiers });
  }, isMac);
  await expect.poll(paletteVisible, { timeout: 5_000 }).toBe(true);
});

test('chat history persists across the IPC store and respects the limit', async () => {
  const list = await window.evaluate(async () => {
    const api = (window as unknown as { electronAPI: {
      getAppSettings(): Promise<Record<string, unknown>>;
      saveAppSettings(s: Record<string, unknown>): Promise<void>;
      quickChatHistoryClear(): Promise<void>;
      quickChatHistorySave(c: { id: string; messages: { role: string; content: string }[] }): Promise<void>;
      quickChatHistoryList(): Promise<{ id: string; title: string }[]>;
    } }).electronAPI;
    const cur = await api.getAppSettings();
    await api.saveAppSettings({ ...cur, quickChatHistoryLimit: 2 });
    await api.quickChatHistoryClear();
    await api.quickChatHistorySave({ id: 'c1', messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'a1' }] });
    await api.quickChatHistorySave({ id: 'c2', messages: [{ role: 'user', content: 'second' }, { role: 'assistant', content: 'a2' }] });
    await api.quickChatHistorySave({ id: 'c3', messages: [{ role: 'user', content: 'third' }, { role: 'assistant', content: 'a3' }] });
    return api.quickChatHistoryList();
  });
  // Newest-first, capped at 2; title derived from the first user message.
  expect(list.map((c) => c.id)).toEqual(['c3', 'c2']);
  expect(list[0].title).toBe('third');
});
