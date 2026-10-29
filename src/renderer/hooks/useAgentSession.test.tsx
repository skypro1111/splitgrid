import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useAgentSession } from './useAgentSession';
import type { AgentEvent } from '../../shared/agent-types';

let emit: ((event: AgentEvent) => void) | null = null;
const startSpy = vi.fn();
const attachSpy = vi.fn();
const detachSpy = vi.fn();
const sendSpy = vi.fn();
const stopSpy = vi.fn();
const approveSpy = vi.fn();
const questionSpy = vi.fn();
const interruptSpy = vi.fn();
const permissionSpy = vi.fn();

const SESSION = 'sess-1';
const OPTIONS = { cwd: '/work' };

beforeEach(() => {
  emit = null;
  startSpy.mockReset().mockResolvedValue({ sessionId: SESSION });
  // Attaching is what opens the stream — the main process holds every event
  // until a pane subscribes, so the happy path always attaches.
  attachSpy.mockReset().mockResolvedValue({ ok: true, events: [] });
  detachSpy.mockReset().mockResolvedValue(undefined);
  sendSpy.mockReset().mockResolvedValue(undefined);
  stopSpy.mockReset().mockResolvedValue(undefined);
  approveSpy.mockReset().mockResolvedValue(undefined);
  questionSpy.mockReset().mockResolvedValue(undefined);
  interruptSpy.mockReset().mockResolvedValue(undefined);
  permissionSpy.mockReset().mockResolvedValue(undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    agentStartSession: startSpy,
    agentAttachSession: attachSpy,
    agentDetachSession: detachSpy,
    agentSend: sendSpy,
    agentStopSession: stopSpy,
    agentRespondApproval: approveSpy,
    agentRespondQuestion: questionSpy,
    agentInterrupt: interruptSpy,
    agentSetPermissionMode: permissionSpy,
    onAgentEvent: (cb: (event: AgentEvent) => void) => {
      emit = cb;
      return () => { emit = null; };
    },
  };
});

afterEach(() => cleanup());

async function mounted(existingSessionId?: string) {
  const rendered = renderHook(() =>
    useAgentSession({
      options: OPTIONS,
      ...(existingSessionId ? { existingSessionId } : {}),
    }),
  );
  await waitFor(() => expect(rendered.result.current.sessionId).toBe(SESSION));
  return rendered;
}

