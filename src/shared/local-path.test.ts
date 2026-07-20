import { describe, it, expect } from 'vitest';
import { isLocalRoot, joinLocal, parentLocal, pathCrumbs } from './local-path';

describe('isLocalRoot', () => {
  it('POSIX: only "/" (and "") are root', () => {
    expect(isLocalRoot('/', '/')).toBe(true);
    expect(isLocalRoot('', '/')).toBe(true);
    expect(isLocalRoot('/Users', '/')).toBe(false);
  });
  it('Windows: drive roots and bare backslash are root', () => {
    expect(isLocalRoot('C:\\', '\\')).toBe(true);
    expect(isLocalRoot('C:', '\\')).toBe(true);
    expect(isLocalRoot('\\', '\\')).toBe(true);
    expect(isLocalRoot('C:\\Users', '\\')).toBe(false);
  });
});

describe('joinLocal', () => {
  it('POSIX joins and collapses trailing slashes', () => {
    expect(joinLocal('/', 'usr', '/')).toBe('/usr');
    expect(joinLocal('/usr', 'local', '/')).toBe('/usr/local');
    expect(joinLocal('/usr///', 'local', '/')).toBe('/usr/local');
  });
  it('Windows joins from drive roots and nested dirs', () => {
    expect(joinLocal('C:\\', 'Users', '\\')).toBe('C:\\Users');
    expect(joinLocal('C:\\Users', 'foo', '\\')).toBe('C:\\Users\\foo');
    expect(joinLocal('C:\\Users\\\\', 'foo', '\\')).toBe('C:\\Users\\foo');
  });
});

describe('parentLocal', () => {
  it('POSIX walks up to the root and stays there', () => {
    expect(parentLocal('/usr/local', '/')).toBe('/usr');
    expect(parentLocal('/usr', '/')).toBe('/');
    expect(parentLocal('/usr/', '/')).toBe('/');
    expect(parentLocal('/', '/')).toBe('/');
  });
  it('Windows walks up to the drive root and stays there', () => {
    expect(parentLocal('C:\\Users\\foo', '\\')).toBe('C:\\Users');
    expect(parentLocal('C:\\Users', '\\')).toBe('C:\\');
    expect(parentLocal('C:\\', '\\')).toBe('C:\\');
  });
});

describe('pathCrumbs', () => {
  it('POSIX crumbs start at "/" and accumulate segments', () => {
    expect(pathCrumbs('/', '/')).toEqual([{ label: '/', path: '/' }]);
    expect(pathCrumbs('/usr/local', '/')).toEqual([
      { label: '/', path: '/' },
      { label: 'usr', path: '/usr' },
      { label: 'local', path: '/usr/local' },
    ]);
  });
  it('Windows crumbs start at the drive root', () => {
    expect(pathCrumbs('C:\\Users\\foo', '\\')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'foo', path: 'C:\\Users\\foo' },
    ]);
    expect(pathCrumbs('C:\\', '\\')).toEqual([{ label: 'C:', path: 'C:\\' }]);
  });
});
