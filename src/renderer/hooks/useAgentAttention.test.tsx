import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { AppSettings, Workspace } from '../../shared/types';

vi.mock('../sounds', () => ({ playSound: vi.fn() }));
import { playSound } from '../sounds';
import { useAgentAttention, attentionText } from './useAgentAttention';

const WS = {
  id: 'w1', name: 'api',
  containers: [{ id: 'c1', content: { type: 'terminal', terminalId: 's1', label: 'claude' } }],
} as unknown as Workspace;
const BASE: AppSettings = { defaultSoundId: 'x', defaultVolume: 0.5, muteAll: false };

let activate: ((t: { workspaceId: string; sessionId: string }) => void) | undefined;
let activity: ((p: { terminalId: string; state: 'working' | 'idle' | 'waiting'; detail?: string }) => void) | undefined;
const show = vi.fn(async () => true);

beforeEach(() => {
  vi.mocked(playSound).mockClear();
  show.mockClear();
  activate = undefined;
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    showAgentNotification: show,
    onAgentNotificationActivate: (cb: typeof activate) => { activate = cb; return () => {}; },
    onClaudeActivity: (cb: typeof activity) => { activity = cb; return () => {}; },
  };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup(settings: Partial<AppSettings> = {}, ws: Workspace = WS) {
  const focusContainerInWorkspace = vi.fn();
  const switchWorkspace = vi.fn();
  const { result } = renderHook(() => useAgentAttention({
    getSettings: () => ({ ...BASE, ...settings }),
    getWorkspaces: () => [ws],
    focusContainerInWorkspace,
    switchWorkspace,
  }));
  return { ...result.current, focusContainerInWorkspace, switchWorkspace };
}

describe('useAgentAttention', () => {
  it('posts a system notification for Done and Waiting while the window is unfocused', () => {
    const { onDone } = setup();
    onDone('s1', 'w1');
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({ workspaceId: 'w1', sessionId: 's1', ...attentionText('done', WS, 's1') });
    expect(attentionText('waiting', WS, 's1').title).toBe('api · claude — waiting for you');
  });

  it('shows the agent\'s line: the final reply for Done, the question for Waiting', () => {
    const { onDone, onWaiting } = setup();
    activity?.({ terminalId: 's1', state: 'idle', detail: 'Fixed the flaky test.' });
    onDone('s1', 'w1');
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'api · claude — Done', body: 'Fixed the flaky test.' }));
    activity?.({ terminalId: 's1', state: 'waiting', detail: 'Ship it? Yes / No' });
    onWaiting('s1', 'w1');
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'Ship it? Yes / No' }));
    // A line from another state never stands in: Done right after a wait.
    onDone('s1', 'w1');
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'Finished its turn' }));
  });

  it('stays in-app while focused, and respects the toggles and mutes', () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    setup().onWaiting('s1', 'w1');
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(false);

    setup({ notifyOnWaiting: false }).onWaiting('s1', 'w1');
    setup({ systemNotifications: false }).onDone('s1', 'w1');
    setup({ muteAll: true }).onDone('s1', 'w1');
    setup({}, { ...WS, notifyMuted: true }).onDone('s1', 'w1');
    expect(show).not.toHaveBeenCalled();
  });

  it('opens the workspace and focuses the terminal on click', () => {
    const { focusContainerInWorkspace, switchWorkspace } = setup();
    activate?.({ workspaceId: 'w1', sessionId: 's1' });
    expect(focusContainerInWorkspace).toHaveBeenCalledWith('w1', 'c1');
    activate?.({ workspaceId: 'w1', sessionId: 'gone' });
    expect(switchWorkspace).toHaveBeenCalledWith('w1');
    activate?.({ workspaceId: 'nope', sessionId: 's1' });
    expect(focusContainerInWorkspace).toHaveBeenCalledTimes(1);
  });
});
