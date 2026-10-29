import { describe, it, expect } from 'vitest';
import { firstLine, initials, relativeTime, shortSha, splitPath, statusLabel } from './format';

const at = (isoLike: string) => Math.floor(new Date(isoLike).getTime() / 1000);

describe('relativeTime', () => {
  const now = new Date('2026-09-08T12:00:00Z').getTime();

  it('scales the unit with the age', () => {
    expect(relativeTime(at('2026-09-08T11:59:30Z'), now)).toBe('just now');
    expect(relativeTime(at('2026-09-08T11:20:00Z'), now)).toBe('40m ago');
    expect(relativeTime(at('2026-09-08T04:00:00Z'), now)).toBe('8h ago');
    expect(relativeTime(at('2026-09-05T12:00:00Z'), now)).toBe('3d ago');
    expect(relativeTime(at('2026-08-20T12:00:00Z'), now)).toBe('2w ago');
    expect(relativeTime(at('2026-05-08T12:00:00Z'), now)).toBe('4mo ago');
  });

  it('falls back to an absolute date beyond a year', () => {
    // Locale-dependent formatting, so assert only that it stopped being relative.
    expect(relativeTime(at('2020-01-02T12:00:00Z'), now)).not.toMatch(/ago/);
  });

  it('treats a clock-skewed future commit as just now, not a negative age', () => {
    expect(relativeTime(at('2026-09-09T12:00:00Z'), now)).toBe('just now');
  });

  it('renders a missing date as empty', () => {
    expect(relativeTime(0, now)).toBe('');
  });
});

describe('splitPath', () => {
  it('separates directory from file name', () => {
    expect(splitPath('src/main/git-manager.ts')).toEqual({ dir: 'src/main', name: 'git-manager.ts' });
  });

  it('handles a bare file name and Windows separators', () => {
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
    expect(splitPath('src\\main\\a.ts')).toEqual({ dir: 'src/main', name: 'a.ts' });
  });
});

describe('initials', () => {
  it('takes the first and last name', () => {
    expect(initials('Sasha Kravchenko')).toBe('SK');
    expect(initials('madonna')).toBe('MA');
    expect(initials('  ')).toBe('?');
  });
});

describe('firstLine / shortSha / statusLabel', () => {
  it('cuts a message at the first newline', () => {
    expect(firstLine('subject\n\nbody')).toBe('subject');
    expect(firstLine('subject only')).toBe('subject only');
  });

  it('abbreviates a sha', () => {
    expect(shortSha('aa1d54646b03b7429aa37d729b239169e5f1609e')).toBe('aa1d546');
  });

  it('maps status letters to labels', () => {
    expect(statusLabel('A').title).toBe('Added');
    expect(statusLabel('R').title).toBe('Renamed');
    expect(statusLabel('?').title).toBe('Untracked');
    expect(statusLabel('').text).toBe('·');
  });
});
