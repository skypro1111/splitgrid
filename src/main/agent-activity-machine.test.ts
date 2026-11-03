import { describe, it, expect } from 'vitest';
import { applyHookEvent, sweep, BACKGROUND_READY_MS, SAFETY_READY_MS, type HookEventName, type TermActivity } from './agent-activity-machine';
import { parseHookPayload } from './agent-hook-detail';

// Feed a sequence of hook events; return the final activity and every emitted state.
function run(events: Array<[HookEventName, Record<string, unknown>?]>, start?: TermActivity) {
  let cur = start;
  const emitted: string[] = [];
  let t = 1000;
  for (const [ev, payload] of events) {
    const step = applyHookEvent(cur, ev, parseHookPayload(payload ?? null), (t += 1000));
    if (!step) continue;
    cur = step.next;
    if (step.emit) emitted.push(step.emit.detail ? `${step.emit.state}:${step.emit.detail}` : step.emit.state);
  }
  return { cur: cur!, emitted };
}

const S = { session_id: 'main' };
const pre = (tool: string, input: Record<string, unknown> = {}) => ({ ...S, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });
const post = (tool: string) => ({ ...S, hook_event_name: 'PostToolUse', tool_name: tool });

describe('agent turn state', () => {
  it('runs a normal turn: ready → working → Done with the reply', () => {
    const { emitted } = run([
      ['session-start', { ...S, source: 'startup' }],
      ['prompt', S],
      ['tool', pre('Bash', { command: 'ls' })],
      ['tool', post('Bash')],
      ['stop', { ...S, last_assistant_message: 'Listed it.' }],
    ]);
    expect(emitted).toEqual(['ready', 'working', 'idle:Listed it.']);
  });

  it('never calls an interrupted turn Done: idle_prompt brings it back to ready', () => {
    const { emitted, cur } = run([
      ['prompt', S],
      ['tool', pre('Bash')],
      // Esc: no Stop. A minute later Claude Code reports the idle prompt.
      ['notification', { ...S, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }],
    ]);
    expect(emitted).toEqual(['working', 'ready']);
    expect(cur.pending).toBeUndefined();
  });

  it('ignores idle_prompt after a finished turn, and noise notifications mid-turn', () => {
    expect(run([['prompt', S], ['stop', S], ['notification', { ...S, notification_type: 'idle_prompt' }]]).emitted).toEqual(['working', 'idle']);
    for (const type of ['auth_success', 'agent_completed', 'elicitation_complete', 'plugin_notification']) {
      expect(run([['prompt', S], ['notification', { ...S, notification_type: type }]]).emitted).toEqual(['working']);
    }
  });

  it('waits on a permission prompt, naming the pending tool call', () => {
    const { emitted } = run([
      ['prompt', S],
      ['tool', pre('Bash', { command: 'npm publish' })],
      ['notification', { ...S, notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }],
      ['tool', post('Bash')],
    ]);
    expect(emitted).toEqual(['working', 'waiting:Allow Bash: npm publish?', 'working']);
  });

  it('waits on a question', () => {
    const { emitted } = run([
      ['prompt', S],
      ['tool', pre('AskUserQuestion', { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] })],
      ['tool', post('AskUserQuestion')],
    ]);
    expect(emitted).toEqual(['working', 'waiting:Ship it? Yes / No', 'working']);
  });

  it('leaves the main turn alone for subagents\' own tool calls, also after it ended', () => {
    const sub = { agent_id: 'a1', agent_type: 'Explore' };
    const { emitted, cur } = run([
      ['prompt', S],
      ['stop', S],
      ['tool', { ...pre('Bash'), ...sub }],
      ['tool', { ...post('Bash'), ...sub }],
    ]);
    expect(emitted).toEqual(['working', 'idle']);
    expect(cur.state).toBe('idle');
  });

  it('keeps working while background agents will wake the session, and Dones once at the end', () => {
    const { emitted } = run([
      ['prompt', S],
      ['stop', { ...S, last_assistant_message: 'Started a review agent.', background_tasks: [{ type: 'subagent', id: 't1' }] }],
      ['prompt', S], // the agent's report wakes the session
      ['stop', { ...S, last_assistant_message: 'Review done: 2 issues.', background_tasks: [] }],
    ]);
    expect(emitted).toEqual(['working', 'idle:Review done: 2 issues.']);
    // A dev server in the background doesn't hold the turn open.
    expect(run([['prompt', S], ['stop', { ...S, background_tasks: [{ type: 'shell' }] }]]).emitted).toEqual(['working', 'idle']);
  });

  it('ignores a nested `claude -p` the agent runs, which inherits the terminal', () => {
    const child = { session_id: 'child' };
    const { emitted, cur } = run([
      ['session-start', { ...S, source: 'startup' }],
      ['prompt', S],
      ['tool', pre('Bash', { command: 'claude -p "summarize"' })],
      ['session-start', { ...child, source: 'startup' }],
      ['prompt', child],
      ['stop', { ...child, last_assistant_message: 'child reply' }],
      ['session-end', child],
      ['tool', post('Bash')],
    ]);
    expect(emitted).toEqual(['ready', 'working']);
    expect(cur).toMatchObject({ state: 'working', session: 'main' });
  });

  it('takes over when the user starts a new session in the same terminal', () => {
    const { emitted, cur } = run([
      ['prompt', S],
      ['stop', S],
      ['session-end', S],
      ['session-start', { session_id: 'second', source: 'startup' }],
      ['prompt', { session_id: 'second' }],
    ]);
    expect(emitted).toEqual(['working', 'idle', 'ready', 'working']);
    expect(cur.session).toBe('second');
    // /clear without a SessionEnd we saw: the new session still takes over while idle.
    expect(run([['prompt', S], ['stop', S], ['session-start', { session_id: 'n', source: 'clear' }]]).cur).toMatchObject({ state: 'ready', session: 'n' });
  });

  it('keeps a turn going through compaction', () => {
    expect(run([['prompt', S], ['session-start', { ...S, source: 'compact' }], ['stop', S]]).emitted).toEqual(['working', 'idle']);
  });

  it('works with older helpers that send no payload', () => {
    expect(run([['prompt'], ['notification'], ['stop']]).emitted).toEqual(['working', 'waiting', 'idle']);
  });
});

describe('sweep', () => {
  const at = (over: Partial<TermActivity>): TermActivity => ({ state: 'working', lastEventAt: 0, ...over });
  const late = SAFETY_READY_MS + 1;

  it('brings a silent working turn back to ready, never to Done', () => {
    expect(sweep(at({}), late)?.emit).toEqual({ state: 'ready' });
  });

  it('leaves alone a running tool, background agents, a wait and a finished turn', () => {
    expect(sweep(at({ pending: { tool_name: 'Bash' } }), late)).toBeNull();
    expect(sweep(at({ awaitingBackground: true }), late)).toBeNull();
    expect(sweep(at({ awaitingBackground: true }), BACKGROUND_READY_MS + 1)?.emit).toEqual({ state: 'ready' });
    expect(sweep(at({ state: 'waiting' }), late)).toBeNull();
    expect(sweep(at({ state: 'idle' }), late)).toBeNull();
    expect(sweep(at({}), SAFETY_READY_MS - 1)).toBeNull();
  });
});
