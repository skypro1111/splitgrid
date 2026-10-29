import { describe, it, expect, beforeEach } from 'vitest';
import { scanOscNotify, clearOscNotify } from './osc-notify';

const T = 'term-1';

describe('scanOscNotify', () => {
  beforeEach(() => clearOscNotify(T));

  it('fires on notify OSCs (9 / 99 / 777)', () => {
    expect(scanOscNotify(T, 'x\x1b]9;done\x07')).toBe(true);
    expect(scanOscNotify(T, '\x1b]99;i=1;hello\x1b\\')).toBe(true);
    expect(scanOscNotify(T, '\x1b]777;notify;title;body\x07')).toBe(true);
    expect(scanOscNotify(T, '\x1b]9;5 tests passed\x07')).toBe(true);
  });

  it('ignores ConEmu / Windows Terminal progress (9;<digit>;…)', () => {
    expect(scanOscNotify(T, '\x1b]9;4;1;50\x07')).toBe(false);
    expect(scanOscNotify(T, '\x1b]9;4\x1b\\')).toBe(false);
  });

  it('does not fire on a progress OSC split right after `9;` or the digit', () => {
    for (const [a, b] of [
      ['out \x1b]9;', '4;1;50\x07'],
      ['out \x1b]9;4', ';1;50\x07'],
      ['out \x1b]9;4\x1b', '\\'],
    ]) {
      clearOscNotify(T);
      expect(scanOscNotify(T, a)).toBe(false);
      expect(scanOscNotify(T, b)).toBe(false);
    }
  });

  it('still catches a real notify split across chunks', () => {
    expect(scanOscNotify(T, 'out \x1b]9')).toBe(false);
    expect(scanOscNotify(T, ';done\x07')).toBe(true);
    // The hit clears the tail, so it can't re-trigger.
    expect(scanOscNotify(T, 'more output')).toBe(false);
  });
});
