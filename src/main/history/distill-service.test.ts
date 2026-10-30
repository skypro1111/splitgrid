import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The service module imports electron only for the userData path in
// getHistoryService(); these tests build the service directly.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { WorkspaceHistoryService, claudeProjectSlug, type RuntimeLike } from './service';
import { HistoryIndexer } from './indexer';
import {
  DISTILL_OUTPUT_TOKENS_PER_GROUP, DISTILL_PROMPT_OVERHEAD_TOKENS, DISTILL_SETTLE_MS, callCostUsd, tokensForChars,
  type DistillRunResult,
} from './distill';
import type { DistillRunner } from './distill-runner';
import { HISTORY_EMBED_DIM } from './types';

// All fixtures are synthetic. Never paste real transcript content here.
// Decision notes end to end through the service, with a fake runner: no
// claude process is ever started.

let clock = Date.parse('2026-03-01T00:00:00.000Z');
function line(type: 'user' | 'assistant', text: string, cwd: string, sessionId: string): string {
  clock += 1000;
  const message = type === 'user'
    ? { role: 'user', content: text }
    : { role: 'assistant', content: [{ type: 'text', text }] };
  return `${JSON.stringify({ type, message, cwd, sessionId, timestamp: new Date(clock).toISOString(), uuid: `u${clock}` })}\n`;
}
const turn = (prompt: string, answer: string, cwd: string, sid: string) =>
  line('user', prompt, cwd, sid) + line('assistant', answer, cwd, sid);

function fakeVector(text: string): Float32Array {
  const v = new Float32Array(HISTORY_EMBED_DIM);
  for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % HISTORY_EMBED_DIM] += 1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function fakeRuntime(): RuntimeLike {
  let installed = false;
  return {
    isSupported: () => true,
    isInstalled: () => installed,
    downloadBytes: () => 1000,
    install: async () => { installed = true; },
    uninstall: async () => { installed = false; },
    stop: async () => {},
    embed: async (texts: string[]) => texts.map(fakeVector),
  };
}

/** Records every run; by default answers with one decision citing the first seq it was shown. */
function fakeRunner(answer?: (input: string, call: number) => DistillRunResult | Promise<DistillRunResult>) {
  const inputs: string[] = [];
  const runner: DistillRunner & { inputs: string[] } = {
    inputs,
    run: async (input, { validSeqs, signal }) => {
      inputs.push(input);
      if (answer) return answer(input, inputs.length);
      if (signal.aborted) return { ok: false, error: 'stopped', inputSpecific: false, aborted: true };
      const seq = [...validSeqs][0];
      return {
        ok: true,
        notes: [{ kind: 'decision', title: `Chose the ${input.includes('alpha') ? 'alpha' : 'other'} approach`, why: 'Because of the tests.', files: [], sources: [seq] }],
        usage: { costUsd: 0.001, inputTokens: 1000, outputTokens: 50 },
      };
    },
  };
  return runner;
}

let root: string;
let projects: string;
const WS_A = '/work/alpha';
const WS_B = '/work/beta';
let workspaceList: Array<{ id: string; workingDirectory: string | null }>;
let now: number;

const file = (ws: string, sid: string) => path.join(projects, claudeProjectSlug(ws), `${sid}.jsonl`);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sg-distill-'));
  projects = path.join(root, 'projects');
  await mkdir(path.join(projects, claudeProjectSlug(WS_A)), { recursive: true });
  await mkdir(path.join(projects, claudeProjectSlug(WS_B)), { recursive: true });
  await writeFile(file(WS_A, 's-alpha'), turn('alpha: how should the settings file be written', 'Atomically, via rename.', WS_A, 's-alpha'));
  await writeFile(file(WS_B, 's-beta'), turn('beta: plan the invoices migration please', 'Added the invoices migration.', WS_B, 's-beta'));
  workspaceList = [{ id: 'ws-a', workingDirectory: WS_A }, { id: 'ws-b', workingDirectory: WS_B }];
  now = clock + DISTILL_SETTLE_MS * 10; // every fixture session has settled
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function make(runner = fakeRunner()) {
  const service = new WorkspaceHistoryService({
    rootDir: path.join(root, 'history'),
    projectsDir: projects,
    workspaces: () => workspaceList,
    runtime: fakeRuntime(),
    distillRunner: runner,
    now: () => now,
    log: () => {},
  });
  return { service, runner };
}

