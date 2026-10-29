import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Locating the `claude` binary the Agent SDK should spawn.
//
// The SDK spawns `pathToClaudeCodeExecutable` directly — no shell, no PATH
// lookup, no PATHEXT. So a bare "claude" only works if it happens to be an
// absolute path, and on Windows an npm launcher shim (claude.cmd) can't be
// spawned at all (`spawn EINVAL` since Node 20.12). We resolve the real file
// here, following Windows shims to the package entry the SDK can run.

/** Injected so tests can run against a fake filesystem. */
export interface ExecutableProbe {
  isFile(filePath: string): boolean;
}

const realProbe: ExecutableProbe = {
  isFile: (filePath) => {
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  },
};

/** Launcher scripts Node can't spawn without a shell. */
const WINDOWS_SHIM_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);

/** Entries of the npm @anthropic-ai/claude-code package, relative to the shim dir. */
const NPM_PACKAGE_ENTRIES = [
  ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
  ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'],
];

/** Install locations to try when `claude` isn't on PATH. */
function fallbackLocations(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') {
    return [
      path.win32.join(home, '.local', 'bin', 'claude.exe'),
      path.win32.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
    ];
  }
  return [
    path.posix.join(home, '.local', 'bin', 'claude'),
    path.posix.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
}

/** The path flavour to use — tests run Windows cases on a POSIX host. */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Expand a leading `~` against the given home directory. */
export function expandHome(input: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return pathFor(platform).join(home, input.slice(2));
  }
  return input;
}

/** Walk PATH (and PATHEXT on Windows) looking for `command`. */
function lookupOnPath(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  probe: ExecutableProbe,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? '';
  if (!pathValue) return null;
  const sep = platform === 'win32' ? ';' : ':';
  const exts =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  const join = pathFor(platform).join;
  for (const dir of pathValue.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase());
      if (probe.isFile(candidate)) return candidate;
      if (ext) {
        const upper = join(dir, command + ext);
        if (probe.isFile(upper)) return upper;
      }
    }
  }
  return null;
}

/**
 * On Windows, follow an npm launcher shim (`claude.cmd`) to the package entry
 * the SDK can spawn. Returns the input unchanged elsewhere.
 */
function followWindowsShim(resolved: string, probe: ExecutableProbe): string {
  const ext = path.win32.extname(resolved).toLowerCase();
  if (!WINDOWS_SHIM_EXTENSIONS.has(ext)) return resolved;
  const shimDir = path.win32.dirname(resolved);
  for (const segments of NPM_PACKAGE_ENTRIES) {
    const candidate = path.win32.join(shimDir, ...segments);
    if (probe.isFile(candidate)) return candidate;
  }
  return resolved;
}

export interface ResolveClaudeExecutableInput {
  /** User-configured binary path (may be empty, `~`-relative, or a bare name). */
  configured?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  probe?: ExecutableProbe;
}

/**
 * Resolve an absolute, directly-spawnable path to Claude Code, or null when it
 * isn't installed (the caller surfaces "install Claude Code" in the pane).
 */
export function resolveClaudeExecutable(input: ResolveClaudeExecutableInput = {}): string | null {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const probe = input.probe ?? realProbe;

  const configured = (input.configured ?? '').trim();
  if (configured) {
    const expanded = expandHome(configured, home, platform);
    // An explicit path wins as long as it exists; a bare name still needs PATH.
    if (pathFor(platform).isAbsolute(expanded)) {
      return probe.isFile(expanded)
        ? platform === 'win32'
          ? followWindowsShim(expanded, probe)
          : expanded
        : null;
    }
    const onPath = lookupOnPath(expanded, platform, env, probe);
    if (onPath) return platform === 'win32' ? followWindowsShim(onPath, probe) : onPath;
    return null;
  }

  const onPath = lookupOnPath('claude', platform, env, probe);
  if (onPath) return platform === 'win32' ? followWindowsShim(onPath, probe) : onPath;

  for (const candidate of fallbackLocations(platform, home)) {
    if (probe.isFile(candidate)) {
      return platform === 'win32' ? followWindowsShim(candidate, probe) : candidate;
    }
  }
  return null;
}

/**
 * Environment for a session. `configDir` isolates a pane to its own Claude
 * config (separate account/settings) via CLAUDE_CONFIG_DIR — never via HOME,
 * which would also move the macOS keychain lookup and break the stored login.
 */
export function makeClaudeEnv(
  configDir: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PATH: augmentedPath(base, home, platform) };
  const dir = (configDir ?? '').trim();
  if (dir) env.CLAUDE_CONFIG_DIR = path.resolve(expandHome(dir, home, platform));
  return env;
}

/**
 * A GUI-launched Electron app inherits a bare PATH (`/usr/bin:/bin:…`), not the
 * user's shell PATH. The CLI passes its env straight to the Bash tool, so
 * without this the agent cannot find git, node, rg or anything else installed
 * by homebrew or a version manager. Mirrors what local-shell-manager does for
 * terminals, which get the rest via a login shell.
 */
function augmentedPath(base: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string {
  const current = base.PATH ?? base.Path ?? '';
  if (platform === 'win32') return current;
  const extra = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(home, '.cargo', 'bin'),
    path.posix.join(home, '.bun', 'bin'),
  ].filter((entry) => !current.split(':').includes(entry));
  return extra.length > 0 ? `${current}:${extra.join(':')}` : current;
}

/** Exposed for tests that need the real filesystem probe. */
export const defaultExecutableProbe = realProbe;
