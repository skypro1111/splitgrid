import { describe, it, expect, beforeEach, vi } from 'vitest';

// Routing seam: a `--target tab:…` surface must be handled against the browser
// extension in MAIN and never reach the renderer round-trip (which is what would
// hang a command against a pane that doesn't exist). These tests pin that the
// tab path short-circuits BEFORE any window is resolved, and that a pane command
// still takes the old path.
//
// Electron is mocked so the main-side module loads under node; the extension
// channel keeps its stub behaviour (no extension connected).

const win = vi.hoisted(() => ({
  getFocusedWindow: vi.fn(() => null),
  getAllWindows: vi.fn(() => []),
  fromWebContents: vi.fn(() => null),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: win.getFocusedWindow,
    getAllWindows: win.getAllWindows,
    fromWebContents: win.fromWebContents,
  },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn() },
  clipboard: {},
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
}));

import { processBrowserCommand } from './agent-browser-bridge';

const TAB = 'tab:c1.842';

describe('processBrowserCommand — tab routing', () => {
  beforeEach(() => {
    win.getFocusedWindow.mockClear();
    win.getAllWindows.mockClear();
  });

  it('refuses a pane-only command on a tab target without touching a window', async () => {
    const res = await processBrowserCommand('term-1', ['snapshot', '--target', TAB]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_supported_on_tab');
    expect(String(res.data?.message)).toContain('"snapshot"');
    expect(res.data?.surface).toBe(TAB);
    expect(win.getFocusedWindow).not.toHaveBeenCalled();
    expect(win.getAllWindows).not.toHaveBeenCalled();
  });

  it('reports no_extension for a supported command when nothing is paired', async () => {
    const res = await processBrowserCommand('term-1', ['get', 'url', '--target', TAB]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_extension');
    expect(win.getFocusedWindow).not.toHaveBeenCalled();
  });

  it('accepts the bare tab:<id> form too', async () => {
    const res = await processBrowserCommand('term-1', ['reload', '--target', 'tab:842']);
    expect(res.error).toBe('no_extension');
  });

  it('leaves `list` to the renderer even with a tab target (tabs are merged into its reply)', async () => {
    const res = await processBrowserCommand('term-1', ['list', '--target', TAB]);
    expect(res.error).toBe('no_window'); // took the renderer path
    expect(win.getFocusedWindow).toHaveBeenCalled();
  });

  it('routes a pane target down the renderer path unchanged', async () => {
    const res = await processBrowserCommand('term-1', ['snapshot', '--target', 'b3']);
    expect(res.error).toBe('no_window');
    expect(win.getFocusedWindow).toHaveBeenCalled();
  });

  it('still rejects an empty command before any routing', async () => {
    const res = await processBrowserCommand('term-1', []);
    expect(res.error).toBe('empty_command');
  });
});
