import { describe, expect, it } from 'vitest';
import { resolveSessionRef, takeTail } from './agent-pane-bridge';

const SESSIONS = [
  { sessionId: 'aaaa1111-0000-0000-0000-000000000000' },
  { sessionId: 'bbbb2222-0000-0000-0000-000000000000' },
  { sessionId: 'bbbb3333-0000-0000-0000-000000000000' },
];

describe('takeTail', () => {
  it('pulls --tail out of argv and leaves the rest', () => {
    expect(takeTail(['#1', '--tail', '40'], 200)).toEqual({ tail: 40, rest: ['#1'] });
  });

  it('falls back when --tail is missing or nonsense', () => {
    expect(takeTail(['#1'], 200).tail).toBe(200);
    expect(takeTail(['#1', '--tail', 'abc'], 200).tail).toBe(200);
    expect(takeTail(['#1', '--tail', '-5'], 200).tail).toBe(200);
  });

  it('ignores a trailing --tail with no value', () => {
    expect(takeTail(['--tail'], 25)).toEqual({ tail: 25, rest: [] });
  });
});

describe('resolveSessionRef', () => {
  it('resolves a full id', () => {
    expect(resolveSessionRef(SESSIONS[0].sessionId, SESSIONS)).toEqual({
      sessionId: SESSIONS[0].sessionId,
    });
  });

  it('resolves a 1-based index, which is what `list` prints', () => {
    expect(resolveSessionRef('#2', SESSIONS)).toEqual({ sessionId: SESSIONS[1].sessionId });
  });

  it('resolves a unique prefix', () => {
    expect(resolveSessionRef('aaaa', SESSIONS)).toEqual({ sessionId: SESSIONS[0].sessionId });
  });

  it('refuses an ambiguous prefix rather than picking one', () => {
    expect(resolveSessionRef('bbbb', SESSIONS)).toEqual({ error: 'ambiguous_session' });
  });

  it('reports unknown refs', () => {
    expect(resolveSessionRef('zzzz', SESSIONS)).toEqual({ error: 'unknown_session' });
    expect(resolveSessionRef('#9', SESSIONS)).toEqual({ error: 'unknown_session' });
    expect(resolveSessionRef('', SESSIONS)).toEqual({ error: 'missing_session' });
  });
});
