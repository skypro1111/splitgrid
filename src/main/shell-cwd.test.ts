import { describe, expect, it } from 'vitest';
import { changedCwds, normalizeProcCwd, parseLsofCwd, pickSpawnCwd, readShellCwds } from './shell-cwd';

describe('parseLsofCwd', () => {
  it('maps each pid to its cwd name field', () => {
    const out = 'p101\nfcwd\nn/Users/me/project\np202\nfcwd\nn/private/tmp\n';
    expect(parseLsofCwd(out)).toEqual(
      new Map([
        [101, '/Users/me/project'],
        [202, '/private/tmp'],
      ]),
    );
  });

  it('keeps paths with spaces intact', () => {
    expect(parseLsofCwd('p7\nfcwd\nn/Users/me/My Drive/x y\n').get(7)).toBe('/Users/me/My Drive/x y');
  });

  it('ignores names before any pid, non-absolute names and duplicates', () => {
    const out = 'n/orphan\np5\nfcwd\nnnot-a-path\nn/first\nn/second\n';
    expect(parseLsofCwd(out)).toEqual(new Map([[5, '/first']]));
  });

  it('returns an empty map for empty output', () => {
    expect(parseLsofCwd('').size).toBe(0);
  });
});

describe('normalizeProcCwd', () => {
  it('drops a removed directory and non-absolute links', () => {
    expect(normalizeProcCwd('/home/me/x')).toBe('/home/me/x');
    expect(normalizeProcCwd('/home/me/gone (deleted)')).toBeNull();
    expect(normalizeProcCwd('relative')).toBeNull();
  });
});

describe('readShellCwds', () => {
  it('reports nothing on Windows and for no valid pids', async () => {
    expect((await readShellCwds([123], 'win32')).size).toBe(0);
    expect((await readShellCwds([0, -1, Number.NaN], 'darwin')).size).toBe(0);
  });
});

describe('changedCwds', () => {
  it('reports only sessions whose live cwd moved', () => {
    const byPid = new Map([
      [1, '/a'],
      [2, '/b-new'],
    ]);
    expect(
      changedCwds(
        [
          { id: 's1', pid: 1, cwd: '/a' },
          { id: 's2', pid: 2, cwd: '/b' },
          { id: 's3', pid: 3, cwd: '/c' }, // no live value: left alone
        ],
        byPid,
      ),
    ).toEqual([{ id: 's2', cwd: '/b-new' }]);
  });
});

describe('pickSpawnCwd', () => {
  const exists = (p: string) => p === '/exists' || p === '/fallback';
  it('takes the first existing candidate', () => {
    expect(pickSpawnCwd(['/exists', '/fallback'], '/home', exists)).toBe('/exists');
  });
  it('falls through a deleted folder to the next candidate, then home', () => {
    expect(pickSpawnCwd(['/deleted', '/fallback'], '/home', exists)).toBe('/fallback');
    expect(pickSpawnCwd(['/deleted', undefined], '/home', exists)).toBe('/home');
    expect(pickSpawnCwd([], '/home', exists)).toBe('/home');
  });
});
