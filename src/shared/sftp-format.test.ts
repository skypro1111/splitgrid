import { describe, it, expect } from 'vitest';
import {
  formatSize,
  formatMtime,
  formatMode,
  joinRemote,
  parentRemote,
} from './sftp-format';

describe('formatSize', () => {
  it('formats zero and bytes', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(212)).toBe('212 B');
  });
  it('handles the KB boundary at 1024', () => {
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KB');
  });
  it('formats larger units with one decimal', () => {
    expect(formatSize(Math.round(4.1 * 1024))).toBe('4.1 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatSize(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
    expect(formatSize(2 * 1024 ** 4)).toBe('2.0 TB');
  });
});

describe('formatMtime', () => {
  // Fixed injected clock: 2026-06-09T12:00:00Z.
  const now = Date.UTC(2026, 5, 9, 12, 0, 0);
  const sec = (ms: number) => ms / 1000;

  it('shows "just now" within the last minute', () => {
    expect(formatMtime(sec(now - 30 * 1000), now)).toBe('just now');
  });
  it('shows minutes / hours / days for the last week', () => {
    expect(formatMtime(sec(now - 5 * 60 * 1000), now)).toBe('5m ago');
    expect(formatMtime(sec(now - 3 * 60 * 60 * 1000), now)).toBe('3h ago');
    expect(formatMtime(sec(now - 2 * 24 * 60 * 60 * 1000), now)).toBe('2d ago');
  });
  it('shows an absolute date beyond 7 days', () => {
    const old = Date.UTC(2025, 0, 15, 8, 0, 0); // 2025-01-15
    const result = formatMtime(sec(old), now);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatMode', () => {
  it('formats a regular file', () => {
    expect(formatMode(0o100644)).toBe('-rw-r--r--');
  });
  it('formats a directory', () => {
    expect(formatMode(0o40755)).toBe('drwxr-xr-x');
  });
  it('formats a symlink', () => {
    expect(formatMode(0o120777)).toBe('lrwxrwxrwx');
  });
  it('formats assorted permission bits', () => {
    expect(formatMode(0o100600)).toBe('-rw-------');
    expect(formatMode(0o40711)).toBe('drwx--x--x');
  });
});

describe('joinRemote', () => {
  it('joins under the root', () => {
    expect(joinRemote('/', 'etc')).toBe('/etc');
  });
  it('joins a nested dir', () => {
    expect(joinRemote('/home/user', 'file.txt')).toBe('/home/user/file.txt');
  });
  it('collapses a trailing slash on the dir', () => {
    expect(joinRemote('/home/user/', 'file.txt')).toBe('/home/user/file.txt');
  });
});

describe('parentRemote', () => {
  it('returns root for the root', () => {
    expect(parentRemote('/')).toBe('/');
  });
  it('returns root for a top-level dir', () => {
    expect(parentRemote('/etc')).toBe('/');
  });
  it('returns the parent of a nested path', () => {
    expect(parentRemote('/home/user/docs')).toBe('/home/user');
  });
  it('ignores a trailing slash', () => {
    expect(parentRemote('/home/user/')).toBe('/home');
  });
});
