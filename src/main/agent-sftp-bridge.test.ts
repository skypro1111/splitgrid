import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The SFTP bridge's HARD-REFUSE gate is the authoritative, main-side enforcement
// that protects the user's remote hosts: /sftp reuses the shared agent token (so
// an agent with only browser/terminal control still holds it), and moving files
// onto a server is exactly the kind of thing that must not happen on a token
// alone. This test pins the gate — with SFTP access OFF no command reaches the
// renderer — and pins that the per-command write flag is read from main.
//
// Electron is mocked so the main-side modules load under node.

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

// Imported AFTER the mock (vi.mock is hoisted). The REAL setters in
// local-shell-manager are used, so this exercises the production gate.
import { processSftpCommand } from './agent-sftp-bridge';
import { setAgentSftpControlEnabled, setAgentSftpWriteEnabled, isAgentSftpWriteEnabled } from './local-shell-manager';

describe('processSftpCommand — main-side hard-refuse gate', () => {
  beforeEach(() => {
    win.getFocusedWindow.mockClear();
    win.getAllWindows.mockClear();
    win.fromWebContents.mockClear();
  });
  afterEach(() => {
    setAgentSftpControlEnabled(false); // leave the gate closed for other tests
    setAgentSftpWriteEnabled(false);
  });

  it('refuses with sftp_disabled when SFTP access is OFF, without touching any window', async () => {
    setAgentSftpControlEnabled(false);
    const res = await processSftpCommand('term-1', ['targets']);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('sftp_disabled');
    expect(win.getFocusedWindow).not.toHaveBeenCalled();
    expect(win.getAllWindows).not.toHaveBeenCalled();
  });

  it('refuses even help and read-only commands while disabled', async () => {
    setAgentSftpControlEnabled(false);
    for (const argv of [['help'], ['ls', '/srv'], ['get', '/srv/x']]) {
      const res = await processSftpCommand('term-1', argv);
      expect(res.error).toBe('sftp_disabled');
    }
    expect(win.getFocusedWindow).not.toHaveBeenCalled();
  });

  it('with access ON it passes the gate (then fails for lack of a window, NOT sftp_disabled)', async () => {
    setAgentSftpControlEnabled(true);
    const res = await processSftpCommand('term-1', ['targets']);
    expect(res.error).not.toBe('sftp_disabled');
    expect(res.error).toBe('no_window');
    expect(win.getFocusedWindow).toHaveBeenCalled();
  });

  it('refuses an empty command with empty_command (after the gate) when enabled', async () => {
    setAgentSftpControlEnabled(true);
    const res = await processSftpCommand('term-1', []);
    expect(res.error).toBe('empty_command');
  });

  it('the write flag lives in main and defaults to off even while access is on', () => {
    setAgentSftpControlEnabled(true);
    expect(isAgentSftpWriteEnabled()).toBe(false);
    setAgentSftpWriteEnabled(true);
    expect(isAgentSftpWriteEnabled()).toBe(true);
  });
});
