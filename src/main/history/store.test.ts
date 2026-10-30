import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HistoryStore,
  type DistillRunRecord,
  type NoteInput,
  buildMatchExpression,
  isIdentifierLike,
  makeSnippet,
  parseQueryTerms,
} from './store';
import { HISTORY_EMBED_DIM, type SessionMeta, type TranscriptChunk } from './types';

/** 256-d vector with the given non-zero components (normalized by the store). */
function vec(components: Record<number, number>): Float32Array {
  const v = new Float32Array(HISTORY_EMBED_DIM);
  for (const [i, x] of Object.entries(components)) v[Number(i)] = x;
  return v;
}

function session(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { id, file: `/home/u/.claude/projects/p/${id}.jsonl`, cwds: ['/repo'], firstTs: 1000, lastTs: 2000, ...extra };
}

function chunk(sessionId: string, seq: number, text: string, extra: Partial<TranscriptChunk> = {}): TranscriptChunk {
  return {
    id: `${sessionId}:${seq}`,
    sessionId,
    seq,
    ts: 1000 + seq,
    kind: 'turn',
    text,
    files: [],
    hash: `h:${text}`,
    ...extra,
  };
}

const open: HistoryStore[] = [];
const tmpDirs: string[] = [];
function mem(): HistoryStore {
  const s = HistoryStore.open(':memory:');
  open.push(s);
  return s;
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(store: HistoryStore, sessionId: string, chunks: TranscriptChunk[], meta: Partial<SessionMeta> = {}): string[] {
  store.upsertSession(session(sessionId, meta));
  return store.replaceSessionChunks(sessionId, chunks);
}

const ids = (hits: Array<{ chunkId: string }>) => hits.map((h) => h.chunkId);

describe('replaceSessionChunks', () => {
  it('inserts new, updates changed (clearing vectors), deletes removed, keeps unchanged', () => {
    const s = mem();
    const first = seed(s, 'S', [
      chunk('S', 0, 'User: alpha one'),
      chunk('S', 1, 'User: bravo two', { files: ['/repo/a.ts'] }),
      chunk('S', 2, 'User: charlie three'),
    ]);
    expect(first).toEqual(['S:0', 'S:1', 'S:2']);
    expect(s.pendingEmbeddings(10).map((p) => p.id)).toEqual(['S:0', 'S:1', 'S:2']);
    expect(s.setVectors([
      { id: 'S:0', vector: vec({ 0: 1 }) },
      { id: 'S:1', vector: vec({ 1: 1 }) },
      { id: 'S:2', vector: vec({ 2: 1 }) },
    ])).toBe(3);
    expect(s.pendingEmbeddings(10)).toEqual([]);

    const second = s.replaceSessionChunks('S', [
      chunk('S', 0, 'User: alpha one'), // unchanged
      chunk('S', 1, 'User: bravo two, edited', { files: ['/repo/b.ts'] }), // changed
      chunk('S', 3, 'User: delta four'), // new; S:2 removed
    ]);
    expect(second).toEqual(['S:1', 'S:3']);
    expect(s.getChunk('S:0')?.embedded).toBe(true);
    expect(s.getChunk('S:1')).toMatchObject({ embedded: false, text: 'User: bravo two, edited', files: ['/repo/b.ts'] });
    expect(s.getChunk('S:2')).toBeUndefined();
    expect(s.getChunk('S:3')?.embedded).toBe(false);
    expect(s.pendingEmbeddings(10).map((p) => p.id).sort()).toEqual(['S:1', 'S:3']);
    expect(s.sessionsForFile('/repo/a.ts')).toEqual([]);
    expect(s.sessionsForFile('/repo/b.ts').map((e) => e.sessionId)).toEqual(['S']);
    expect(s.stats()).toMatchObject({ sessions: 1, chunks: 3, embeddedChunks: 1 });
  });

  it('re-running with identical chunks is a no-op', () => {
    const s = mem();
    const chunks = [chunk('S', 0, 'one'), chunk('S', 1, 'two')];
    seed(s, 'S', chunks);
    s.setVectors([{ id: 'S:0', vector: vec({ 0: 1 }) }]);
    expect(s.replaceSessionChunks('S', chunks)).toEqual([]);
    expect(s.getChunk('S:0')?.embedded).toBe(true);
  });

  it('is atomic: a bad chunk rolls the whole batch back', () => {
    const s = mem();
    seed(s, 'S', [chunk('S', 0, 'kept text')]);
    expect(() => s.replaceSessionChunks('S', [
      chunk('S', 1, 'would be inserted'),
      chunk('OTHER', 2, 'wrong session'),
    ])).toThrow(/belongs to OTHER/);
    expect(s.getSessionChunks('S').map((c) => c.id)).toEqual(['S:0']);
    expect(ids(s.search({ text: 'inserted' }))).toEqual([]);
  });

  it('drops a vector computed for text that has since changed', () => {
    const s = mem();
    seed(s, 'S', [chunk('S', 0, 'old text')]);
    const [pending] = s.pendingEmbeddings(1);
    s.replaceSessionChunks('S', [chunk('S', 0, 'new text')]);
    expect(s.setVectors([{ id: pending.id, hash: pending.hash, vector: vec({ 0: 1 }) }])).toBe(0);
    expect(s.getChunk('S:0')?.embedded).toBe(false);
    expect(() => s.setVectors([{ id: 'S:0', vector: new Float32Array(3) }])).toThrow(/256-d/);
  });
});

describe('lexical search / FTS', () => {
  it('stays in sync with inserts, updates and deletes', () => {
    const s = mem();
    seed(s, 'S', [chunk('S', 0, 'User: configure the zebrafish pipeline')]);
    expect(ids(s.search({ text: 'zebrafish' }))).toEqual(['S:0']);
    s.replaceSessionChunks('S', [chunk('S', 0, 'User: configure the platypus pipeline')]);
    expect(ids(s.search({ text: 'zebrafish' }))).toEqual([]);
    expect(ids(s.search({ text: 'platypus' }))).toEqual(['S:0']);
    s.replaceSessionChunks('S', []);
    expect(ids(s.search({ text: 'platypus' }))).toEqual([]);
  });

  it('matches substrings case-insensitively, Cyrillic included', () => {
    const s = mem();
    seed(s, 'S', [
      chunk('S', 0, 'Assistant: Оновив конфіг на СЕРВЕРІ, FrobnicateWidget перейменовано'),
      chunk('S', 1, 'Assistant: nothing relevant here'),
    ]);
    expect(ids(s.search({ text: 'сервер' }))).toEqual(['S:0']);
    expect(ids(s.search({ text: 'frobnicatew' }))).toEqual(['S:0']);
  });

  it('never lets user text become FTS5 syntax', () => {
    const s = mem();
    seed(s, 'S', [
      chunk('S', 0, 'call NEAR(alpha beta) then foo* and -bar (x OR y)'),
      chunk('S', 1, 'she said "quoted words" here'),
      chunk('S', 2, 'привіт «світ» з лапками'),
    ]);
    const nasty = [
      'NEAR(alpha beta)', 'NEAR', 'foo*', '*', '-bar', '- -', '(x OR y)', 'AND OR NOT',
      '"unterminated', '""', '"quoted words"', 'col:value', '^start', 'a"b"c', '{alpha}',
      'привіт "світ"', '\u0000nul\u0000', '', '   ',
    ];
    for (const q of nasty) {
      expect(() => s.search({ text: q }), q).not.toThrow();
    }
    expect(ids(s.search({ text: 'NEAR(alpha' }))).toEqual(['S:0']);
    expect(ids(s.search({ text: '-bar' }))).toEqual(['S:0']);
    expect(ids(s.search({ text: '"quoted words"' }))).toEqual(['S:1']);
    expect(ids(s.search({ text: 'привіт "світ"' }))).toEqual(['S:2']);

    expect(buildMatchExpression(parseQueryTerms('a"b NEAR(x y)'))).toBe('"near"');
    expect(buildMatchExpression(parseQueryTerms('"say ""hi"" now"'))).toBe('"say" OR "now"');
    expect(buildMatchExpression(parseQueryTerms('"it\'s" here'))).toBe('"it\'s" OR "here"');
  });

  it('treats a quoted phrase as one substring term', () => {
    const terms = parseQueryTerms('find "build failed" in logs');
    expect(terms).toContainEqual({ text: 'build failed', identifier: true });
    expect(buildMatchExpression(terms)).toBe('"find" OR "build failed" OR "logs"');
  });

  it('handles terms too short for trigrams', () => {
    const s = mem();
    seed(s, 'S', [chunk('S', 0, 'the UI is broken'), chunk('S', 1, 'nothing here')]);
    expect(buildMatchExpression(parseQueryTerms('UI'))).toBeNull();
    // No vector: falls back to a LIKE scan.
    expect(ids(s.search({ text: 'UI' }))).toEqual(['S:0']);
    // With a vector, short terms just don't contribute a lexical leg.
    s.setVectors([{ id: 'S:0', vector: vec({ 0: 1 }) }, { id: 'S:1', vector: vec({ 1: 1 }) }]);
    expect(ids(s.search({ text: 'UI', vector: vec({ 1: 1 }) }))[0]).toBe('S:1');
    // A LIKE pattern built from user text is escaped too.
    expect(ids(s.search({ text: 'i_' }))).toEqual([]);
  });
});

describe('dense search', () => {
  it('ranks by cosine and keeps the cache in step with writes', () => {
    const s = mem();
    seed(s, 'S', [chunk('S', 0, 'a'), chunk('S', 1, 'b'), chunk('S', 2, 'c')]);
    s.setVectors([
      { id: 'S:0', vector: vec({ 0: 1 }) },
      { id: 'S:1', vector: vec({ 0: 1, 1: 1 }) },
      { id: 'S:2', vector: vec({ 1: 1 }) },
    ]);
    const q = vec({ 0: 0.2, 1: 1 });
    const hits = s.search({ text: 'zzz', vector: q }, { mode: 'dense' });
    expect(ids(hits)).toEqual(['S:2', 'S:1', 'S:0']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);

    // Cache is loaded now; changing S:2 must drop it from dense results...
    s.replaceSessionChunks('S', [chunk('S', 0, 'a'), chunk('S', 1, 'b'), chunk('S', 2, 'c changed')]);
    expect(ids(s.search({ text: 'zzz', vector: q }, { mode: 'dense' }))).toEqual(['S:1', 'S:0']);
    // ...and re-embedding it must bring it back without a reload.
    s.setVectors([{ id: 'S:2', vector: vec({ 1: 1 }) }]);
    expect(ids(s.search({ text: 'zzz', vector: q }, { mode: 'dense' }))[0]).toBe('S:2');
    // Deleting through a removal from the session removes it from the cache too.
    s.replaceSessionChunks('S', [chunk('S', 0, 'a'), chunk('S', 1, 'b')]);
    expect(ids(s.search({ text: 'zzz', vector: q }, { mode: 'dense' }))).toEqual(['S:1', 'S:0']);
  });

  it('requires a vector for dense / hybrid mode', () => {
    expect(() => mem().search({ text: 'x' }, { mode: 'dense' })).toThrow(/needs a query vector/);
  });
});

describe('fusion', () => {
  // Paraphrase neighbours sit near the query in embedding space; the chunk
  // that actually contains the identifier is far from it (embeddings blur
  // rare tokens). Three distractors so the identifier chunk is dense-last.
  function fusionStore(): HistoryStore {
    const s = mem();
    seed(s, 'S', [
      chunk('S', 0, 'User: the parser crashes when the config has tabs'),
      chunk('S', 1, 'User: parser rewrite discussion, config loading'),
      chunk('S', 2, 'User: why is config parsing slow'),
      chunk('S', 3, 'Assistant: fixed parseConfigTabs in src/config/loader.ts'),
    ]);
    s.setVectors([
      { id: 'S:0', vector: vec({ 0: 1, 1: 0.1 }) },
      { id: 'S:1', vector: vec({ 0: 1, 1: 0.3 }) },
      { id: 'S:2', vector: vec({ 0: 1, 1: 0.5 }) },
      { id: 'S:3', vector: vec({ 2: 1, 0: 0.2 }) },
    ]);
    return s;
  }
  const q = vec({ 0: 1 });

  it('identifier query: an exact token match surfaces at the top', () => {
    const s = fusionStore();
    expect(ids(s.search({ text: 'parseConfigTabs', vector: q }, { mode: 'dense' }))[0]).toBe('S:0');
    expect(ids(s.search({ text: 'where did we touch parseConfigTabs', vector: q }))[0]).toBe('S:3');
    expect(ids(s.search({ text: 'changes to src/config/loader.ts', vector: q }))[0]).toBe('S:3');
  });

  it('paraphrase query: plain words do not perturb the dense order', () => {
    const s = fusionStore();
    // "config" and "parser" occur lexically in several chunks, S:3 included;
    // with no identifier-like term the result must be exactly the dense order.
    const text = 'config parser problems';
    expect(parseQueryTerms(text).some((t) => t.identifier)).toBe(false);
    expect(ids(s.search({ text, vector: q }))).toEqual(ids(s.search({ text, vector: q }, { mode: 'dense' })));
  });

  it('classifies identifier-like tokens', () => {
    for (const t of ['FrobnicateWidget', 'parse_config', 'ABC-DEF-TEST', '502', 'v1.2', 'src/a.ts', 'git.example.com', 'HTTPServer', 'sg-history']) {
      expect(isIdentifierLike(t), t).toBe(true);
    }
    for (const t of ['config', 'Kubernetes', 'DNS', 'будь-який', 'сервер', 'Конфіг']) {
      expect(isIdentifierLike(t), t).toBe(false);
    }
  });
});

describe('snippets', () => {
  it('centres on the best match, else starts at the top', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(40);
    const text = `User: intro line\n\n${filler}the needle_token is here\n${filler}`;
    const sn = makeSnippet(text, parseQueryTerms('needle_token'));
    expect(sn).toContain('needle_token');
    expect(sn.startsWith('…')).toBe(true);
    expect(sn.length).toBeLessThanOrEqual(310);
    expect(makeSnippet(text)).toMatch(/^User: intro line/);
    expect(makeSnippet('short')).toBe('short');
  });

  it('search hits carry snippet and session title', () => {
    const s = mem();
    seed(s, 'S', [chunk('S', 0, 'User: hello world zebra')], { title: 'Fix the zebra' });
    expect(s.search({ text: 'zebra' })[0]).toMatchObject({
      chunkId: 'S:0', sessionId: 'S', kind: 'turn', sessionTitle: 'Fix the zebra', snippet: 'User: hello world zebra',
    });
  });
});