describe('useAgentSession', () => {
  it('starts one session for the pane and detaches (not kills) on unmount', async () => {
    const { unmount } = await mounted();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(OPTIONS);
    unmount();
    // A workspace switch unmounts the pane; the session stays warm.
    expect(detachSpy).toHaveBeenCalledWith(SESSION);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('reattaches to a live session and replays its transcript', async () => {
    attachSpy.mockResolvedValue({
      ok: true,
      events: [
        { type: 'session.status', sessionId: SESSION, status: 'idle' },
        { type: 'text.delta', sessionId: SESSION, itemId: 'i1', kind: 'assistant', text: 'earlier' },
        { type: 'text.end', sessionId: SESSION, itemId: 'i1' },
      ],
    });
    const { result } = await mounted(SESSION);
    expect(attachSpy).toHaveBeenCalledWith(SESSION);
    expect(startSpy).not.toHaveBeenCalled();
    expect(result.current.transcript).toEqual([
      { id: 'i1', kind: 'assistant', text: 'earlier', streaming: false },
    ]);
    expect(result.current.status).toBe('idle');
  });

  it('starts fresh when the remembered session is gone', async () => {
    attachSpy.mockImplementation(async (id: string) =>
      id === SESSION ? { ok: true, events: [] } : { ok: false, events: [] },
    );
    await mounted('stale-id');
    expect(attachSpy).toHaveBeenCalledWith('stale-id');
    expect(startSpy).toHaveBeenCalledTimes(1);
    // …and the freshly created session is the one it attaches to.
    expect(attachSpy).toHaveBeenCalledWith(SESSION);
  });

  it('applies the replay before events that arrive during it', async () => {
    let release: ((value: { ok: boolean; events: AgentEvent[] }) => void) | null = null;
    attachSpy.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const rendered = renderHook(() => useAgentSession({ options: OPTIONS }));
    await waitFor(() => expect(release).not.toBeNull());

    // Live event lands while the replay is still in flight.
    act(() => {
      emit!({ type: 'text.delta', sessionId: SESSION, itemId: 'i2', kind: 'assistant', text: 'live' });
    });

    await act(async () => {
      release!({
        ok: true,
        events: [
          { type: 'text.delta', sessionId: SESSION, itemId: 'i1', kind: 'assistant', text: 'history' },
          { type: 'text.end', sessionId: SESSION, itemId: 'i1' },
        ],
      });
    });

    await waitFor(() => expect(rendered.result.current.transcript).toHaveLength(2));
    expect(rendered.result.current.transcript.map((item) => item.id)).toEqual(['i1', 'i2']);
  });

  it('ends the session for good when the pane is closed', async () => {
    const { result } = await mounted();
    act(() => { result.current.stop(); });
    expect(stopSpy).toHaveBeenCalledWith(SESSION);
  });

  it('folds streamed deltas into one assistant item', async () => {
    const { result } = await mounted();

    act(() => {
      emit!({ type: 'text.delta', sessionId: SESSION, itemId: 'i1', kind: 'assistant', text: 'Hel' });
      emit!({ type: 'text.delta', sessionId: SESSION, itemId: 'i1', kind: 'assistant', text: 'lo' });
    });
    expect(result.current.transcript).toEqual([
      { id: 'i1', kind: 'assistant', text: 'Hello', streaming: true },
    ]);

    act(() => { emit!({ type: 'text.end', sessionId: SESSION, itemId: 'i1' }); });
    expect(result.current.transcript[0]).toMatchObject({ streaming: false });
  });

  it('ignores events addressed to another pane', async () => {
    const { result } = await mounted();
    act(() => {
      emit!({ type: 'text.delta', sessionId: 'other', itemId: 'x', kind: 'assistant', text: 'nope' });
    });
    expect(result.current.transcript).toEqual([]);
  });

  it('closes a tool card when its result arrives', async () => {
    const { result } = await mounted();
    act(() => {
      emit!({
        type: 'tool.start',
        sessionId: SESSION,
        itemId: 'tool:1',
        toolUseId: '1',
        name: 'Bash',
        summary: 'ls',
        input: {},
      });
    });
    expect(result.current.transcript[0]).toMatchObject({ kind: 'tool', running: true });

    act(() => {
      emit!({
        type: 'tool.end',
        sessionId: SESSION,
        itemId: 'tool:1',
        toolUseId: '1',
        isError: false,
        output: 'a\nb',
      });
    });
    expect(result.current.transcript[0]).toMatchObject({ running: false, output: 'a\nb' });
  });

  it('surfaces an approval request and answers it once', async () => {
    const { result } = await mounted();
    act(() => {
      emit!({
        type: 'approval.request',
        sessionId: SESSION,
        request: {
          requestId: 'r1',
          toolName: 'Bash',
          summary: 'rm -rf /tmp/x',
          input: {},
          canAllowForSession: true,
        },
      });
    });
    expect(result.current.approval?.requestId).toBe('r1');

    act(() => { result.current.respondApproval('deny'); });
    expect(approveSpy).toHaveBeenCalledWith(SESSION, 'r1', 'deny');
    expect(result.current.approval).toBeNull();
  });

  it('forwards the prompt and shows it once the session echoes it', async () => {
    const { result } = await mounted();
    act(() => { result.current.send('  build it  '); });
    expect(sendSpy).toHaveBeenCalledWith(SESSION, '  build it  ');
    expect(result.current.status).toBe('running');
    // The bubble is NOT added locally — it arrives as an event, so it is part
    // of the session history and survives a remount.
    expect(result.current.transcript).toEqual([]);

    act(() => {
      emit!({ type: 'user.message', sessionId: SESSION, itemId: 'user:t1', text: '  build it  ' });
    });
    expect(result.current.transcript[0]).toMatchObject({ kind: 'user', text: '  build it  ' });
  });

  it('replays past prompts, not just the answers', async () => {
    attachSpy.mockResolvedValue({
      ok: true,
      events: [
        { type: 'user.message', sessionId: SESSION, itemId: 'user:t1', text: 'earlier ask' },
        { type: 'text.delta', sessionId: SESSION, itemId: 'i1', kind: 'assistant', text: 'answer' },
      ],
    });
    const { result } = await mounted(SESSION);
    expect(result.current.transcript.map((item) => item.kind)).toEqual(['user', 'assistant']);
  });

  it('ignores an empty prompt', async () => {
    const { result } = await mounted();
    act(() => { result.current.send('   '); });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('tracks session metadata and permission mode from init', async () => {
    const { result } = await mounted();
    act(() => {
      emit!({
        type: 'session.init',
        sessionId: SESSION,
        claudeSessionId: 'claude-abc',
        model: 'claude-opus-5',
        cwd: '/work',
        permissionMode: 'acceptEdits',
        slashCommands: [{ name: 'review', description: 'review the diff' }],
      });
    });
    expect(result.current.info).toMatchObject({ claudeSessionId: 'claude-abc', model: 'claude-opus-5' });
    expect(result.current.permissionMode).toBe('acceptEdits');
  });

  it('appends a turn footer and returns to idle', async () => {
    const { result } = await mounted();
    act(() => {
      emit!({
        type: 'turn.end',
        sessionId: SESSION,
        turnId: 't1',
        status: 'completed',
        usage: { costUsd: 0.01 },
      });
      emit!({ type: 'session.status', sessionId: SESSION, status: 'idle' });
    });
    expect(result.current.transcript.at(-1)).toMatchObject({ kind: 'turn-end', status: 'completed' });
    expect(result.current.status).toBe('idle');
  });

  it('surfaces what the CLI is busy with, and clears it when the turn ends', async () => {
    const { result } = await mounted();
    act(() => {
      emit!({ type: 'session.activity', sessionId: SESSION, activity: 'compacting' });
    });
    expect(result.current.activity).toBe('compacting');

    act(() => {
      emit!({ type: 'session.status', sessionId: SESSION, status: 'idle' });
    });
    // A stale "Compacting…" caption after the turn would be worse than none.
    expect(result.current.activity).toBeNull();
  });

  it('records a compaction boundary in the transcript', async () => {
    const { result } = await mounted();
    act(() => {
      emit!({
        type: 'context.compacted',
        sessionId: SESSION,
        itemId: 'c1',
        trigger: 'manual',
        preTokens: 120000,
        postTokens: 25000,
      });
    });
    expect(result.current.transcript[0]).toMatchObject({
      kind: 'compaction',
      preTokens: 120000,
      postTokens: 25000,
    });
  });

  it('tracks live turn counters and clears them when the turn ends', async () => {
    const { result } = await mounted();
    act(() => { emit!({ type: 'turn.start', sessionId: SESSION, turnId: 't1' }); });
    expect(result.current.progress).toMatchObject({ outputTokens: 0, tool: null, phase: null });

    act(() => {
      emit!({ type: 'turn.progress', sessionId: SESSION, outputTokens: 1420 });
      emit!({ type: 'turn.progress', sessionId: SESSION, thinkingTokens: 780 });
      emit!({
        type: 'turn.progress',
        sessionId: SESSION,
        tool: { name: 'Bash', elapsedSeconds: 12 },
      });
    });
    // Each event is a patch: later ones must not wipe earlier counters.
    expect(result.current.progress).toMatchObject({
      outputTokens: 1420,
      thinkingTokens: 780,
      tool: { name: 'Bash', elapsedSeconds: 12 },
    });

    act(() => {
      emit!({
        type: 'tool.end',
        sessionId: SESSION,
        itemId: 'tool:1',
        toolUseId: '1',
        isError: false,
        output: '',
      });
    });
    expect(result.current.progress?.tool).toBeNull();

    act(() => {
      emit!({ type: 'text.delta', sessionId: SESSION, itemId: 'i1', kind: 'thinking', text: 'hm' });
    });
    expect(result.current.progress?.phase).toBe('thinking');

    act(() => {
      emit!({ type: 'turn.end', sessionId: SESSION, turnId: 't1', status: 'completed' });
    });
    // A counter left on screen after the turn is worse than no counter.
    expect(result.current.progress).toBeNull();
  });

  it('ignores progress that arrives outside a turn', async () => {
    const { result } = await mounted();
    act(() => { emit!({ type: 'turn.progress', sessionId: SESSION, outputTokens: 99 }); });
    expect(result.current.progress).toBeNull();
  });

  it('drops pending prompts when the session closes', async () => {
    const { result } = await mounted();
    act(() => {
      emit!({
        type: 'approval.request',
        sessionId: SESSION,
        request: { requestId: 'r1', toolName: 'Bash', summary: 'x', input: {}, canAllowForSession: false },
      });
      emit!({ type: 'session.closed', sessionId: SESSION, reason: 'exited' });
    });
    expect(result.current.approval).toBeNull();
    expect(result.current.status).toBe('closed');
  });
});
