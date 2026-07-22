import { describe, it, expect } from 'vitest';
import { resolveAgentLocalPath, resolveAgentRemotePath, remoteBasename, isAbsoluteLocal } from './agent-sftp-paths';

describe('resolveAgentLocalPath (POSIX)', () => {
  const root = '/Users/me/project';

  it('joins a relative path to the workspace root', () => {
    expect(resolveAgentLocalPath(root, 'dist/app.js', '/')).toBe('/Users/me/project/dist/app.js');
    expect(resolveAgentLocalPath(root, './a/./b', '/')).toBe('/Users/me/project/a/b');
  });

  it('accepts an absolute path already inside the root', () => {
    expect(resolveAgentLocalPath(root, '/Users/me/project/src/x.ts', '/')).toBe('/Users/me/project/src/x.ts');
  });

  it('refuses anything that escapes the root', () => {
    expect(resolveAgentLocalPath(root, '../../.ssh/id_rsa', '/')).toBeNull();
    expect(resolveAgentLocalPath(root, '/etc/passwd', '/')).toBeNull();
    expect(resolveAgentLocalPath(root, '/Users/me/project-other/x', '/')).toBeNull();
  });

  it('refuses when the workspace has no root, and on NUL bytes', () => {
    expect(resolveAgentLocalPath(null, 'a.txt', '/')).toBeNull();
    expect(resolveAgentLocalPath(root, 'a\0b', '/')).toBeNull();
  });

  it('normalizes back inside the root without escaping', () => {
    expect(resolveAgentLocalPath(root, 'src/../dist/x', '/')).toBe('/Users/me/project/dist/x');
  });
});

describe('resolveAgentLocalPath (Windows)', () => {
  const root = 'C:\\Users\\me\\project';

  it('joins relative paths and keeps the drive', () => {
    expect(resolveAgentLocalPath(root, 'dist\\app.js', '\\')).toBe('C:\\Users\\me\\project\\dist\\app.js');
    expect(resolveAgentLocalPath(root, 'dist/app.js', '\\')).toBe('C:\\Users\\me\\project\\dist\\app.js');
  });

  it('compares the drive letter case-insensitively', () => {
    expect(resolveAgentLocalPath(root, 'c:\\Users\\me\\project\\a', '\\')).toBe('C:\\Users\\me\\project\\a');
  });

  it('refuses escapes and other drives', () => {
    expect(resolveAgentLocalPath(root, '..\\..\\.ssh\\id_rsa', '\\')).toBeNull();
    expect(resolveAgentLocalPath(root, 'D:\\secrets', '\\')).toBeNull();
  });
});

describe('resolveAgentRemotePath', () => {
  it('confines to the sync target root', () => {
    expect(resolveAgentRemotePath('/srv/app', 'public/x.js')).toBe('/srv/app/public/x.js');
    expect(resolveAgentRemotePath('/srv/app', '/srv/app/x')).toBe('/srv/app/x');
    expect(resolveAgentRemotePath('/srv/app', '../../etc/passwd')).toBeNull();
    expect(resolveAgentRemotePath('/srv/app', '/etc/passwd')).toBeNull();
  });

  it('without a root (SSH pane) takes absolute or ~ paths only', () => {
    expect(resolveAgentRemotePath(null, '/var/log/app.log')).toBe('/var/log/app.log');
    expect(resolveAgentRemotePath(null, '~/deploy')).toBe('~/deploy');
    expect(resolveAgentRemotePath(null, 'relative/path')).toBeNull();
  });
});

describe('helpers', () => {
  it('remoteBasename takes the last segment', () => {
    expect(remoteBasename('/srv/app/x.js')).toBe('x.js');
    expect(remoteBasename('/')).toBe('');
  });

  it('isAbsoluteLocal knows both conventions', () => {
    expect(isAbsoluteLocal('/x', '/')).toBe(true);
    expect(isAbsoluteLocal('x', '/')).toBe(false);
    expect(isAbsoluteLocal('C:\\x', '\\')).toBe(true);
    expect(isAbsoluteLocal('\\\\srv\\share', '\\')).toBe(true);
    expect(isAbsoluteLocal('x\\y', '\\')).toBe(false);
  });
});
