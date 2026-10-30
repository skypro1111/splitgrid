import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The service module imports electron only for the userData path in
// getHistoryService(); these tests build the service directly.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { HistoryIndexer } from './indexer';
import { WorkspaceHistoryService, claudeProjectSlug, type RuntimeLike } from './service';
import { HISTORY_EMBED_DIM } from './types';

// All fixtures are synthetic. Never paste real transcript content here.

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

// Deterministic fake embedding: a one-hot-ish vector keyed on the words, so
// identical texts embed identically and different ones differ.
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

function fakeRuntime(over: Partial<RuntimeLike> = {}): RuntimeLike & { installs: number; embedCalls: number } {
  let installed = false;
  const rt = {
    installs: 0,
    embedCalls: 0,
    isSupported: () => true,
    isInstalled: () => installed,
    downloadBytes: () => 1000,
    install: async () => { rt.installs++; installed = true; },
    uninstall: async () => { installed = false; },
    stop: async () => {},
    embed: async (texts: string[]) => { rt.embedCalls++; return texts.map(fakeVector); },
    ...over,
  };
  return rt;
}

let root: string;
let projects: string;
const WS_A = '/work/alpha';
const WS_B = '/work/beta';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sg-history-'));
  projects = path.join(root, 'projects');
  await mkdir(path.join(projects, claudeProjectSlug(WS_A)), { recursive: true });
  await mkdir(path.join(projects, claudeProjectSlug(WS_B)), { recursive: true });
  await writeFile(
    path.join(projects, claudeProjectSlug(WS_A), 's-alpha.jsonl'),
    turn('why do we write the settings file atomically', 'Because a crash mid-write left it truncated.', `${WS_A}/src`, 's-alpha'),
  );
  await writeFile(
    path.join(projects, claudeProjectSlug(WS_B), 's-beta.jsonl'),
    turn('set up the database migration for invoices', 'Added the invoices migration.', WS_B, 's-beta'),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const workspaces = () => [
  { id: 'ws-a', workingDirectory: WS_A },
  { id: 'ws-b', workingDirectory: WS_B },
  { id: 'ws-none', workingDirectory: null },
];

describe('HistoryIndexer', () => {
  it('routes each session to the workspace whose folder it ran in', async () => {
    const indexer = new HistoryIndexer({ projectsDir: projects, dataDir: path.join(root, 'db'), workspaces, embedder: fakeRuntime() });
    expect(await indexer.scan()).toBe(2);
    expect(indexer.store('ws-a')!.listSessions(10).map((s) => s.id)).toEqual(['s-alpha']);
    expect(indexer.store('ws-b')!.listSessions(10).map((s) => s.id)).toEqual(['s-beta']);
    expect(indexer.store('ws-none')).toBeUndefined();
    indexer.close();
  });

  it('does nothing for unchanged files and only new chunks after an append', async () => {
    const dataDir = path.join(root, 'db');
    let indexer = new HistoryIndexer({ projectsDir: projects, dataDir, workspaces, embedder: fakeRuntime() });
    await indexer.scan();
    await indexer.embedPending(() => false);
    expect(await indexer.scan()).toBe(0);
    indexer.close();

    // A fresh indexer (app restart) reuses files.json and the DB file states.
    indexer = new HistoryIndexer({ projectsDir: projects, dataDir, workspaces, embedder: fakeRuntime() });
    expect(await indexer.scan()).toBe(0);
    await appendFile(
      path.join(projects, claudeProjectSlug(WS_A), 's-alpha.jsonl'),
      turn('and what about the workspace file', 'Same helper, writeFileAtomicSync.', WS_A, 's-alpha'),
    );
    expect(await indexer.scan()).toBe(1);
    expect(indexer.progress()).toEqual({ totalChunks: 3, embeddedChunks: 2 });
    indexer.close();
  });

  it('embeds pending chunks and stops between batches when asked', async () => {
    const embedder = fakeRuntime();
    const indexer = new HistoryIndexer({ projectsDir: projects, dataDir: path.join(root, 'db'), workspaces, embedder, batchSize: 1 });
    await indexer.scan();
    let batches = 0;
    await indexer.embedPending(() => batches >= 1, () => { batches++; });
    expect(indexer.progress().embeddedChunks).toBe(1);
    await indexer.embedPending(() => false);
    expect(indexer.progress()).toEqual({ totalChunks: 2, embeddedChunks: 2 });
    indexer.close();
  });

  it('keeps indexed history after Claude Code deletes the transcript', async () => {
    const indexer = new HistoryIndexer({ projectsDir: projects, dataDir: path.join(root, 'db'), workspaces, embedder: fakeRuntime() });
    await indexer.scan();
    await rm(path.join(projects, claudeProjectSlug(WS_A), 's-alpha.jsonl'));
    await indexer.scan();
    expect(indexer.store('ws-a')!.listSessions(10)).toHaveLength(1);
    indexer.close();
  });
});

describe('WorkspaceHistoryService', () => {
  const make = (runtime = fakeRuntime()) => ({
    runtime,
    service: new WorkspaceHistoryService({
      rootDir: path.join(root, 'history'),
      projectsDir: projects,
      workspaces,
      runtime,
      log: () => {},
    }),
  });

  it('touches nothing on disk before consent', async () => {
    const { service, runtime } = make();
    service.getStatus();
    const estimate = await service.estimate();
    expect(estimate.transcriptFiles).toBe(2);
    expect(estimate.downloadBytes).toBe(1000);
    expect(runtime.installs).toBe(0);
    expect(existsSync(path.join(root, 'history'))).toBe(false);
    await expect(service.search('ws-a', 'atomic')).rejects.toThrow('history_disabled');
  });

  it('installs on enable, indexes in the background, and searches the caller workspace only', async () => {
    const { service, runtime } = make();
    await Promise.all([service.enable(), service.enable()]);
    expect(runtime.installs).toBe(1);
    await vi.waitFor(() => expect(service.getStatus().progress.state).toBe('idle'));
    const hits = await service.search('ws-a', 'why is the settings file written atomically');
    expect(hits.map((h) => h.sessionId)).toEqual(['s-alpha']);
    expect(await service.search('ws-b', 'settings file atomically')).not.toContainEqual(expect.objectContaining({ sessionId: 's-alpha' }));
    expect(service.getStatus().workspaces.map((w) => w.workspaceId).sort()).toEqual(['ws-a', 'ws-b']);
    await service.disable({ deleteData: false });
  });

  it('falls back to lexical search when the query cannot be embedded', async () => {
    const runtime = fakeRuntime();
    const { service } = make(runtime);
    await service.enable();
    await vi.waitFor(() => expect(service.getStatus().progress.state).toBe('idle'));
    runtime.embed = async () => { throw new Error('server down'); };
    const hits = await service.search('ws-b', '"invoices migration"');
    expect(hits[0]?.sessionId).toBe('s-beta');
    await service.disable({ deleteData: false });
  });

  it('reports a failed install as an error and stays off', async () => {
    const { service } = make(fakeRuntime({ install: async () => { throw new Error('sha256 mismatch'); } }));
    await expect(service.enable()).rejects.toThrow('sha256 mismatch');
    expect(service.getStatus()).toMatchObject({ enabled: false, progress: { state: 'error', error: 'sha256 mismatch' } });
  });

  it('disable with deleteData removes the runtime and every index, even after a failed enable', async () => {
    const { service } = make(fakeRuntime({ install: async () => { await mkdir(path.join(root, 'history', 'runtime'), { recursive: true }); throw new Error('network'); } }));
    await expect(service.enable()).rejects.toThrow('network');
    expect(existsSync(path.join(root, 'history'))).toBe(true);
    await service.disable({ deleteData: true });
    expect(existsSync(path.join(root, 'history'))).toBe(false);
    expect(service.getStatus().progress.state).toBe('off');
  });

  it('pause stops indexing and resume finishes it', async () => {
    const runtime = fakeRuntime();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realEmbed = runtime.embed;
    runtime.embed = async (texts, kind) => { await gate; return realEmbed(texts, kind); };
    const { service } = make(runtime);
    await service.enable();
    service.pause();
    release();
    await vi.waitFor(() => expect(service.getStatus().progress.state).toBe('paused'));
    expect(service.getStatus().progress.embeddedChunks ?? 0).toBeLessThan(2);
    service.resume();
    await vi.waitFor(() => expect(service.getStatus().progress).toMatchObject({ state: 'idle', embeddedChunks: 2 }));
    await service.disable({ deleteData: false });
  });
});
