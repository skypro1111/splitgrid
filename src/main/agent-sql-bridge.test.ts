import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The SQL bridge's HARD-REFUSE gate is the authoritative, main-side enforcement
// that protects the user's DB: even though the /sql endpoint reuses the shared
// agent token (so an agent with only browser/terminal control still holds it),
// no SQL command may reach the renderer unless the user opted into SQL control.
// This test pins that gate: with SQL control OFF, processSqlCommand returns
// {ok:false, error:'sql_disabled'} WITHOUT resolving or touching any window.
//
// Electron is mocked so the main-side modules load under node. The window
// accessors are spies: the gate must short-circuit BEFORE any of them is called.

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
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
}));

// Imported AFTER the mock (vi.mock is hoisted). We use the REAL setter/getter in
// local-shell-manager so the test exercises the production gate, not a stand-in.
import { processSqlCommand } from './agent-sql-bridge';
import { setAgentSqlControlEnabled } from './local-shell-manager';

describe('processSqlCommand — main-side hard-refuse gate', () => {
  beforeEach(() => {
    win.getFocusedWindow.mockClear();
    win.getAllWindows.mockClear();
    win.fromWebContents.mockClear();
  });
  afterEach(() => {
    setAgentSqlControlEnabled(false); // leave the gate closed for other tests
  });

  it('refuses with sql_disabled when SQL control is OFF, without touching any window', async () => {
    setAgentSqlControlEnabled(false);
    const res = await processSqlCommand('term-1', ['list']);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('sql_disabled');
    // The renderer/owner path must never run — no window was resolved.
    expect(win.getFocusedWindow).not.toHaveBeenCalled();
    expect(win.getAllWindows).not.toHaveBeenCalled();
  });

  it('refuses even a help/read command while disabled', async () => {
    setAgentSqlControlEnabled(false);
    for (const argv of [['help'], ['connections'], ['query', 'select 1']]) {
      const res = await processSqlCommand('term-1', argv);
      expect(res.error).toBe('sql_disabled');
    }
    expect(win.getFocusedWindow).not.toHaveBeenCalled();
  });

  it('with SQL control ON it passes the gate (then fails later for lack of a window, NOT sql_disabled)', async () => {
    // Proves the gate is the ONLY thing rejecting in the disabled case: once
    // enabled, the same call advances past the gate and resolves a window (here
    // none exists, so it returns no_window — not sql_disabled).
    setAgentSqlControlEnabled(true);
    const res = await processSqlCommand('term-1', ['list']);
    expect(res.error).not.toBe('sql_disabled');
    expect(res.error).toBe('no_window');
    // It DID try to resolve a window this time.
    expect(win.getFocusedWindow).toHaveBeenCalled();
  });

  it('refuses an empty command with empty_command (after the gate) when enabled', async () => {
    setAgentSqlControlEnabled(true);
    const res = await processSqlCommand('term-1', []);
    expect(res.error).toBe('empty_command');
  });
});