async function enabled(service: WorkspaceHistoryService) {
  await service.enable();
  await vi.waitFor(() => expect(service.getStatus().progress.state).toBe('idle'));
}

const distill = (s: WorkspaceHistoryService) => s.getStatus().distill!;

describe('decision notes: consent and scheduling', () => {
  it('is off by default: indexing never runs the model', async () => {
    const { service, runner } = make();
    await enabled(service);
    await vi.waitFor(() => expect(distill(service).groupsPending).toBe(2));
    expect(distill(service)).toMatchObject({ enabled: false, state: 'off' });
    expect(runner.inputs).toHaveLength(0);
    await service.disable({ deleteData: false });
  });

  it('estimates the backlog and monthly cost from the DB without running anything', async () => {
    const { service, runner } = make();
    await enabled(service);
    const est = await service.distillEstimate();
    expect(runner.inputs).toHaveLength(0);
    expect(est.pendingGroups).toBe(2);
    expect(est.pendingOutputTokens).toBe(2 * DISTILL_OUTPUT_TOKENS_PER_GROUP);
    // Every pending group costs its own call; the overhead is per call.
    const ix = new HistoryIndexer({ projectsDir: projects, dataDir: path.join(root, 'history', 'db'), workspaces: () => workspaceList, embedder: fakeRuntime() });
    const charsPerGroup = ['ws-a', 'ws-b'].map((id) => ix.store(id)!.distillCandidates()[0].chunks.reduce((n, c) => n + c.chars + 10, 0));
    ix.close();
    const inputs = charsPerGroup.map((c) => tokensForChars(c) + DISTILL_PROMPT_OVERHEAD_TOKENS);
    expect(est.pendingInputTokens).toBe(inputs[0] + inputs[1]);
    expect(est.backlogUsd).toBeCloseTo(inputs.reduce((sum, t) => sum + callCostUsd(t, DISTILL_OUTPUT_TOKENS_PER_GROUP), 0), 10);
    expect(est.priceInputPerMTok).toBe(0.1);
    expect(est.priceOutputPerMTok).toBe(0.5);
    // Both fixture sessions are within the last 30 days of `now`.
    expect(est.monthlyGroups).toBe(2);
    expect(est.monthlyUsd).toBeGreaterThan(0);
    expect(est.spentUsd).toBe(0);

    now += 60 * 86_400_000; // two months later: nothing is "recent" any more
    expect((await service.distillEstimate()).monthlyGroups).toBe(0);
    await service.disable({ deleteData: false });
  });

  it('distills each settled group once, stores searchable notes, and adds up the cost', async () => {
    const { service, runner } = make();
    await enabled(service);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(distill(service)).toMatchObject({ state: 'idle', groupsDistilled: 2, groupsPending: 0, notes: 2 }));
    expect(runner.inputs).toHaveLength(2);
    expect(runner.inputs[0]).toMatch(/\[#0\]\nUser: /);
    expect(distill(service).spentUsd).toBeCloseTo(0.002);

    const hits = await service.search('ws-a', 'Chose the alpha approach');
    expect(hits[0]).toMatchObject({ kind: 'decision', chunkId: 's-alpha:n0.0', note: { kind: 'decision', sources: ['s-alpha:0'] } });
    expect(await service.showChunk('ws-a', 's-alpha:n0.0')).toEqual([expect.objectContaining({ chunkId: 's-alpha:n0.0' })]);
    expect((await service.listSessions('ws-a'))[0].chunks).toBe(1);

    // Same input → never paid for twice.
    service.setDistillEnabled(false);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(distill(service).state).toBe('idle'));
    expect(runner.inputs).toHaveLength(2);
    await service.disable({ deleteData: false });
  });

  it('re-distills only a group whose input changed, and only once its session settled again', async () => {
    const { service, runner } = make();
    await enabled(service);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(distill(service).groupsDistilled).toBe(2));

    await appendFile(file(WS_A, 's-alpha'), turn('alpha: and also make the writes fsync', 'Added fsync before rename.', WS_A, 's-alpha'));
    now = clock + 60_000; // the session just moved: not settled
    service.setDistillEnabled(false);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(distill(service)).toMatchObject({ state: 'idle', groupsUnsettled: 1 }));
    expect(runner.inputs).toHaveLength(2);
    // Notes from the old input stay searchable meanwhile.
    expect(distill(service).notes).toBe(2);

    now = clock + DISTILL_SETTLE_MS + 1;
    service.setDistillEnabled(false);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(runner.inputs).toHaveLength(3));
    expect(runner.inputs[2]).toContain('make the writes fsync');
    await vi.waitFor(() => expect(distill(service)).toMatchObject({ state: 'idle', groupsDistilled: 2, groupsUnsettled: 0 }));
    await service.disable({ deleteData: false });
  });

  it('distills a group shared by overlapping workspaces once and writes it to both', async () => {
    workspaceList = [{ id: 'ws-a', workingDirectory: WS_A }, { id: 'ws-parent', workingDirectory: '/work' }];
    const { service, runner } = make();
    await enabled(service);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(distill(service)).toMatchObject({ state: 'idle', groupsPending: 0 }));
    // s-alpha (in both) + s-beta (parent only) → two runs, not three.
    expect(runner.inputs).toHaveLength(2);
    expect((await service.search('ws-a', 'Chose the alpha approach'))[0]?.kind).toBe('decision');
    expect((await service.search('ws-parent', 'Chose the alpha approach'))[0]?.kind).toBe('decision');
    expect(distill(service).spentUsd).toBeCloseTo(0.002);
    await service.disable({ deleteData: false });
  });
});

