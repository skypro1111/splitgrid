import { describe, expect, it } from 'vitest';
import { ClaudeAgentSession } from './claude-agent-session';
import type { AgentEvent } from '../../shared/agent-types';

// Live integration check against the installed `claude` binary. Not part of the
// normal suite (it spawns a real CLI and costs tokens) — run it by path.

describe('ClaudeAgentSession (live)', () => {
  it('reaches idle before any prompt, then completes a turn', async () => {
    const events: AgentEvent[] = [];
    const session = new ClaudeAgentSession(
      { cwd: process.cwd(), permissionMode: 'default' },
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

    // The whole point of the init rework: the pane is usable before a prompt.
    const ready = await waitFor(
      () => events.some((e) => e.type === 'session.status' && e.status === 'idle'),
      30_000,
    );
    expect(ready, `never reached idle: ${JSON.stringify(events.slice(0, 5))}`).toBe(true);

    const init = events.find((e) => e.type === 'session.init');
    expect(init).toBeDefined();
    if (init?.type === 'session.init') {
      expect(init.model).not.toBe('');
      expect(init.slashCommands.length).toBeGreaterThan(0);
      expect(init.account?.email).toBeTruthy();
    }

    session.send('Reply with exactly the word PONG and nothing else.');
    const done = await waitFor(() => events.some((e) => e.type === 'turn.end'), 90_000);
    expect(done, `turn never ended: ${JSON.stringify(events.map((e) => e.type))}`).toBe(true);

    const turnEnd = events.find((e) => e.type === 'turn.end');
    expect(turnEnd?.type === 'turn.end' ? turnEnd.status : null).toBe('completed');

    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'text.delta' }> => e.type === 'text.delta')
      .filter((e) => e.kind === 'assistant')
      .map((e) => e.text)
      .join('');
    expect(text.toUpperCase()).toContain('PONG');
    // Streamed deltas and the final assistant message describe the SAME text;
    // emitting both is the duplicate-message bug.
    expect(text.toUpperCase().match(/PONG/g) ?? []).toHaveLength(1);

    // The prompt must be part of the session's own history, or it vanishes
    // from the pane the moment it remounts and replays.
    const prompts = session.replay().filter((e) => e.type === 'user.message');
    expect(prompts).toHaveLength(1);

    // Exactly one turn footer per turn — no phantom from a handshake result.
    expect(events.filter((e) => e.type === 'turn.end')).toHaveLength(1);

    // Claude's session id must be known so the pane can persist a resume cursor.
    expect(session.resumeId).toMatch(/[0-9a-f-]{36}/);

    await session.stop();
  }, 150_000);

  it('switches into Full access by relaunching, keeping the same thread', async () => {
    const events: AgentEvent[] = [];
    const session = new ClaudeAgentSession(
      { cwd: process.cwd(), permissionMode: 'default' },
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

    // A conversation only exists on disk once a turn has answered, and only
    // then can the relaunch resume it.
    session.send('Reply with exactly the word READY and nothing else.');
    await waitFor(() => events.some((e) => e.type === 'turn.end'), 90_000);
    const threadId = session.resumeId;
    expect(threadId).toMatch(/[0-9a-f-]{36}/);
    events.length = 0;

    await session.setPermissionMode('bypassPermissions');
    const readyAgain = await waitFor(() => events.some((e) => e.type === 'session.init'), 30_000);
    expect(readyAgain, JSON.stringify(events)).toBe(true);

    // The user's report: the CLI rejected the live mode change with
    // "session was not launched with --dangerously-skip-permissions".
    expect(events.filter((e) => e.type === 'session.error')).toEqual([]);
    // A relaunch is not an exit — the pane must not be told the session closed.
    expect(events.some((e) => e.type === 'session.closed')).toBe(false);
    // The resume handshake must not look like a finished turn.
    expect(events.some((e) => e.type === 'turn.end')).toBe(false);
    // Same Claude thread on the other side of the relaunch.
    expect(session.resumeId).toBe(threadId);

    const init = events.find((e) => e.type === 'session.init');
    expect(init?.type === 'session.init' ? init.permissionMode : null).toBe('bypassPermissions');

    await session.stop();
  }, 180_000);

  it('blocks a tool call on the pane\'s approval and honours a deny', async () => {
    const events: AgentEvent[] = [];
    const session = new ClaudeAgentSession(
      { cwd: process.cwd(), permissionMode: 'default' },
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

    // `echo` is on the CLI's safe list, so it would never prompt. A write is.
    session.send('Create the file /tmp/swapit-approval-probe.txt containing the word probe.');
    const asked = await waitFor(() => events.some((e) => e.type === 'approval.request'), 90_000);
    expect(asked, JSON.stringify(events.map((e) => e.type))).toBe(true);

    const request = events.find((e) => e.type === 'approval.request');
    if (request?.type !== 'approval.request') throw new Error('unreachable');
    expect(request.request.summary).toContain('swapit-approval-probe');

    // The tool must still be pending — nothing ran while the pane was asked.
    expect(events.some((e) => e.type === 'tool.end')).toBe(false);

    session.respondToApproval(request.request.requestId, 'deny');
    const resolved = await waitFor(
      () => events.some((e) => e.type === 'approval.resolved'),
      10_000,
    );
    expect(resolved).toBe(true);

    const ended = await waitFor(() => events.some((e) => e.type === 'turn.end'), 90_000);
    expect(ended).toBe(true);

    await session.stop();
  }, 180_000);

  it('runs a slash command sent as a prompt', async () => {
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

    // The pane offers the command list; the CLI is what executes it, so the
    // whole feature rides on plain prompt text.
    const init = events.find((e) => e.type === 'session.init');
    expect(init?.type === 'session.init' ? init.slashCommands.length : 0).toBeGreaterThan(10);

    session.send('/context');
    expect(await waitFor(() => events.some((e) => e.type === 'turn.end'), 90_000)).toBe(true);

    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'text.delta' }> => e.type === 'text.delta')
      .map((e) => e.text)
      .join('');
    expect(text.toLowerCase()).toContain('context');

    await session.stop();
  }, 180_000);

  it('expands an @ mention without the pane reading the file itself', async () => {
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

    session.send('@package.json — reply with ONLY the value of the name field.');
    expect(await waitFor(() => events.some((e) => e.type === 'turn.end'), 90_000)).toBe(true);

    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'text.delta' }> => e.type === 'text.delta')
      .filter((e) => e.kind === 'assistant')
      .map((e) => e.text)
      .join('');
    expect(text).toContain('splitgrid');

    await session.stop();
  }, 180_000);

  it('streams live turn counters, not just a final total', async () => {
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

    session.send('Count from 1 to 20, one number per line, nothing else.');
    expect(await waitFor(() => events.some((e) => e.type === 'turn.end'), 90_000)).toBe(true);

    // The spinner line needs a token count WHILE the turn runs; the result
    // message only arrives at the end.
    const progress = events.filter(
      (e): e is Extract<AgentEvent, { type: 'turn.progress' }> => e.type === 'turn.progress',
    );
    expect(progress.length, JSON.stringify(events.map((e) => e.type))).toBeGreaterThan(0);
    const tokens = progress.map((e) => e.outputTokens).filter((v): v is number => v !== undefined);
    expect(tokens.length).toBeGreaterThan(0);
    expect(Math.max(...tokens)).toBeGreaterThan(0);
    // Progress must land before the turn ends, or it is useless as progress.
    const firstProgress = events.findIndex((e) => e.type === 'turn.progress');
    const turnEnd = events.findIndex((e) => e.type === 'turn.end');
    expect(firstProgress).toBeLessThan(turnEnd);

    await session.stop();
  }, 180_000);
});
