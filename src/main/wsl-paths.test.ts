import { describe, it, expect } from 'vitest';
import { winPathToWsl, wslPathToWin } from './wsl-paths';

describe('winPathToWsl', () => {
  it('translates a backslash Windows path', () => {
    expect(winPathToWsl('C:\\Users\\me\\splitgrid')).toBe('/mnt/c/Users/me/splitgrid');
  });
  it('translates a forward-slash Windows path', () => {
    expect(winPathToWsl('D:/x/y')).toBe('/mnt/d/x/y');
  });
  it('lowercases the drive letter', () => {
    expect(winPathToWsl('E:\\Foo')).toBe('/mnt/e/Foo');
  });
  it('converts all backslashes in the tail to forward slashes', () => {
    expect(winPathToWsl('C:\\a\\b\\c.png')).toBe('/mnt/c/a/b/c.png');
  });
  it('returns null for a non-drive (already POSIX) path', () => {
    expect(winPathToWsl('/already/posix')).toBeNull();
  });
  it('returns null for a relative path', () => {
    expect(winPathToWsl('relative/path')).toBeNull();
  });
  it('returns null for a UNC path', () => {
    expect(winPathToWsl('\\\\server\\share\\f')).toBeNull();
  });
});

describe('wslPathToWin', () => {
  it('translates a /mnt/<drive> path to a backslash Windows path', () => {
    expect(wslPathToWin('/mnt/c/Users/me/project')).toBe('C:\\Users\\me\\project');
  });
  it('uppercases the drive letter', () => {
    expect(wslPathToWin('/mnt/d/x')).toBe('D:\\x');
  });
  it('translates a bare drive mount to the drive root', () => {
    expect(wslPathToWin('/mnt/c')).toBe('C:\\');
  });
  it('round-trips with winPathToWsl', () => {
    expect(wslPathToWin(winPathToWsl('E:\\a\\b.ts') as string)).toBe('E:\\a\\b.ts');
  });
  it('returns null for a distro-native path', () => {
    expect(wslPathToWin('/home/me/project')).toBeNull();
  });
  it('returns null for a relative path', () => {
    expect(wslPathToWin('mnt/c/x')).toBeNull();
  });
});
