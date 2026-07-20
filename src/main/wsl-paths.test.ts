import { describe, it, expect } from 'vitest';
import { winPathToWsl } from './wsl-paths';

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
