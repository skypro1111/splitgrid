import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import { DISTILL_SCHEMA, DISTILL_SYSTEM_PROMPT, parseDistillOutput, type DistillRunResult } from './distill';

// ─── Workspace history: Claude Code headless runner for distillation ─────────
// Runs ONE group through `claude -p` with Haiku and returns validated notes.
// Why the CLI rather than an API client: it reuses whatever login the user
// already has. On a subscription that costs plan limits rather than money;
// with an API key it is billed at API rates — the Settings estimate says so
// before anything runs. `--bare` would be leaner but requires ANTHROPIC_API_KEY
// and would break every subscription user, so it is not used.
//
// The flags make each run an isolated, tool-less, one-shot completion:
//   --no-session-persistence  nothing lands in ~/.claude/projects — otherwise
//                             the indexer would index its own distillation runs
//   --tools ""                no tools: the transcript is untrusted text and
//                             must not be able to make the model DO anything
//   --strict-mcp-config       no MCP servers (none are passed)
//   --setting-sources ""      no user/project settings, so none of the user's
//                             hooks (incl. SplitGrid's activity hooks), plugins
//                             or CLAUDE.md files ride along
//   --max-budget-usd          a hard per-run ceiling far above a normal group's
//                             cost, so a retry loop inside the CLI can't run away
// It also runs with cwd = <userData>/history/distill (outside every workspace
// folder, so no project context is discovered) and without SPLITGRID_* env (so
// the run is not mistaken for an agent in a SplitGrid terminal).

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** Far above one group's cost (~$0.01 at 60k tokens); only a runaway hits it. */
const RUN_BUDGET_USD = 0.25;
const KILL_GRACE_MS = 3_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface DistillRunner {
  run(input: string, opts: { signal: AbortSignal; validSeqs: ReadonlySet<number> }): Promise<DistillRunResult>;
}

/** argv after the executable. Exported for tests. */
export function distillArgs(): string[] {
  return [
    '-p',
    '--model', 'haiku',
    '--no-session-persistence',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(DISTILL_SCHEMA),
    '--max-budget-usd', String(RUN_BUDGET_USD),
    '--system-prompt', DISTILL_SYSTEM_PROMPT,
  ];
}

/**
 * The run's environment: the app's own, minus every SPLITGRID_* variable (agent
 * tokens, bridge ports, the history CLI) and the markers Claude Code sets for a
 * process running inside a session (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT) — the
 * app may itself have been started from a terminal running Claude Code.
 */
export function distillEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (/^SPLITGRID_/i.test(k) || k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT') continue;
    env[k] = v;
  }
  return env;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface ClaudeCliRunnerOptions {
  /** Resolved claude executable (see agent/claude-executable.ts), or null when not installed. */
  executable: () => string | null;
  /** Working directory for the run; created on first use. */
  cwd: string;
  /** Base environment (already PATH-augmented by the caller). */
  env?: () => NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Injected in tests. */
  spawn?: SpawnFn;
  log?: (msg: string) => void;
}

export class ClaudeCliDistillRunner implements DistillRunner {
  constructor(private readonly opts: ClaudeCliRunnerOptions) {}

  run(input: string, { signal, validSeqs }: { signal: AbortSignal; validSeqs: ReadonlySet<number> }): Promise<DistillRunResult> {
    if (signal.aborted) return Promise.resolve({ ok: false, error: 'stopped', inputSpecific: false, aborted: true });
    const exe = this.opts.executable();
    if (!exe) {
      return Promise.resolve({
        ok: false, inputSpecific: false,
        error: 'Claude Code was not found. Install it or set its path under Settings → Claude Code pane.',
      });
    }
    try { mkdirSync(this.opts.cwd, { recursive: true }); } catch { /* spawn reports a bad cwd */ }

    let env = distillEnv(this.opts.env?.() ?? process.env);
    let command = exe;
    let args = distillArgs();
    // A Windows npm install resolves to the package's cli.js, which can't be
    // spawned directly; run it with Electron's own Node.
    if (/\.(c|m)?js$/i.test(exe)) {
      command = process.execPath;
      args = [exe, ...args];
      env = { ...env, ELECTRON_RUN_AS_NODE: '1' };
    }

    return new Promise<DistillRunResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = (this.opts.spawn ?? (nodeSpawn as unknown as SpawnFn))(command, args, {
          cwd: this.opts.cwd, env, windowsHide: true,
        });
      } catch (err) {
        resolve({ ok: false, inputSpecific: false, error: `could not start Claude Code: ${(err as Error).message}` });
        return;
      }
      // Background work: never compete with the user's foreground apps.
      if (child.pid) {
        try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
      }

      let stdout = '';
      let stdoutBytes = 0;
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const kill = () => {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        killTimer ??= setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
        killTimer.unref?.();
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => kill();
      signal.addEventListener('abort', onAbort, { once: true });

      const finish = (result: DistillRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        stdoutBytes += Buffer.byteLength(d);
        if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += d;
        else kill();
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => { if (stderr.length < MAX_STDERR_BYTES) stderr += d; });
      child.on('error', (err) => {
        finish({ ok: false, inputSpecific: false, error: `could not start Claude Code: ${err.message}` });
      });
      child.on('close', (code) => {
        if (killTimer) clearTimeout(killTimer);
        if (signal.aborted) { finish({ ok: false, error: 'stopped', inputSpecific: false, aborted: true }); return; }
        if (timedOut) { finish({ ok: false, error: 'Claude Code timed out', inputSpecific: true }); return; }
        const result = parseDistillOutput(stdout, validSeqs);
        if (!result.ok && !stdout.trim()) {
          const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
          finish({ ok: false, inputSpecific: false, error: `Claude Code exited (${code ?? 'signal'})${tail ? `: ${tail}` : ''}` });
          return;
        }
        finish(result);
      });
      child.stdin.on('error', () => { /* exited before reading everything; close reports it */ });
      child.stdin.end(input);
    });
  }
}
