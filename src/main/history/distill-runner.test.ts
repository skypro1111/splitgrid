import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ClaudeCliDistillRunner, distillArgs, distillEnv, type SpawnFn } from './distill-runner';
import { DISTILL_SCHEMA, DISTILL_SYSTEM_PROMPT } from './distill';

// No real claude is ever spawned here: every test injects a fake child process.

interface FakeChild {
  proc: ChildProcessWithoutNullStreams;
  stdin: string;
  killed: string[];
  /** Write stdout and exit with `code`. */
  finish(stdout: string, code?: number, stderr?: string): void;
}

function fakeSpawn(behaviour?: (c: FakeChild) => void) {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio; child: FakeChild }> = [];
  const spawn: SpawnFn = (command, args, options) => {
    const ee = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & EventEmitter;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fc: FakeChild = {
      proc: ee,
      stdin: '',
      killed: [],
      finish(out, code = 0, err = '') {
        if (err) stderr.write(err);
        stdout.end(out);
        stderr.end();
        setTimeout(() => ee.emit('close', code), 0);
      },
    };
    stdin.on('data', (d) => { fc.stdin += String(d); });
    Object.assign(ee, {
      stdin, stdout, stderr, pid: undefined,
      kill: (sig: string) => { fc.killed.push(sig); setTimeout(() => ee.emit('close', null), 0); return true; },
    });
    calls.push({ command, args, options, child: fc });
    if (behaviour) setTimeout(() => behaviour(fc), 0);
    return ee;
  };
  return { spawn, calls };
}

const result = (extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.002,
  usage: { input_tokens: 5000, output_tokens: 200 },
  structured_output: { notes: [{ kind: 'decision', title: 'T', why: 'W', files: [], sources: [1] }] },
  ...extra,
});

const runner = (spawn: SpawnFn, over: Partial<ConstructorParameters<typeof ClaudeCliDistillRunner>[0]> = {}) =>
  new ClaudeCliDistillRunner({ executable: () => '/usr/local/bin/claude', cwd: '/tmp/sg-distill-test', spawn, ...over });

const run = (r: ClaudeCliDistillRunner, signal = new AbortController().signal) =>
  r.run('<transcript>…</transcript>', { signal, validSeqs: new Set([1]) });

describe('distillArgs', () => {
  it('is a tool-less, persistence-less, settings-less one-shot Haiku run with a JSON schema', () => {
    const args = distillArgs();
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args[0]).toBe('-p');
    expect(flag('--model')).toBe('haiku');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
    expect(flag('--tools')).toBe('');
    expect(flag('--setting-sources')).toBe('');
    expect(flag('--output-format')).toBe('json');
    expect(JSON.parse(flag('--json-schema'))).toEqual(DISTILL_SCHEMA);
    expect(flag('--system-prompt')).toBe(DISTILL_SYSTEM_PROMPT);
    expect(Number(flag('--max-budget-usd'))).toBeGreaterThan(0);
    // --bare would require ANTHROPIC_API_KEY and break subscription logins.
    expect(args).not.toContain('--bare');
  });
});

describe('distillEnv', () => {
  it('strips SPLITGRID_* and the in-session markers, keeps the rest', () => {
    const env = distillEnv({
      PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c',
      SPLITGRID_HISTORY_TOKEN: 't', SPLITGRID_TERMINAL_ID: 'x', splitgrid_lower: 'y',
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c' });
  });
});

describe('ClaudeCliDistillRunner', () => {
  it('spawns the resolved binary in the distill dir with the stripped env and the transcript on stdin', async () => {
    const { spawn, calls } = fakeSpawn((c) => c.finish(result()));
    const r = runner(spawn, { env: () => ({ PATH: '/bin', SPLITGRID_AGENT_TOKEN: 'secret' }) });
    const out = await run(r);
    expect(out).toMatchObject({ ok: true, notes: [{ title: 'T', sources: [1] }], usage: { costUsd: 0.002, inputTokens: 5000 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/usr/local/bin/claude');
    expect(calls[0].args).toEqual(distillArgs());
    expect(calls[0].options.cwd).toBe('/tmp/sg-distill-test');
    expect(calls[0].options.env).toEqual({ PATH: '/bin' });
    expect(calls[0].child.stdin).toBe('<transcript>…</transcript>');
  });

  it('runs a cli.js entry with Electron\'s own Node', async () => {
    const { spawn, calls } = fakeSpawn((c) => c.finish(result()));
    await run(runner(spawn, { executable: () => 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', env: () => ({}) }));
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args[0]).toMatch(/cli\.js$/);
    expect(calls[0].options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('reports a missing Claude Code without spawning', async () => {
    const { spawn, calls } = fakeSpawn();
    const out = await run(runner(spawn, { executable: () => null }));
    expect(out).toMatchObject({ ok: false, inputSpecific: false, error: expect.stringContaining('not found') });
    expect(calls).toHaveLength(0);
  });

  it('kills the run on abort and reports it as aborted, not as a failure', async () => {
    const { spawn, calls } = fakeSpawn(); // never finishes on its own
    const abort = new AbortController();
    const p = run(runner(spawn), abort.signal);
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    expect(await p).toMatchObject({ ok: false, aborted: true });
    expect(calls[0].child.killed).toContain('SIGTERM');
  });

  it('does not spawn at all when already aborted', async () => {
    const { spawn, calls } = fakeSpawn();
    const abort = new AbortController();
    abort.abort();
    expect(await run(runner(spawn), abort.signal)).toMatchObject({ ok: false, aborted: true });
    expect(calls).toHaveLength(0);
  });

  it('times out, kills, and counts it against the input', async () => {
    const { spawn, calls } = fakeSpawn();
    const out = await run(runner(spawn, { timeoutMs: 20 }));
    expect(out).toMatchObject({ ok: false, inputSpecific: true, error: expect.stringContaining('timed out') });
    expect(calls[0].child.killed).toContain('SIGTERM');
  });

  it('passes is_error and malformed results through the parser', async () => {
    const limit = fakeSpawn((c) => c.finish(result({ is_error: true, result: 'Claude AI usage limit reached', structured_output: undefined }), 1));
    expect(await run(runner(limit.spawn))).toMatchObject({ ok: false, inputSpecific: false, error: expect.stringContaining('usage limit') });
    const bad = fakeSpawn((c) => c.finish(result({ structured_output: { nope: true } })));
    expect(await run(runner(bad.spawn))).toMatchObject({ ok: false, inputSpecific: true, usage: { costUsd: 0.002 } });
  });

  it('turns an exit with no output into a readable error from stderr', async () => {
    const { spawn } = fakeSpawn((c) => c.finish('', 1, 'line1\nInvalid API key · Please run /login\n'));
    expect(await run(runner(spawn))).toMatchObject({ ok: false, inputSpecific: false, error: expect.stringMatching(/exited \(1\).*Invalid API key/) });
  });
});
