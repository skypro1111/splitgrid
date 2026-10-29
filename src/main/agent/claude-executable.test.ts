import { describe, expect, it } from 'vitest';
import { expandHome, makeClaudeEnv, resolveClaudeExecutable } from './claude-executable';

function probeFor(files: string[]) {
  const set = new Set(files);
  return { isFile: (filePath: string) => set.has(filePath) };
}

describe('resolveClaudeExecutable', () => {
  it('finds claude on PATH', () => {
    const resolved = resolveClaudeExecutable({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/opt/homebrew/bin' },
      home: '/Users/me',
      probe: probeFor(['/opt/homebrew/bin/claude']),
    });
    expect(resolved).toBe('/opt/homebrew/bin/claude');
  });

  it('falls back to the usual install locations', () => {
    const resolved = resolveClaudeExecutable({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      home: '/Users/me',
      probe: probeFor(['/Users/me/.local/bin/claude']),
    });
    expect(resolved).toBe('/Users/me/.local/bin/claude');
  });

  it('returns null when Claude Code is not installed', () => {
    const resolved = resolveClaudeExecutable({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      home: '/Users/me',
      probe: probeFor([]),
    });
    expect(resolved).toBeNull();
  });

  it('honours a configured absolute path and expands ~', () => {
    const resolved = resolveClaudeExecutable({
      configured: '~/bin/claude',
      platform: 'darwin',
      env: {},
      home: '/Users/me',
      probe: probeFor(['/Users/me/bin/claude']),
    });
    expect(resolved).toBe('/Users/me/bin/claude');
  });

  it('rejects a configured path that does not exist rather than silently guessing', () => {
    const resolved = resolveClaudeExecutable({
      configured: '/opt/claude',
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      home: '/Users/me',
      probe: probeFor(['/usr/bin/claude']),
    });
    expect(resolved).toBeNull();
  });

  it('follows a Windows npm shim to the package entry the SDK can spawn', () => {
    const shim = 'C:\\npm\\claude.cmd';
    const entry = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const resolved = resolveClaudeExecutable({
      platform: 'win32',
      env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD' },
      home: 'C:\\Users\\me',
      probe: probeFor([shim, entry]),
    });
    expect(resolved).toBe(entry);
  });

  it('prefers a real Windows executable over a shim', () => {
    const exe = 'C:\\npm\\claude.exe';
    const resolved = resolveClaudeExecutable({
      platform: 'win32',
      env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD' },
      home: 'C:\\Users\\me',
      probe: probeFor([exe, 'C:\\npm\\claude.cmd']),
    });
    expect(resolved).toBe(exe);
  });
});

describe('makeClaudeEnv', () => {
  it('adds no config dir when none is configured', () => {
    const env = makeClaudeEnv(undefined, { PATH: '/usr/bin' }, '/Users/me', 'darwin');
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('isolates a pane via CLAUDE_CONFIG_DIR, never HOME', () => {
    const env = makeClaudeEnv('~/.claude_work', { HOME: '/Users/me' }, '/Users/me', 'darwin');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/me/.claude_work');
    expect(env.HOME).toBe('/Users/me');
  });

  it('widens the bare GUI PATH so the agent can find its tools', () => {
    const env = makeClaudeEnv(undefined, { PATH: '/usr/bin:/bin' }, '/Users/me', 'darwin');
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(env.PATH).toContain('/Users/me/.local/bin');
    expect(env.PATH?.startsWith('/usr/bin:/bin')).toBe(true);
  });

  it('does not duplicate a path the shell already exported', () => {
    const env = makeClaudeEnv(undefined, { PATH: '/opt/homebrew/bin:/usr/bin' }, '/Users/me', 'darwin');
    expect(env.PATH?.match(/\/opt\/homebrew\/bin/g)).toHaveLength(1);
  });

  it('leaves Windows PATH alone', () => {
    const env = makeClaudeEnv(undefined, { PATH: 'C:\\bin' }, 'C:\\Users\\me', 'win32');
    expect(env.PATH).toBe('C:\\bin');
  });
});

describe('expandHome', () => {
  it('expands a leading tilde only', () => {
    expect(expandHome('~', '/Users/me')).toBe('/Users/me');
    expect(expandHome('~/x', '/Users/me')).toBe('/Users/me/x');
    expect(expandHome('/abs/~', '/Users/me')).toBe('/abs/~');
  });
});
