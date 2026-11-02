import { describe, it, expect, beforeEach, vi } from 'vitest';

const sent: Array<{ terminalId: string; state: string; detail?: string }> = [];
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_c: string, p: never) => sent.push(p) } }] },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('./agent-browser-bridge', () => ({ handleBrowserRequest: vi.fn(), isKnownTerminal: () => true }));
vi.mock('./agent-terminal-bridge', () => ({ handleTerminalRequest: vi.fn() }));
vi.mock('./agent-sql-bridge', () => ({ handleSqlRequest: vi.fn() }));
vi.mock('./agent-sftp-bridge', () => ({ handleSftpRequest: vi.fn() }));
vi.mock('./agent-history-bridge', () => ({ handleHistoryRequest: vi.fn() }));
vi.mock('./agent-pane-bridge', () => ({ handleAgentPaneRequest: vi.fn() }));
vi.mock('./agent-browser-channel', () => ({ startExtensionChannel: vi.fn(), stopExtensionChannel: vi.fn() }));

import { handleHookEvent, stopActivityReceiver } from './agent-activity-receiver';

beforeEach(() => { sent.length = 0; stopActivityReceiver(); vi.spyOn(console, 'log').mockImplementation(() => {}); });

describe('hook events carry a notification line', () => {
  it('sends the final reply with Done', () => {
    handleHookEvent('t1', 'prompt-submit', { hook_event_name: 'UserPromptSubmit' });
    handleHookEvent('t1', 'stop', { hook_event_name: 'Stop', last_assistant_message: 'Fixed it.' });
    expect(sent.at(-1)).toEqual({ terminalId: 't1', state: 'idle', detail: 'Fixed it.' });
  });

  it('treats AskUserQuestion as waiting, with the question', () => {
    handleHookEvent('t2', 'prompt-submit');
    handleHookEvent('t2', 'tool', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] } });
    expect(sent.at(-1)).toEqual({ terminalId: 't2', state: 'waiting', detail: 'Ship it? Yes / No' });
    // Answered: back to work.
    handleHookEvent('t2', 'tool', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' });
    expect(sent.at(-1)).toMatchObject({ terminalId: 't2', state: 'working' });
  });

  it('names the pending tool call on a permission prompt', () => {
    handleHookEvent('t3', 'prompt-submit');
    handleHookEvent('t3', 'tool', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm publish' } });
    handleHookEvent('t3', 'notification', { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
    expect(sent.at(-1)).toEqual({ terminalId: 't3', state: 'waiting', detail: 'Allow Bash: npm publish?' });
  });

  it('still works without a payload (older helpers)', () => {
    handleHookEvent('t4', 'prompt-submit');
    handleHookEvent('t4', 'stop');
    expect(sent.at(-1)).toEqual({ terminalId: 't4', state: 'idle' });
  });
});
