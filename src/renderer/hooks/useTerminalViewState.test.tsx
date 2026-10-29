import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useTerminalViewState, isNewDoneEdge } from './useTerminalViewState';
import type { ClaudeActivityState, Workspace } from '../../shared/types';

const ws = (id: string, sid: string) =>
  ({ id, containers: [{ id: `c-${id}`, content: { type: 'terminal', terminalId: sid } }] }) as unknown as Workspace;
const WORKSPACES = [ws('A', 'sa'), ws('B', 'sb')];
const NO_NOTIFY = new Map<string, number>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  (window as unknown as { electronAPI: unknown }).electronAPI = { onTerminalWebInput: () => () => {} };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('isNewDoneEdge', () => {
  it('counts only a real transition into done', () => {
    expect(isNewDoneEdge('done', 'working')).toBe(true);
    expect(isNewDoneEdge('done', undefined)).toBe(true);
    expect(isNewDoneEdge('done', 'done')).toBe(false);
    expect(isNewDoneEdge('done', 'done', true)).toBe(true);
    expect(isNewDoneEdge('working', 'done')).toBe(false);
    expect(isNewDoneEdge(null, 'working')).toBe(false);
  });
});

describe('useTerminalViewState', () => {
  it('does not re-fire Done for a viewed terminal when its process briefly reads as unknown', () => {
    const onNewUnviewed = vi.fn();
    let cmd: string | undefined = 'claude';
    let activity = new Map<string, ClaudeActivityState>([['sb', 'working']]);
    let active = 'A';
    const { result, rerender } = renderHook(() => useTerminalViewState({
      workspaces: WORKSPACES,
      activeWorkspaceId: active,
      claudeActivity: activity,
      sessionActivity: undefined,
      notifyAt: NO_NOTIFY,
      getProcCommand: (sid) => (sid === 'sb' ? cmd : undefined),
      onNewUnviewed,
    }));
    // One recompute pass: new inputs, the clock moved on, then a focus event
    // (jsdom's window timers aren't the faked globals, so drive it directly).
    const tick = () => {
      act(() => rerender()); // commit first: the hook reads inputs from a ref set on render
      act(() => {
        vi.advanceTimersByTime(1000);
        window.dispatchEvent(new Event('focus'));
      });
    };

    // B finishes in the background → one notification, B highlighted.
    activity = new Map([['sb', 'idle']]);
    tick();
    expect(onNewUnviewed).toHaveBeenCalledTimes(1);
    expect(result.current.unviewedWorkspaces.has('B')).toBe(true);

    // The user opens B, then goes back to A.
    active = 'B'; tick();
    expect(result.current.unviewedWorkspaces.has('B')).toBe(false);
    active = 'A'; tick();

    // A failed process poll blanks the foreground command for one tick.
    cmd = undefined; tick();
    cmd = 'claude'; tick(); tick();
    expect(onNewUnviewed).toHaveBeenCalledTimes(1);
    expect(result.current.unviewedWorkspaces.has('B')).toBe(false);

    // A genuinely new turn finishing in the background still notifies.
    activity = new Map([['sb', 'working']]); tick();
    activity = new Map([['sb', 'idle']]); tick();
    expect(onNewUnviewed).toHaveBeenCalledTimes(2);
    expect(result.current.unviewedWorkspaces.has('B')).toBe(true);
  });
});