describe('decision notes: stopping', () => {
  it('pause aborts the run in flight; resume picks the work up again', async () => {
    let started = 0;
    let block = true;
    const base = fakeRunner();
    const runner: DistillRunner & { inputs: string[] } = {
      inputs: base.inputs,
      run: (input, opts) => {
        if (!block) return base.run(input, opts);
        base.inputs.push(input);
        started++;
        return new Promise((resolve) => {
          opts.signal.addEventListener('abort', () => resolve({ ok: false, error: 'stopped', inputSpecific: false, aborted: true }));
        });
      },
    };
    const { service } = make(runner);
    await enabled(service);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(started).toBe(1));
    expect(distill(service).state).toBe('running');
    service.pause();
    expect(distill(service).state).toBe('paused');
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toBe(1); // stopped, not moved on to the next group
    expect(distill(service).groupsDistilled).toBe(0);

    block = false;
    service.resume();
    await vi.waitFor(() => expect(distill(service)).toMatchObject({ state: 'idle', groupsDistilled: 2 }));
    await service.disable({ deleteData: false });
  });

  it('turning history off aborts the run and turns distillation off', async () => {
    let aborted = false;
    let started = false;
    const runner = fakeRunner(() => new Promise<DistillRunResult>(() => { started = true; }));
    const realRun = runner.run;
    runner.run = (input, opts) => {
      opts.signal.addEventListener('abort', () => { aborted = true; });
      return Promise.race([realRun(input, opts), new Promise<DistillRunResult>((resolve) => {
        opts.signal.addEventListener('abort', () => resolve({ ok: false, error: 'stopped', inputSpecific: false, aborted: true }));
      })]);
    };
    const { service } = make(runner);
    await enabled(service);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(started).toBe(true));
    await service.disable({ deleteData: false });
    expect(aborted).toBe(true);
    expect(distill(service)).toMatchObject({ enabled: false, state: 'off' });
    expect(runner.inputs).toHaveLength(1);
  });

  it('turning distillation off aborts the run and keeps the notes', async () => {
    let call = 0;
    const runner = fakeRunner();
    const ok = runner.run;
    runner.run = (input, opts) => {
      call++;
      if (call === 1) return ok(input, opts);
      return new Promise((resolve) => {
        opts.signal.addEventListener('abort', () => resolve({ ok: false, error: 'stopped', inputSpecific: false, aborted: true }));
      });
    };
    const { service } = make(runner);
    await enabled(service);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(call).toBe(2));
    service.setDistillEnabled(false);
    await vi.waitFor(() => expect(distill(service)).toMatchObject({ enabled: false, state: 'off', notes: 1 }));
    expect((await service.search('ws-a', 'Chose the alpha approach')).some((h) => h.kind === 'decision')
      || (await service.search('ws-b', 'Chose the other approach')).some((h) => h.kind === 'decision')).toBe(true);
    await service.disable({ deleteData: false });
  });
});