describe('sessions, files, since, delete, stats', () => {
  it('sessionsForFile: newest first, absolute exact, relative as suffix', () => {
    const s = mem();
    seed(s, 'old', [chunk('old', 0, 'edit a', { ts: 100, files: ['/repo/src/a.ts'] })], { title: 'Old', lastTs: 100 });
    seed(s, 'new', [
      chunk('new', 0, 'edit a again', { ts: 500, files: ['/repo/src/a.ts', '/repo/src/b.ts'] }),
      chunk('new', 1, 'and again', { ts: 600, files: ['/repo/src/a.ts'] }),
      chunk('new', 2, 'unrelated', { ts: 700 }),
    ], { title: 'New', gitBranch: 'main', lastTs: 700 });
    const res = s.sessionsForFile('/repo/src/a.ts', 10);
    expect(res.map((e) => e.sessionId)).toEqual(['new', 'old']);
    expect(res[0]).toMatchObject({ sessionTitle: 'New', gitBranch: 'main', lastTs: 600 });
    expect(res[0].chunks.map((c) => c.chunkId)).toEqual(['new:1', 'new:0']);
    expect(s.sessionsForFile('src/a.ts').map((e) => e.sessionId)).toEqual(['new', 'old']);
    expect(s.sessionsForFile('a.ts').map((e) => e.sessionId)).toEqual(['new', 'old']);
    expect(s.sessionsForFile('/repo/src/a.ts', 1).map((e) => e.sessionId)).toEqual(['new']);
    expect(s.sessionsForFile('/elsewhere/a.ts')).toEqual([]);
    // `_` and `%` in a relative path are literal, not LIKE wildcards.
    expect(s.sessionsForFile('%.ts')).toEqual([]);
  });

  it('since filters search (both legs) and listSessions', () => {
    const s = mem();
    seed(s, 'A', [chunk('A', 0, 'kiwi early', { ts: 100 })], { lastTs: 100 });
    seed(s, 'B', [chunk('B', 0, 'kiwi late', { ts: 900 })], { lastTs: 900 });
    s.setVectors([{ id: 'A:0', vector: vec({ 0: 1 }) }, { id: 'B:0', vector: vec({ 0: 0.5, 1: 1 }) }]);
    expect(ids(s.search({ text: 'kiwi' })).sort()).toEqual(['A:0', 'B:0']);
    expect(ids(s.search({ text: 'kiwi', since: 500 }))).toEqual(['B:0']);
    expect(ids(s.search({ text: 'kiwi', vector: vec({ 0: 1 }), since: 500 }))).toEqual(['B:0']);
    expect(s.listSessions(10).map((x) => x.id)).toEqual(['B', 'A']);
    expect(s.listSessions(10, 500).map((x) => x.id)).toEqual(['B']);
    expect(s.listSessions(10)[0]).toMatchObject({ id: 'B', chunkCount: 1, cwds: ['/repo'] });
  });

  it('ties go to the newer chunk', () => {
    const s = mem();
    seed(s, 'S', [chunk('S', 0, 'same', { ts: 100 }), chunk('S', 1, 'same', { ts: 200, hash: 'other' })]);
    s.setVectors([{ id: 'S:0', vector: vec({ 0: 1 }) }, { id: 'S:1', vector: vec({ 0: 1 }) }]);
    expect(ids(s.search({ text: 'x', vector: vec({ 0: 1 }) }))).toEqual(['S:1', 'S:0']);
  });

  it('getSessionChunks returns a window around a chunk', () => {
    const s = mem();
    seed(s, 'S', Array.from({ length: 10 }, (_, i) => chunk('S', i, `turn ${i}`)));
    expect(s.getSessionChunks('S').length).toBe(10);
    expect(s.getSessionChunks('S', { aroundChunkId: 'S:5', radius: 1 }).map((c) => c.seq)).toEqual([4, 5, 6]);
    expect(s.getSessionChunks('S', { aroundChunkId: 'S:0' }).map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(s.getSessionChunks('S', { aroundChunkId: 'nope' })).toEqual([]);
  });

  it('deleteSession removes chunks, FTS rows, vectors, file links and file state', () => {
    const s = mem();
    seed(s, 'A', [chunk('A', 0, 'mango keep', { files: ['/repo/x.ts'] })]);
    seed(s, 'B', [chunk('B', 0, 'mango drop', { files: ['/repo/x.ts'] })]);
    s.setFileState('/t/A.jsonl', { size: 1, mtimeMs: 1, sessionId: 'A' });
    s.setFileState('/t/B.jsonl', { size: 2, mtimeMs: 2, sessionId: 'B' });
    s.setVectors([{ id: 'A:0', vector: vec({ 0: 1 }) }, { id: 'B:0', vector: vec({ 0: 1 }) }]);
    expect(s.search({ text: 'x', vector: vec({ 0: 1 }) }, { mode: 'dense' }).length).toBe(2); // loads cache
    s.deleteSession('B');
    expect(ids(s.search({ text: 'mango' }))).toEqual(['A:0']);
    expect(ids(s.search({ text: 'x', vector: vec({ 0: 1 }) }, { mode: 'dense' }))).toEqual(['A:0']);
    expect(s.sessionsForFile('/repo/x.ts').map((e) => e.sessionId)).toEqual(['A']);
    expect(s.getFileState('/t/B.jsonl')).toBeUndefined();
    expect(s.getFileState('/t/A.jsonl')).toEqual({ size: 1, mtimeMs: 1, sessionId: 'A' });
    expect(s.stats()).toMatchObject({ sessions: 1, chunks: 1, embeddedChunks: 1 });
    expect(s.stats().dbBytes).toBeGreaterThan(0);
  });

  it('file state round-trips and updates', () => {
    const s = mem();
    expect(s.getFileState('/t/x.jsonl')).toBeUndefined();
    s.setFileState('/t/x.jsonl', { size: 10, mtimeMs: 123.7 });
    expect(s.getFileState('/t/x.jsonl')).toEqual({ size: 10, mtimeMs: 124 });
    s.setFileState('/t/x.jsonl', { size: 20, mtimeMs: 200, sessionId: 'S' });
    expect(s.getFileState('/t/x.jsonl')).toEqual({ size: 20, mtimeMs: 200, sessionId: 'S' });
  });
});

describe('file-backed DB', () => {
  it('persists across reopen, with WAL and 0600', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-history-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'ws.sqlite');

    const a = HistoryStore.open(dbPath);
    seed(a, 'S', [chunk('S', 0, 'persistent walrus', { files: ['/repo/w.ts'] })], { title: 'Walrus' });
    a.setVectors([{ id: 'S:0', vector: vec({ 3: 1 }) }]);
    a.setFileState('/t/S.jsonl', { size: 5, mtimeMs: 6, sessionId: 'S' });
    a.close();
    a.close(); // idempotent
    expect(() => a.stats()).toThrow(/closed/);

    if (process.platform !== 'win32') {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    }

    const b = HistoryStore.open(dbPath);
    open.push(b);
    expect(b.getFileState('/t/S.jsonl')).toEqual({ size: 5, mtimeMs: 6, sessionId: 'S' });
    expect(b.search({ text: 'walrus' })[0]).toMatchObject({ chunkId: 'S:0', sessionTitle: 'Walrus' });
    expect(ids(b.search({ text: 'zzz', vector: vec({ 3: 1 }) }))).toEqual(['S:0']);
    expect(b.sessionsForFile('/repo/w.ts').map((e) => e.sessionId)).toEqual(['S']);
    expect(b.stats()).toMatchObject({ sessions: 1, chunks: 1, embeddedChunks: 1 });
    expect(b.stats().dbBytes).toBeGreaterThan(0);
  });
});

