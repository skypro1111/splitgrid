import { describe, it, expect } from 'vitest';
import { parseArgv, MAX_WAIT_MS } from './browserArgv';

describe('parseArgv', () => {
  it('keeps positionals in order and defaults flags', () => {
    const r = parseArgv(['open', 'http://localhost:3000']);
    expect(r.positional).toEqual(['open', 'http://localhost:3000']);
    expect(r.target).toBeUndefined();
    expect(r.timeoutMs).toBeUndefined();
    expect(r.viewport).toBe(false);
    expect(r.full).toBe(false);
  });

  it('pulls --target / --surface out of the positionals', () => {
    expect(parseArgv(['click', 'e1', '--target', 'b3']).target).toBe('b3');
    expect(parseArgv(['click', 'e1', '--surface', 'b3']).target).toBe('b3');
    expect(parseArgv(['click', 'e1', '--target', 'b3']).positional).toEqual(['click', 'e1']);
  });

  it('parses and clamps --timeout to [0, MAX_WAIT_MS]', () => {
    expect(parseArgv(['wait', 'load', '--timeout', '5000']).timeoutMs).toBe(5000);
    expect(parseArgv(['wait', 'load', '-t', '999999']).timeoutMs).toBe(MAX_WAIT_MS);
    expect(parseArgv(['wait', 'load', '--timeout', '-5']).timeoutMs).toBe(0);
    expect(parseArgv(['wait', 'load', '--timeout', '12.9']).timeoutMs).toBe(12); // floored
  });

  it('ignores a non-numeric --timeout value (leaves it undefined, value consumed)', () => {
    const r = parseArgv(['wait', 'load', '--timeout', 'soon']);
    expect(r.timeoutMs).toBeUndefined();
    expect(r.positional).toEqual(['wait', 'load']);
  });

  it('recognizes --viewport and --full/--fullpage', () => {
    expect(parseArgv(['snapshot', '--viewport']).viewport).toBe(true);
    expect(parseArgv(['screenshot', '--full']).full).toBe(true);
    expect(parseArgv(['screenshot', '--fullpage']).full).toBe(true);
  });

  it('handles flags interleaved with positionals', () => {
    const r = parseArgv(['fill', 'e2', '--target', 'b1', 'hello world', '--timeout', '2000']);
    expect(r.positional).toEqual(['fill', 'e2', 'hello world']);
    expect(r.target).toBe('b1');
    expect(r.timeoutMs).toBe(2000);
  });
});
