import { describe, expect, it } from 'vitest';
import { ClaudeAgentSession } from './claude-agent-session';
import type { AgentEvent } from '../../shared/agent-types';

describe('compaction (live)', () => {
  it('reports compacting progress and the boundary it produced', async () => {
    const events: AgentEvent[] = [];
    const session = new ClaudeAgentSession(
      { cwd: process.cwd() },
      { emit: (event) => events.push(event) },
    );
    await session.start();

    const waitFor = async (predicate: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    await waitFor(() => events.some((e) => e.type === 'session.init'), 30_000);

    // Something to compact.
    session.send('Reply with exactly: SEED');
    await waitFor(() => events.some((e) => e.type === 'turn.end'), 90_000);
    events.length = 0;

    session.send('/compact');
    const done = await waitFor(() => events.some((e) => e.type === 'turn.end'), 180_000);
    expect(done, JSON.stringify(events.map((e) => e.type))).toBe(true);

    // The terminal shows a spinner caption while this runs; the pane needs the
    // same signal or a long compaction reads as a frozen pane.
    const activities = events.filter(
      (e): e is Extract<AgentEvent, { type: 'session.activity' }> => e.type === 'session.activity',
    );
    expect(
      activities.some((e) => e.activity === 'compacting'),
      JSON.stringify(events.map((e) => e.type)),
    ).toBe(true);
    // …and it must clear, or the caption sticks forever.
    expect(activities.at(-1)?.activity).toBeNull();

    // A short thread may have nothing worth compacting, and the CLI says so.
    // Either outcome is fine — what matters is that the pane reports it rather
    // than sitting silent.
    const boundary = events.find((e) => e.type === 'context.compacted');
    const failure = events.find((e) => e.type === 'session.error');
    expect(
      Boolean(boundary) || Boolean(failure),
      JSON.stringify(events.map((e) => e.type)),
    ).toBe(true);
    if (boundary?.type === 'context.compacted') {
      expect(boundary.preTokens).toBeGreaterThan(0);
    }

    await session.stop();
  }, 240_000);
});