// ─── Decision notes ──────────────────────────────────────────────────────────

describe('decision notes', () => {
  const note = (sessionId: string, group: number, i: number, text: string, extra: Partial<NoteInput> = {}): NoteInput => ({
    id: `${sessionId}:n${group}.${i}`, sessionId, seq: 1, ts: 1500, kind: 'decision', text, files: [], hash: `n:${text}`,
    noteKind: 'decision', sources: [`${sessionId}:1`], ...extra,
  });
  const run = (inputHash: string, extra: Partial<DistillRunRecord> = {}): DistillRunRecord => ({
    inputHash, ok: true, costUsd: 0.001, inputTokens: 1000, outputTokens: 100, at: 5000, ...extra,
  });

  it('survive replaceSessionChunks, which still replaces every turn', () => {
    const s = mem();
    seed(s, 'a', [chunk('a', 0, 'first turn'), chunk('a', 1, 'second turn')]);
    s.replaceGroupNotes('a', 0, [note('a', 0, 0, 'Decision: keep notes')]);
    // Re-parse: one turn changed, one vanished.
    const toEmbed = s.replaceSessionChunks('a', [chunk('a', 0, 'first turn edited')]);
    expect(toEmbed).toEqual(['a:0']);
    expect(s.getChunk('a:1')).toBeUndefined();
    expect(s.getChunk('a:n0.0')).toMatchObject({ kind: 'decision', text: 'Decision: keep notes', note: { kind: 'decision', sources: ['a:1'] } });
    expect(() => s.replaceSessionChunks('a', [{ ...chunk('a', 2, 'x'), kind: 'decision' }])).toThrow(/replaceGroupNotes/);
  });

  it('replaceGroupNotes replaces one group only, and records its state atomically', () => {
    const s = mem();
    seed(s, 'a', [chunk('a', 0, 'turn')]);
    s.replaceGroupNotes('a', 0, [note('a', 0, 0, 'g0 old'), note('a', 0, 1, 'g0 old two')], run('h0'));
    s.replaceGroupNotes('a', 1, [note('a', 1, 0, 'g1 note')], run('h1'));
    s.replaceGroupNotes('a', 0, [note('a', 0, 0, 'g0 new')], run('h0b', { costUsd: 0.002 }));

    expect(s.getGroupNotes('a', 0).map((n) => n.text)).toEqual(['g0 new']);
    expect(s.getGroupNotes('a', 1).map((n) => n.text)).toEqual(['g1 note']);
    expect(s.getChunk('a:n0.1')).toBeUndefined();
    expect(s.getChunk('a:0')?.text).toBe('turn');
    const states = s.groupStates('a');
    expect(states.get(0)).toMatchObject({ inputHash: 'h0b', status: 'ok', notes: 1, attempts: 0 });
    expect(states.get(0)!.costUsd).toBeCloseTo(0.003); // cumulative per group
    expect(s.distillTotals()).toEqual({ notes: 2, spentUsd: expect.closeTo(0.004, 6) });
    // An empty result is a valid distillation: the group's notes go, the state stays.
    s.replaceGroupNotes('a', 1, [], run('h1b', { costUsd: 0 }));
    expect(s.getGroupNotes('a', 1)).toEqual([]);
    expect(s.groupStates('a').get(1)).toMatchObject({ inputHash: 'h1b', status: 'ok', notes: 0 });
  });

  it('a failed run keeps the notes and counts attempts only when it should', () => {
    const s = mem();
    seed(s, 'a', [chunk('a', 0, 'turn')]);
    s.replaceGroupNotes('a', 0, [note('a', 0, 0, 'kept')], run('h0'));
    s.recordGroupRun('a', 0, run('h1', { ok: false, countsAsAttempt: true, error: 'bad json' }));
    s.recordGroupRun('a', 0, run('h1', { ok: false, countsAsAttempt: false, error: 'limit' }));
    s.recordGroupRun('a', 0, run('h1', { ok: false, countsAsAttempt: true, error: 'bad json' }));
    expect(s.groupStates('a').get(0)).toMatchObject({ inputHash: 'h1', status: 'error', attempts: 2, notes: 1, error: 'bad json' });
    expect(s.getGroupNotes('a', 0)).toHaveLength(1);
    // New input resets the count.
    s.recordGroupRun('a', 0, run('h2', { ok: false, countsAsAttempt: true }));
    expect(s.groupStates('a').get(0)?.attempts).toBe(1);
  });

  it('notes are embedded, searched and shown like turns, but are not turns', () => {
    const s = mem();
    seed(s, 'a', [chunk('a', 0, 'we talked about sockets'), chunk('a', 1, 'and then about retries'), chunk('a', 2, 'done')]);
    s.replaceGroupNotes('a', 0, [note('a', 0, 0, 'Rejected: unbounded reconnect backoff', { noteKind: 'rejected', sources: ['a:0', 'a:1'] })]);
    expect(s.pendingEmbeddings(10).map((p) => p.id)).toContain('a:n0.0');

    const hits = s.search({ text: 'reconnect backoff' });
    expect(hits[0]).toMatchObject({ chunkId: 'a:n0.0', kind: 'decision', note: { kind: 'rejected', sources: ['a:0', 'a:1'] } });
    expect(s.search({ text: 'sockets' })[0]).not.toHaveProperty('note');

    // Neighbours of a turn never include notes; a note anchors to itself only.
    expect(s.getSessionChunks('a', { aroundChunkId: 'a:1', radius: 5 }).map((c) => c.id)).toEqual(['a:0', 'a:1', 'a:2']);
    expect(s.getSessionChunks('a', { aroundChunkId: 'a:n0.0', radius: 5 }).map((c) => c.id)).toEqual(['a:n0.0']);
    expect(s.getSessionChunks('a').map((c) => c.id)).toEqual(['a:0', 'a:1', 'a:2']);
    expect(s.listSessions(10)[0].chunkCount).toBe(3);
    expect(s.sessionsForFile('/x.ts')).toEqual([]);
  });

  it('dense search sees an embedded note', () => {
    const s = mem();
    seed(s, 'a', [chunk('a', 0, 'turn')]);
    s.replaceGroupNotes('a', 0, [note('a', 0, 0, 'Decision: x')]);
    s.setVectors([{ id: 'a:0', vector: vec({ 0: 1 }) }, { id: 'a:n0.0', vector: vec({ 1: 1 }) }]);
    expect(s.search({ text: 'q', vector: vec({ 1: 1 }), limit: 1 }, { mode: 'dense' })[0].chunkId).toBe('a:n0.0');
    // Replacing the group drops the old vector from the cache too.
    s.replaceGroupNotes('a', 0, []);
    expect(s.search({ text: 'q', vector: vec({ 1: 1 }), limit: 2 }, { mode: 'dense' }).map((h) => h.chunkId)).toEqual(['a:0']);
  });

  it('deleteNotes removes every note and group state but keeps the spent total; pruneGroups drops stale groups', () => {
    const s = mem();
    seed(s, 'a', [chunk('a', 0, 'turn')]);
    s.replaceGroupNotes('a', 0, [note('a', 0, 0, 'one')], run('h0'));
    s.replaceGroupNotes('a', 1, [note('a', 1, 0, 'two')], run('h1'));
    s.pruneGroups('a', 1);
    expect(s.getGroupNotes('a', 1)).toEqual([]);
    expect([...s.groupStates('a').keys()]).toEqual([0]);
    expect(s.deleteNotes()).toBe(1);
    expect(s.groupStates('a').size).toBe(0);
    expect(s.distillTotals()).toEqual({ notes: 0, spentUsd: expect.closeTo(0.002, 6) });
    expect(s.getChunk('a:0')).toBeDefined();
  });

  it('distillCandidates lists main sessions\' turns by length, without subagents or summaries', () => {
    const s = mem();
    seed(s, 'main', [chunk('main', 1, 'bb'), chunk('main', 0, 'a'), chunk('main', 2, 'summary', { kind: 'compact_summary' })], { title: 'T', lastTs: 9 });
    seed(s, 'agent-1', [chunk('agent-1', 0, 'sub')], { parentSessionId: 'main' });
    s.replaceGroupNotes('main', 0, [note('main', 0, 0, 'n')]);
    expect(s.distillCandidates()).toEqual([{
      sessionId: 'main', title: 'T', lastTs: 9,
      chunks: [
        { id: 'main:0', seq: 0, hash: 'h:a', chars: 1, ts: 1000 },
        { id: 'main:1', seq: 1, hash: 'h:bb', chars: 2, ts: 1001 },
      ],
    }]);
  });
});