describe('decision notes: failures', () => {
  it('a failure unrelated to the input backs off instead of trying every group', async () => {
    const runner = fakeRunner(() => ({ ok: false, error: 'Claude AI usage limit reached', inputSpecific: false }));
    const { service } = make(runner);
    await enabled(service);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(distill(service).state).toBe('waiting'));
    expect(distill(service).error).toContain('usage limit');
    expect(runner.inputs).toHaveLength(1);
    // A later pass inside the back-off window doesn't run anything either.
    service.pause();
    service.resume();
    await vi.waitFor(() => expect(service.getStatus().progress.state).toBe('idle'));
    expect(runner.inputs).toHaveLength(1);
    await service.disable({ deleteData: false });
  });

  it('malformed output counts as an attempt; a group is given up on after three', async () => {
    const runner = fakeRunner(() => ({
      ok: false, error: 'Claude Code returned no structured notes', inputSpecific: true,
      usage: { costUsd: 0.0005, inputTokens: 900, outputTokens: 10 },
    }));
    workspaceList = [{ id: 'ws-a', workingDirectory: WS_A }];
    const { service } = make(runner);
    await enabled(service);
    for (let i = 1; i <= 3; i++) {
      service.setDistillEnabled(true);
      await vi.waitFor(() => expect(runner.inputs).toHaveLength(i));
      await vi.waitFor(() => expect(distill(service).state).toBe('idle'));
      service.setDistillEnabled(false);
    }
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(distill(service)).toMatchObject({ state: 'idle', groupsFailed: 1, groupsPending: 0 }));
    expect(runner.inputs).toHaveLength(3);
    expect(distill(service).spentUsd).toBeCloseTo(0.0015); // failed runs still cost
    await service.disable({ deleteData: false });
  });
});

describe('decision notes: deleting', () => {
  it('refuses while on; when off removes the notes and keeps the spent total', async () => {
    const { service } = make();
    await enabled(service);
    service.setDistillEnabled(true);
    await vi.waitFor(() => expect(distill(service)).toMatchObject({ state: 'idle', notes: 2 }));
    await expect(service.deleteNotes()).rejects.toThrow(/off/);
    service.setDistillEnabled(false);
    await service.deleteNotes();
    expect(distill(service)).toMatchObject({ notes: 0, groupsDistilled: 0, groupsPending: 2 });
    expect(distill(service).spentUsd).toBeCloseTo(0.002);
    expect((await service.search('ws-a', 'Chose the alpha approach')).some((h) => h.kind === 'decision')).toBe(false);
    await service.disable({ deleteData: false });
  });
});
