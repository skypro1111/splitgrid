import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import {
  HISTORY_EMBED_DIM,
  type ChunkKind,
  type DecisionNoteKind,
  type SearchHit,
  type SearchQuery,
  type SessionMeta,
  type TranscriptChunk,
} from './types';

// ─── Workspace history: per-workspace SQLite store ───────────────────────────
// One DB file per workspace (`<userData>/history/<workspaceId>.sqlite`) holding
// sessions, turn-level chunks, a trigram FTS5 index over chunk text, and the
// chunks' 256-d embeddings. Dense search is brute force over an in-memory
// Float32Array cache — at tens of thousands of chunks a full dot-product scan is
// a few milliseconds, which is cheaper (and far simpler) than any ANN index.
//
// This DB is an ARCHIVE, not a cache: Claude Code prunes old transcripts
// (cleanupPeriodDays), so once a session is in here it may exist nowhere else.
// Hence the 0600 file mode (transcripts contain whatever the user pasted) and
// the schema-version check that refuses to touch a DB written by a newer build.
//
// v2 added decision notes (note_meta, distill_groups; distill.ts). The upgrade
// is purely additive (CREATE … IF NOT EXISTS), but the version is bumped so a
// v1 build refuses the DB: its replaceSessionChunks would delete every note.

const SCHEMA_VERSION = 2;

/** Candidates taken from each leg before fusion (the spike used 100 as well). */
const FUSION_CANDIDATES = 100;
/** Standard RRF damping constant. */
const RRF_K = 60;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MAX_QUERY_TERMS = 16;
const SNIPPET_CHARS = 300;
const SNIPPET_MAX_LINES = 8;
/** trigram FTS5 cannot match anything shorter than one trigram. */
const MIN_TERM_CHARS = 3;

export type SearchMode = 'hybrid' | 'dense' | 'lexical';

export interface FileState {
  size: number;
  mtimeMs: number;
  /** Session the transcript file was ingested as (absent if it yielded none). */
  sessionId?: string;
}

/** A session as stored, plus how many chunks it has. */
export interface StoredSession extends SessionMeta {
  chunkCount: number;
}

export interface StoredChunk extends TranscriptChunk {
  /** True once a vector for the current `hash` has been stored. */
  embedded: boolean;
  sessionTitle?: string;
  /** Set on a `decision` chunk. */
  note?: { kind: DecisionNoteKind; sources: string[] };
}

/** A decision note to store (distill.ts buildNoteChunks). */
export interface NoteInput extends TranscriptChunk {
  noteKind: DecisionNoteKind;
  /** Chunk ids of the source turns. */
  sources: string[];
}

/** Per-group distillation bookkeeping (distill_groups). */
export interface DistillGroupState {
  group: number;
  inputHash: string;
  status: 'ok' | 'error';
  /** Failed runs for this inputHash that counted as attempts (reset on success / new input). */
  attempts: number;
  /** Cumulative total_cost_usd for this group, failed runs included. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  notes: number;
  distilledAt: number;
  error?: string;
}

/** What recordGroupRun writes. */
export interface DistillRunRecord {
  inputHash: string;
  ok: boolean;
  /** A failed run that counts toward the group's attempts. */
  countsAsAttempt?: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  at: number;
  error?: string;
}

/** A main session's distillable chunks, for planning groups without reading text. */
export interface DistillCandidate {
  sessionId: string;
  title?: string;
  lastTs: number;
  chunks: Array<{ id: string; seq: number; hash: string; chars: number; ts: number }>;
}

export interface PendingEmbedding {
  id: string;
  text: string;
  /** Pass back to setVectors so a vector computed for stale text is dropped. */
  hash: string;
}

export interface ChunkVector {
  id: string;
  vector: Float32Array;
  /** When given, the vector is stored only if the chunk still has this hash. */
  hash?: string;
}

export interface FileHistoryChunk {
  chunkId: string;
  seq: number;
  ts: number;
  /** Start of the turn (the user's prompt), trimmed to a short excerpt. */
  snippet: string;
}

export interface FileHistoryEntry {
  sessionId: string;
  sessionTitle?: string;
  gitBranch?: string;
  /** Newest edit of the file within this session. */
  lastTs: number;
  /** The session's chunks that edited the file, newest first. */
  chunks: FileHistoryChunk[];
}

export interface HistoryStats {
  sessions: number;
  chunks: number;
  embeddedChunks: number;
  /** Main DB file + WAL on disk (page count × page size for an in-memory DB). */
  dbBytes: number;
}

// ─── node:sqlite loading ─────────────────────────────────────────────────────
// better-sqlite3 in this repo is built against Electron's ABI and can't load in
// vitest's plain Node, so the history store uses the built-in node:sqlite, which
// works in both (Node 22.20 / SQLite 3.50 under vitest, Electron 41 / Node 24 /
// SQLite 3.51 in the app). It is loaded through process.getBuiltinModule rather
// than an import so (a) the bundler never has to resolve it, and (b) we can
// swallow its one-time "SQLite is an experimental feature" ExperimentalWarning —
// Node prints that on first load in both 22.x and 24.x (the API is stable enough
// for us: DatabaseSync/prepare/run/get/all have not changed since 22.5). Only
// that exact warning is filtered, only during the load call, so any other
// warning still reaches stderr. Revisit once node:sqlite leaves "experimental"
// (then the filter is simply a no-op) or if Electron's Node drops it.
type SqliteModule = typeof import('node:sqlite');
let sqliteModule: SqliteModule | null = null;

function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function filteredEmitWarning(this: unknown, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === 'string' ? warning : warning?.message ?? '';
    const typeArg = rest[0];
    const type = typeof typeArg === 'string'
      ? typeArg
      : (typeArg as { type?: string } | undefined)?.type ?? (typeof warning === 'string' ? '' : warning?.name);
    if (type === 'ExperimentalWarning' && /\bSQLite\b/i.test(message)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    const mod = typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule('node:sqlite')
      : undefined;
    if (!mod?.DatabaseSync) {
      throw new Error(`node:sqlite is not available in Node ${process.versions.node}`);
    }
    sqliteModule = mod;
    return mod;
  } finally {
    process.emitWarning = original;
  }
}

// ─── Schema ──────────────────────────────────────────────────────────────────
// chunks.rid is an INTEGER rowid separate from the string chunk id because
// FTS5 external-content tables (and compact join keys) need an integer rowid.
// The FTS table is external-content over chunks.text — the text is stored once
// — and kept in sync by triggers, so no code path can forget to update it. The
// vec column holds a little-endian Float32 BLOB (every platform we ship on is
// little-endian) and is NULL until embedded / after the text changes.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  session_id TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT,
  file       TEXT NOT NULL,
  cwds       TEXT NOT NULL DEFAULT '[]',
  title      TEXT,
  git_branch TEXT,
  first_ts   INTEGER NOT NULL DEFAULT 0,
  last_ts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_last_ts ON sessions(last_ts);
CREATE TABLE IF NOT EXISTS chunks (
  rid        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  vec        BLOB
);
CREATE INDEX IF NOT EXISTS chunks_session_seq ON chunks(session_id, seq);
CREATE INDEX IF NOT EXISTS chunks_ts ON chunks(ts);
CREATE TABLE IF NOT EXISTS chunk_files (
  chunk_rid INTEGER NOT NULL REFERENCES chunks(rid) ON DELETE CASCADE,
  path      TEXT NOT NULL,
  PRIMARY KEY (chunk_rid, path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS chunk_files_path ON chunk_files(path);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='rid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rid, new.text);
END;
-- Decision notes are rows of chunks (kind 'decision') so FTS, vectors, show and
-- search need nothing new; this side table says which group made them and
-- which turns they cite. Deleting the chunk row cascades here.
CREATE TABLE IF NOT EXISTS note_meta (
  chunk_rid INTEGER PRIMARY KEY REFERENCES chunks(rid) ON DELETE CASCADE,
  grp       INTEGER NOT NULL,
  note_kind TEXT NOT NULL,
  sources   TEXT NOT NULL DEFAULT '[]'
);
-- One row per distilled (or attempted) group of a session: the input hash
-- decides whether a group needs distilling again.
CREATE TABLE IF NOT EXISTS distill_groups (
  session_id    TEXT NOT NULL,
  grp           INTEGER NOT NULL,
  input_hash    TEXT NOT NULL,
  status        TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  notes         INTEGER NOT NULL DEFAULT 0,
  distilled_at  INTEGER NOT NULL,
  error         TEXT,
  PRIMARY KEY (session_id, grp)
) WITHOUT ROWID;
`;

// ─── Query parsing ───────────────────────────────────────────────────────────

/**
 * Quoted phrases ("…" or `…`) stay whole; otherwise a term is a run of letters /
 * digits / underscores, optionally joined by . - / : # @ so identifiers, paths,
 * hosts and ticket ids (`src/main/foo.ts`, `git.example.com`, `ABC-DEF-1`)
 * survive as one substring for the trigram index.
 */
const TERM_RE = /"([^"]+)"|`([^`]+)`|([\p{L}\p{N}_]+(?:[.\-/:#@][\p{L}\p{N}_]+)*)/gu;

export interface QueryTerm {
  /** Lower-cased term text (trigram matching is case-insensitive anyway). */
  text: string;
  /** Looks like code / an exact token rather than a natural-language word. */
  identifier: boolean;
}

/**
 * Identifier-like: what dense embeddings blur and exact matching nails. A
 * quoted phrase; camelCase / PascalCase with an inner capital; snake_case;
 * anything containing a digit (ports, IPs, error codes, versions, ticket
 * numbers); dotted / slashed paths and hosts; ASCII kebab-case (CLI flags,
 * package names, `ABC-DEF-TEST`). Plain words — capitalised or not, in any
 * script — and bare acronyms are NOT: those are exactly where dense retrieval
 * already wins, and Cyrillic hyphenations (`будь-який`) are ordinary words.
 */
export function isIdentifierLike(raw: string): boolean {
  if (/\p{N}/u.test(raw)) return true;
  if (/_/.test(raw)) return true;
  if (/\p{Ll}\p{Lu}/u.test(raw) || /\p{Lu}{2}\p{Ll}/u.test(raw)) return true;
  if (/[\p{L}\p{N}][./:#@][\p{L}\p{N}]/u.test(raw)) return true;
  if (/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(raw)) return true;
  return false;
}

export function parseQueryTerms(text: string): QueryTerm[] {
  const out: QueryTerm[] = [];
  const seen = new Set<string>();
  // Control characters (NUL in particular) have no business in a MATCH string.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  for (const m of clean.matchAll(TERM_RE)) {
    const quoted = m[1] ?? m[2];
    const raw = (quoted ?? m[3] ?? '').trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push({ text: lower, identifier: quoted !== undefined || isIdentifierLike(raw) });
    if (out.length >= MAX_QUERY_TERMS) break;
  }
  return out;
}

/**
 * FTS5 MATCH expression: each term as a double-quoted string (inner quotes
 * doubled), OR-ed. Inside an FTS5 string every character is literal, so
 * NEAR/AND/NOT, `*`, `-`, `^`, `:` and parentheses in user text are inert.
 * Returns null when no term is long enough for the trigram index.
 */
export function buildMatchExpression(terms: readonly QueryTerm[]): string | null {
  const parts = terms
    .filter((t) => [...t.text].length >= MIN_TERM_CHARS)
    .map((t) => `"${t.text.replace(/"/g, '""')}"`);
  return parts.length ? parts.join(' OR ') : null;
}

// ─── Snippets ────────────────────────────────────────────────────────────────

/**
 * ~300 chars / a few lines around the best lexical match: the longest query
 * term that occurs (longer = more specific), identifiers first. No match → the
 * start of the chunk. Snapped to a line or word boundary so it reads cleanly.
 */
export function makeSnippet(text: string, terms: readonly QueryTerm[] = []): string {
  const lower = text.toLowerCase();
  let at = -1;
  const ordered = [...terms].sort((a, b) =>
    Number(b.identifier) - Number(a.identifier) || b.text.length - a.text.length);
  for (const t of ordered) {
    if (!t.text) continue;
    const idx = lower.indexOf(t.text);
    if (idx >= 0) { at = idx; break; }
  }
  let start = 0;
  if (at > 0) {
    start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
    const nl = text.lastIndexOf('\n', at);
    if (nl >= start - 40 && nl < at) start = nl + 1;
    else if (start > 0) {
      const sp = text.indexOf(' ', start);
      if (sp >= 0 && sp < at) start = sp + 1;
    }
  }
  let end = Math.min(text.length, start + SNIPPET_CHARS);
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > start + SNIPPET_CHARS / 2) end = sp;
  }
  let body = text.slice(start, end);
  const lines = body.split('\n');
  if (lines.length > SNIPPET_MAX_LINES) {
    body = lines.slice(0, SNIPPET_MAX_LINES).join('\n');
    end = start + body.length;
  }
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

// ─── Vector cache ────────────────────────────────────────────────────────────
// All embedded chunks' vectors in one contiguous Float32Array (slot i at
// [i*DIM, (i+1)*DIM)), with parallel rid / ts arrays. Loaded lazily on the
// first dense search, then patched in place by writes: setVectors appends or
// overwrites, a cleared / deleted vector is removed by moving the last slot
// into the hole. Any failed transaction drops the whole cache instead of trying
// to undo patches; it reloads on the next search.
class VectorCache {
  count = 0;
  data: Float32Array;
  rids: Float64Array;
  ts: Float64Array;
  private slotByRid = new Map<number, number>();

  constructor(capacity = 1024) {
    this.data = new Float32Array(capacity * HISTORY_EMBED_DIM);
    this.rids = new Float64Array(capacity);
    this.ts = new Float64Array(capacity);
  }

  private grow(min: number): void {
    let cap = this.rids.length;
    if (cap >= min) return;
    while (cap < min) cap *= 2;
    const data = new Float32Array(cap * HISTORY_EMBED_DIM);
    data.set(this.data.subarray(0, this.count * HISTORY_EMBED_DIM));
    const rids = new Float64Array(cap);
    rids.set(this.rids.subarray(0, this.count));
    const ts = new Float64Array(cap);
    ts.set(this.ts.subarray(0, this.count));
    this.data = data; this.rids = rids; this.ts = ts;
  }

  set(rid: number, ts: number, vec: Float32Array): void {
    let slot = this.slotByRid.get(rid);
    if (slot === undefined) {
      this.grow(this.count + 1);
      slot = this.count++;
      this.slotByRid.set(rid, slot);
      this.rids[slot] = rid;
    }
    this.ts[slot] = ts;
    this.data.set(vec, slot * HISTORY_EMBED_DIM);
  }

  setTs(rid: number, ts: number): void {
    const slot = this.slotByRid.get(rid);
    if (slot !== undefined) this.ts[slot] = ts;
  }

  remove(rid: number): void {
    const slot = this.slotByRid.get(rid);
    if (slot === undefined) return;
    this.slotByRid.delete(rid);
    const last = --this.count;
    if (slot !== last) {
      const movedRid = this.rids[last];
      this.rids[slot] = movedRid;
      this.ts[slot] = this.ts[last];
      this.data.copyWithin(slot * HISTORY_EMBED_DIM, last * HISTORY_EMBED_DIM, (last + 1) * HISTORY_EMBED_DIM);
      this.slotByRid.set(movedRid, slot);
    }
  }

  /** Top-k slots by dot product (= cosine; both sides are unit length). */
  topK(query: Float32Array, k: number, since: number | undefined): Ranked[] {
    const D = HISTORY_EMBED_DIM;
    const data = this.data;
    const tsArr = this.ts;
    const n = this.count;
    const minTs = since ?? -Infinity;
    // Sorted descending, bounded at k: an insertion is O(k) but after the first
    // few hundred slots almost every candidate loses to the current k-th score.
    const best: Ranked[] = [];
    let floor = -Infinity;
    for (let s = 0; s < n; s++) {
      if (tsArr[s] < minTs) continue;
      let dot = 0;
      const off = s * D;
      for (let j = 0; j < D; j++) dot += data[off + j] * query[j];
      if (best.length >= k && dot <= floor) continue;
      let i = best.length;
      while (i > 0 && best[i - 1].score < dot) i--;
      best.splice(i, 0, { rid: this.rids[s], score: dot });
      if (best.length > k) best.pop();
      if (best.length >= k) floor = best[best.length - 1].score;
    }
    return best;
  }
}

function normalized(vec: Float32Array): Float32Array {
  if (vec.length !== HISTORY_EMBED_DIM) {
    throw new Error(`history: expected a ${HISTORY_EMBED_DIM}-d vector, got ${vec.length}`);
  }
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const out = new Float32Array(vec.length);
  if (!(sum > 0) || !Number.isFinite(sum)) return out;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] * inv;
  return out;
}

function vecToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function blobToVec(blob: Uint8Array): Float32Array | null {
  if (blob.byteLength !== HISTORY_EMBED_DIM * 4) return null;
  // node:sqlite hands back a fresh buffer, but don't rely on its alignment.
  if (blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, HISTORY_EMBED_DIM);
  return new Float32Array(blob.slice().buffer);
}

// ─── Store ───────────────────────────────────────────────────────────────────

/** A candidate during ranking; higher score is better. */
interface Ranked {
  rid: number;
  score: number;
  /** Matched an identifier term lexically (hybrid tie-break). */
  exact?: boolean;
}

interface ChunkRow {
  rid: number;
  id: string;
  session_id: string;
  seq: number;
  ts: number;
  kind: string;
  text: string;
  hash: string;
  embedded?: number;
  title?: string | null;
  note_kind?: string | null;
  sources?: string | null;
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  file: string;
  cwds: string;
  title: string | null;
  git_branch: string | null;
  first_ts: number;
  last_ts: number;
  chunk_count?: number;
}

function parseCwds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function sessionFromRow(r: SessionRow): StoredSession {
  return {
    id: r.id,
    file: r.file,
    ...(r.parent_id ? { parentSessionId: r.parent_id } : {}),
    cwds: parseCwds(r.cwds),
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    ...(r.title ? { title: r.title } : {}),
    ...(r.git_branch ? { gitBranch: r.git_branch } : {}),
    chunkCount: r.chunk_count ?? 0,
  };
}

function clampLimit(limit: number | undefined, fallback: number, max = MAX_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

export class HistoryStore {
  private db: DatabaseSync;
  private readonly dbPath: string;
  private statements = new Map<string, StatementSync>();
  private cache: VectorCache | null = null;
  private closed = false;

  private constructor(db: DatabaseSync, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /**
   * Open (creating if needed) the store at `dbPath`; `':memory:'` for tests.
   * The file is pre-created with mode 0600 — SQLite creates its -wal / -shm
   * siblings with the main file's permissions, so they inherit it.
   */
  static open(dbPath: string): HistoryStore {
    const { DatabaseSync: Db } = loadSqlite();
    const inMemory = dbPath === ':memory:' || dbPath === '';
    if (!inMemory) {
      if (!existsSync(dbPath)) {
        try { writeFileSync(dbPath, '', { mode: 0o600, flag: 'wx' }); } catch { /* raced: someone created it */ }
      }
      try { chmodSync(dbPath, 0o600); } catch { /* best effort (Windows ignores modes) */ }
    }
    const db = new Db(inMemory ? ':memory:' : dbPath);
    const store = new HistoryStore(db, inMemory ? ':memory:' : dbPath);
    try {
      store.init(inMemory);
    } catch (err) {
      try { db.close(); } catch { /* ignore */ }
      throw err;
    }
    return store;
  }

  private init(inMemory: boolean): void {
    if (!inMemory) this.db.exec('PRAGMA journal_mode = WAL');
    // NORMAL under WAL can lose the last commits on power loss but never
    // corrupts; everything here is re-derivable from transcripts still on disk.
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    const row = this.tryGetVersion();
    if (row !== null && row > SCHEMA_VERSION) {
      throw new Error(`history: ${this.dbPath} has schema v${row}, newer than supported v${SCHEMA_VERSION}`);
    }
    this.tx(() => {
      this.db.exec(SCHEMA_SQL);
      this.stmt('INSERT OR REPLACE INTO meta(key, value) VALUES (\'schema_version\', ?)').run(String(SCHEMA_VERSION));
    });
  }

  private tryGetVersion(): number | null {
    try {
      const r = this.db.prepare('SELECT value FROM meta WHERE key = \'schema_version\'').get() as { value?: string } | undefined;
      const v = r?.value ? Number(r.value) : NaN;
      return Number.isFinite(v) ? v : null;
    } catch {
      return null; // fresh DB: no meta table yet
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.cache = null;
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    if (this.closed) throw new Error('history: store is closed');
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      this.cache = null; // in-place patches may now disagree with the DB
      throw err;
    }
  }

  // ─── Files ─────────────────────────────────────────────────────────────────

  getFileState(path: string): FileState | undefined {
    const r = this.stmt('SELECT size, mtime_ms, session_id FROM files WHERE path = ?').get(path) as
      { size: number; mtime_ms: number; session_id: string | null } | undefined;
    if (!r) return undefined;
    return { size: r.size, mtimeMs: r.mtime_ms, ...(r.session_id ? { sessionId: r.session_id } : {}) };
  }

  setFileState(path: string, state: FileState): void {
    this.stmt(`INSERT INTO files(path, size, mtime_ms, session_id) VALUES (?, ?, ?, ?)
               ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
               session_id = excluded.session_id`)
      .run(path, state.size, Math.round(state.mtimeMs), state.sessionId ?? null);
  }

  // ─── Sessions & chunks ─────────────────────────────────────────────────────

  upsertSession(meta: SessionMeta): void {
    this.stmt(`INSERT INTO sessions(id, parent_id, file, cwds, title, git_branch, first_ts, last_ts)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, file = excluded.file,
               cwds = excluded.cwds, title = excluded.title, git_branch = excluded.git_branch,
               first_ts = excluded.first_ts, last_ts = excluded.last_ts`)
      .run(
        meta.id, meta.parentSessionId ?? null, meta.file, JSON.stringify(meta.cwds ?? []),
        meta.title ?? null, meta.gitBranch ?? null, meta.firstTs || 0, meta.lastTs || 0,
      );
  }

  /**
   * Make the session's stored chunks exactly `chunks`, in one transaction: new
   * ids are inserted, ids whose hash changed get the new text/files and lose
   * their vector, ids no longer present are deleted (FTS follows via
   * triggers). Returns the ids that need (re)embedding.
   *
   * Decision notes of the session are not transcript chunks and are left
   * alone: they are replaced per group by replaceGroupNotes, and a turn that
   * changed only makes its group's input hash differ, so the group is
   * re-distilled later instead of its notes vanishing now.
   */
  replaceSessionChunks(sessionId: string, chunks: readonly TranscriptChunk[]): string[] {
    return this.tx(() => {
      const existing = new Map<string, { rid: number; hash: string; seq: number; ts: number; kind: string }>();
      for (const r of this.stmt("SELECT rid, id, hash, seq, ts, kind FROM chunks WHERE session_id = ? AND kind != 'decision'").all(sessionId) as unknown as ChunkRow[]) {
        existing.set(r.id, r);
      }
      const insert = this.stmt(`INSERT INTO chunks(id, session_id, seq, ts, kind, text, hash)
                                VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING rid`);
      const update = this.stmt('UPDATE chunks SET seq = ?, ts = ?, kind = ?, text = ?, hash = ?, vec = NULL WHERE rid = ?');
      const touch = this.stmt('UPDATE chunks SET seq = ?, ts = ?, kind = ? WHERE rid = ?');
      const clearFiles = this.stmt('DELETE FROM chunk_files WHERE chunk_rid = ?');
      const addFile = this.stmt('INSERT OR IGNORE INTO chunk_files(chunk_rid, path) VALUES (?, ?)');
      const del = this.stmt('DELETE FROM chunks WHERE rid = ?');

      const toEmbed: string[] = [];
      const seen = new Set<string>();
      for (const c of chunks) {
        if (c.sessionId !== sessionId) {
          throw new Error(`history: chunk ${c.id} belongs to ${c.sessionId}, not ${sessionId}`);
        }
        if (c.kind === 'decision') throw new Error(`history: ${c.id} is a note; use replaceGroupNotes`);
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        const ts = Math.round(c.ts || 0);
        const prev = existing.get(c.id);
        if (!prev) {
          const r = insert.get(c.id, sessionId, c.seq, ts, c.kind, c.text, c.hash) as { rid: number };
          for (const f of c.files) addFile.run(r.rid, f);
          toEmbed.push(c.id);
        } else if (prev.hash !== c.hash) {
          update.run(c.seq, ts, c.kind, c.text, c.hash, prev.rid);
          clearFiles.run(prev.rid);
          for (const f of c.files) addFile.run(prev.rid, f);
          this.cache?.remove(prev.rid);
          toEmbed.push(c.id);
        } else if (prev.seq !== c.seq || prev.ts !== ts || prev.kind !== c.kind) {
          touch.run(c.seq, ts, c.kind, prev.rid);
          this.cache?.setTs(prev.rid, ts);
        }
      }
      for (const [id, prev] of existing) {
        if (seen.has(id)) continue;
        del.run(prev.rid);
        this.cache?.remove(prev.rid);
      }
      return toEmbed;
    });
  }

  /** Chunks still lacking a vector, oldest session first, so a backlog drains in order. */
  pendingEmbeddings(limit: number): PendingEmbedding[] {
    const n = clampLimit(limit, 32, 10_000);
    return this.stmt('SELECT id, text, hash FROM chunks WHERE vec IS NULL ORDER BY ts, rid LIMIT ?')
      .all(n) as unknown as PendingEmbedding[];
  }

  /** Store vectors (re-normalized defensively). Returns how many were stored. */
  setVectors(items: readonly ChunkVector[]): number {
    if (!items.length) return 0;
    return this.tx(() => {
      const withHash = this.stmt('UPDATE chunks SET vec = ? WHERE id = ? AND hash = ? RETURNING rid, ts');
      const anyHash = this.stmt('UPDATE chunks SET vec = ? WHERE id = ? RETURNING rid, ts');
      let stored = 0;
      for (const item of items) {
        const vec = normalized(item.vector);
        const blob = vecToBlob(vec);
        const r = (item.hash !== undefined
          ? withHash.get(blob, item.id, item.hash)
          : anyHash.get(blob, item.id)) as { rid: number; ts: number } | undefined;
        if (!r) continue; // chunk gone or changed since it was handed out
        stored++;
        this.cache?.set(r.rid, r.ts, vec);
      }
      return stored;
    });
  }

  getChunk(id: string): StoredChunk | undefined {
    const r = this.stmt(`SELECT c.rid, c.id, c.session_id, c.seq, c.ts, c.kind, c.text, c.hash,
                         c.vec IS NOT NULL AS embedded, s.title, m.note_kind, m.sources
                         FROM chunks c LEFT JOIN sessions s ON s.id = c.session_id
                         LEFT JOIN note_meta m ON m.chunk_rid = c.rid WHERE c.id = ?`)
      .get(id) as ChunkRow | undefined;
    return r ? this.chunkFromRow(r) : undefined;
  }

  /**
   * A session's chunks in order; with `aroundChunkId`, only the `radius`
   * (default 2) chunks on each side of it — "show me the surrounding turns".
   *
   * Decision notes are not turns: they never appear as neighbours, and
   * anchoring on a note returns just that note (its text cites its sources).
   */
  getSessionChunks(sessionId: string, opts: { aroundChunkId?: string; radius?: number } = {}): StoredChunk[] {
    const base = `SELECT c.rid, c.id, c.session_id, c.seq, c.ts, c.kind, c.text, c.hash,
                  c.vec IS NOT NULL AS embedded, s.title
                  FROM chunks c LEFT JOIN sessions s ON s.id = c.session_id
                  WHERE c.session_id = ? AND c.kind != 'decision'`;
    let rows: ChunkRow[];
    if (opts.aroundChunkId) {
      const anchor = this.stmt('SELECT seq, kind FROM chunks WHERE id = ? AND session_id = ?')
        .get(opts.aroundChunkId, sessionId) as { seq: number; kind: string } | undefined;
      if (!anchor) return [];
      if (anchor.kind === 'decision') {
        const note = this.getChunk(opts.aroundChunkId);
        return note ? [note] : [];
      }
      const radius = Math.max(0, Math.floor(opts.radius ?? 2));
      rows = this.stmt(`${base} AND c.seq BETWEEN ? AND ? ORDER BY c.seq`)
        .all(sessionId, anchor.seq - radius, anchor.seq + radius) as unknown as ChunkRow[];
    } else {
      rows = this.stmt(`${base} ORDER BY c.seq`).all(sessionId) as unknown as ChunkRow[];
    }
    return rows.map((r) => this.chunkFromRow(r));
  }

  private chunkFromRow(r: ChunkRow): StoredChunk {
    const files = (this.stmt('SELECT path FROM chunk_files WHERE chunk_rid = ? ORDER BY path').all(r.rid) as Array<{ path: string }>)
      .map((f) => f.path);
    return {
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      ts: r.ts,
      kind: r.kind as ChunkKind,
      text: r.text,
      files,
      hash: r.hash,
      embedded: !!r.embedded,
      ...(r.title ? { sessionTitle: r.title } : {}),
      ...(r.note_kind ? { note: { kind: r.note_kind as DecisionNoteKind, sources: parseCwds(r.sources ?? '[]') } } : {}),
    };
  }

  /** Newest sessions first (by last activity), optionally only those active since `since`. */
  listSessions(limit: number, since?: number): StoredSession[] {
    const n = clampLimit(limit, 20, 10_000);
    const rows = this.stmt(`SELECT s.*, (SELECT COUNT(*) FROM chunks c WHERE c.session_id = s.id AND c.kind != 'decision') AS chunk_count
                            FROM sessions s WHERE s.last_ts >= ? ORDER BY s.last_ts DESC, s.id LIMIT ?`)
      .all(since ?? -Number.MAX_SAFE_INTEGER, n) as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  /**
   * Sessions whose turns created/edited `path`, newest edit first. An absolute
   * path matches exactly; a relative one (`src/foo.ts`) also matches as a
   * path suffix, since agents often only know the repo-relative name.
   */
  sessionsForFile(path: string, limit = 10): FileHistoryEntry[] {
    const n = clampLimit(limit, 10);
    const rel = path.replace(/^\.\//, '');
    const isAbs = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
    const sql = `SELECT c.id, c.session_id, c.seq, c.ts, c.text, s.title, s.git_branch
                 FROM chunk_files f JOIN chunks c ON c.rid = f.chunk_rid
                 LEFT JOIN sessions s ON s.id = c.session_id
                 WHERE ${isAbs ? 'f.path = ?' : "(f.path = ? OR f.path LIKE ? ESCAPE '\\')"}
                 ORDER BY c.ts DESC, c.seq DESC LIMIT ?`;
    const params: SQLInputValue[] = isAbs
      ? [path]
      : [rel, `%/${rel.replace(/[\\%_]/g, (ch) => `\\${ch}`)}`];
    const rows = this.stmt(sql).all(...params, n * 50) as unknown as Array<ChunkRow & { git_branch: string | null }>;
    const bySession = new Map<string, FileHistoryEntry>();
    for (const r of rows) {
      let entry = bySession.get(r.session_id);
      if (!entry) {
        if (bySession.size >= n) continue;
        entry = {
          sessionId: r.session_id,
          ...(r.title ? { sessionTitle: r.title } : {}),
          ...(r.git_branch ? { gitBranch: r.git_branch } : {}),
          lastTs: r.ts,
          chunks: [],
        };
        bySession.set(r.session_id, entry);
      }
      if (!entry.chunks.some((c) => c.chunkId === r.id)) {
        entry.chunks.push({ chunkId: r.id, seq: r.seq, ts: r.ts, snippet: makeSnippet(r.text) });
      }
    }
    return [...bySession.values()];
  }

  /** Remove a session with its chunks, FTS rows, vectors and file-state rows. */
  deleteSession(id: string): void {
    this.tx(() => {
      const rids = this.stmt('SELECT rid FROM chunks WHERE session_id = ?').all(id) as Array<{ rid: number }>;
      this.stmt('DELETE FROM chunks WHERE session_id = ?').run(id);
      this.stmt('DELETE FROM sessions WHERE id = ?').run(id);
      this.stmt('DELETE FROM files WHERE session_id = ?').run(id);
      this.stmt('DELETE FROM distill_groups WHERE session_id = ?').run(id);
      for (const r of rids) this.cache?.remove(r.rid);
    });
  }

  stats(): HistoryStats {
    const counts = this.stmt(`SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
                              (SELECT COUNT(*) FROM chunks) AS chunks,
                              (SELECT COUNT(*) FROM chunks WHERE vec IS NOT NULL) AS embedded`)
      .get() as { sessions: number; chunks: number; embedded: number };
    let dbBytes = 0;
    if (this.dbPath === ':memory:') {
      const pc = this.stmt('PRAGMA page_count').get() as { page_count: number };
      const ps = this.stmt('PRAGMA page_size').get() as { page_size: number };
      dbBytes = pc.page_count * ps.page_size;
    } else {
      for (const p of [this.dbPath, `${this.dbPath}-wal`]) {
        try { dbBytes += statSync(p).size; } catch { /* no WAL right now */ }
      }
    }
    return { sessions: counts.sessions, chunks: counts.chunks, embeddedChunks: counts.embedded, dbBytes };
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  private ensureCache(): VectorCache {
    if (this.cache) return this.cache;
    const n = (this.stmt('SELECT COUNT(*) AS n FROM chunks WHERE vec IS NOT NULL').get() as { n: number }).n;
    const cache = new VectorCache(Math.max(1024, n));
    for (const r of this.stmt('SELECT rid, ts, vec FROM chunks WHERE vec IS NOT NULL').iterate() as Iterable<{ rid: number; ts: number; vec: Uint8Array }>) {
      const v = blobToVec(r.vec);
      if (v) cache.set(r.rid, r.ts, v);
    }
    this.cache = cache;
    return cache;
  }

  /** rid → bm25 rank list (best first) for a MATCH expression. */
  private lexicalRanks(match: string, since: number | undefined, k: number): Ranked[] {
    const rows = this.stmt(`SELECT c.rid AS rid, bm25(chunks_fts) AS r
                            FROM chunks_fts JOIN chunks c ON c.rid = chunks_fts.rowid
                            WHERE chunks_fts MATCH ? AND c.ts >= ?
                            ORDER BY r LIMIT ?`)
      .all(match, since ?? -Number.MAX_SAFE_INTEGER, k) as Array<{ rid: number; r: number }>;
    // bm25() is "lower is better"; flip so every score in this file is "higher is better".
    return rows.map((row) => ({ rid: row.rid, score: -row.r }));
  }

  /**
   * Terms too short for the trigram index (`UI`, `CC`): with no vector to fall
   * back on, a LIKE scan is the only way to find them. Newest first; it is a
   * full scan, but only ever for a query of nothing but 1–2 char words.
   */
  private likeRanks(terms: readonly QueryTerm[], since: number | undefined, k: number): Ranked[] {
    const words = terms.map((t) => t.text).filter(Boolean).slice(0, 4);
    if (!words.length) return [];
    const where = words.map(() => "c.text LIKE ? ESCAPE '\\'").join(' OR ');
    const params = words.map((w) => `%${w.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    const rows = this.stmt(`SELECT c.rid AS rid FROM chunks c WHERE (${where}) AND c.ts >= ?
                            ORDER BY c.ts DESC LIMIT ?`)
      .all(...params, since ?? -Number.MAX_SAFE_INTEGER, k) as Array<{ rid: number }>;
    return rows.map((r, i) => ({ rid: r.rid, score: 1 / (i + 1) }));
  }

  /**
   * Search the workspace history.
   *
   * Fusion — identifier-gated RRF. The spike (500 real chunks, 20 queries,
   * mostly Ukrainian paraphrases, some English→Ukrainian) measured dense alone
   * at MRR 0.818, BM25 at 0.638, and equal-weight RRF of the two at 0.751: on
   * natural-language queries the lexical leg only adds noise, because exact
   * word matching can't see paraphrase, translation or Ukrainian inflection
   * (`сервера` ≠ `сервер`). Where it is genuinely better is exact tokens —
   * `parseConfig`, `ABC-DEF-TEST`, `502`, `src/foo.ts`, a quoted phrase —
   * which embeddings blur. So:
   *
   *   - The lexical leg runs only on the query's identifier-like terms (see
   *     isIdentifierLike), never on its ordinary words.
   *   - If there are none, results are dense only.
   *   - If there are, dense and lexical top-100 lists are fused with standard
   *     RRF (k=60, equal weights): a chunk containing the exact token can climb
   *     past paraphrase-similar neighbours, and one dense missed entirely can
   *     still surface.
   *
   * The rule is a property of the query, not a tuned weight, so it doesn't
   * overfit 20 queries. Measured through this class: on the spike set the gate
   * fires on 5/20 queries and hybrid equals dense exactly (MRR 0.817 vs 0.817;
   * RRF over all terms 0.743, weighted RRF with w_lex 0.1–0.5 0.74–0.78). On 40
   * mechanically generated exact-identifier lookups over the same corpus,
   * dense alone gets MRR 0.30 (0.19 when wrapped in a Ukrainian phrase) and
   * this hybrid 1.00 (lexical alone is 1.00 there by construction; the point is
   * that fusion keeps it) — that is what the lexical leg is for.
   *
   * Without a vector (runtime unavailable) search is lexical over all terms,
   * ranked by bm25; with nothing ≥3 chars, a LIKE scan.
   *
   * Ties on score: a chunk that contains one of the exact identifiers wins
   * (with equal weights, "lexical #1 that dense missed" and "dense #1 without
   * the token" score exactly the same, and the user did type the token), then
   * the newer chunk. Pure tie-breaks: they never reorder distinct scores.
   *
   * `score` is comparable within one result list only (cosine for dense, -bm25
   * for lexical, RRF sum for hybrid).
   */
  search(q: SearchQuery, opts: { mode?: SearchMode } = {}): SearchHit[] {
    const limit = clampLimit(q.limit, DEFAULT_LIMIT);
    const since = q.since;
    const terms = parseQueryTerms(q.text ?? '');
    const mode: SearchMode = opts.mode ?? (q.vector ? 'hybrid' : 'lexical');
    if ((mode === 'hybrid' || mode === 'dense') && !q.vector) {
      throw new Error(`history: ${mode} search needs a query vector`);
    }

    let ranked: Ranked[];
    if (mode === 'lexical') {
      const match = buildMatchExpression(terms);
      ranked = match ? this.lexicalRanks(match, since, limit) : this.likeRanks(terms, since, limit);
    } else {
      const qv = normalized(q.vector as Float32Array);
      const dense = this.ensureCache().topK(qv, mode === 'dense' ? limit : FUSION_CANDIDATES, since);
      const match = mode === 'hybrid' ? buildMatchExpression(terms.filter((t) => t.identifier)) : null;
      if (!match) {
        ranked = dense.slice(0, limit);
      } else {
        const lexical = this.lexicalRanks(match, since, FUSION_CANDIDATES);
        const fused = new Map<number, Ranked>();
        const add = (rid: number, rank: number, exact: boolean) => {
          const entry = fused.get(rid) ?? { rid, score: 0 };
          entry.score += 1 / (RRF_K + rank + 1);
          if (exact) entry.exact = true;
          fused.set(rid, entry);
        };
        dense.forEach((h, i) => add(h.rid, i, false));
        lexical.forEach((h, i) => add(h.rid, i, true));
        ranked = [...fused.values()];
      }
    }
    return this.hydrate(ranked, terms, limit);
  }

  private hydrate(ranked: Ranked[], terms: readonly QueryTerm[], limit: number): SearchHit[] {
    const get = this.stmt(`SELECT c.id, c.session_id, c.ts, c.kind, c.text, s.title, m.note_kind, m.sources
                           FROM chunks c LEFT JOIN sessions s ON s.id = c.session_id
                           LEFT JOIN note_meta m ON m.chunk_rid = c.rid WHERE c.rid = ?`);
    // Cut to the top `limit` (plus anything tied with the last one, so the
    // recency tie-break below sees every contender) before touching rows.
    const byScore = [...ranked].sort((a, b) => b.score - a.score);
    const cutoff = byScore[Math.min(limit, byScore.length) - 1]?.score ?? -Infinity;
    const rows = byScore
      .filter((h, i) => i < limit || h.score === cutoff)
      .map((h) => ({ h, row: get.get(h.rid) as ChunkRow | undefined }))
      .filter((x): x is { h: Ranked; row: ChunkRow } => !!x.row);
    rows.sort((a, b) => b.h.score - a.h.score
      || Number(!!b.h.exact) - Number(!!a.h.exact)
      || b.row.ts - a.row.ts);
    return rows.slice(0, limit).map(({ h, row }) => ({
      chunkId: row.id,
      sessionId: row.session_id,
      ts: row.ts,
      kind: row.kind as ChunkKind,
      snippet: makeSnippet(row.text, terms),
      score: h.score,
      ...(row.title ? { sessionTitle: row.title } : {}),
      ...(row.note_kind ? { note: { kind: row.note_kind as DecisionNoteKind, sources: parseCwds(row.sources ?? '[]') } } : {}),
    }));
  }

  // ─── Decision notes ────────────────────────────────────────────────────────
  // See distill.ts. Notes are chunks of their source session (kind 'decision',
  // id `<sid>:n<group>.<i>`), so they are embedded through pendingEmbeddings and
  // found by search like any turn. Ranking gives them NO boost: a note is short
  // and on-topic, which already favours it in both legs, and a tuned weight is
  // exactly what the fusion rule above avoids.

  /**
   * Main sessions (subagent transcripts are excluded: their findings reach the
   * parent session as the Agent tool's result, so distilling both would pay
   * twice for the same content) with their turn chunks' lengths and hashes, in
   * seq order. Compaction summaries are excluded too: they recap turns that are
   * already in the same transcript. No text is read beyond its length.
   */
  distillCandidates(): DistillCandidate[] {
    const sessions = this.stmt('SELECT id, title, last_ts FROM sessions WHERE parent_id IS NULL')
      .all() as Array<{ id: string; title: string | null; last_ts: number }>;
    const byId = new Map<string, DistillCandidate>();
    for (const s of sessions) {
      byId.set(s.id, { sessionId: s.id, ...(s.title ? { title: s.title } : {}), lastTs: s.last_ts, chunks: [] });
    }
    const rows = this.stmt(`SELECT session_id, id, seq, hash, length(text) AS chars, ts FROM chunks
                            WHERE kind = 'turn' ORDER BY session_id, seq, rid`)
      .iterate() as Iterable<{ session_id: string; id: string; seq: number; hash: string; chars: number; ts: number }>;
    for (const r of rows) {
      byId.get(r.session_id)?.chunks.push({ id: r.id, seq: r.seq, hash: r.hash, chars: r.chars, ts: r.ts });
    }
    return [...byId.values()].filter((c) => c.chunks.length > 0);
  }

  /** Text of the given chunks, in the order given (missing ids are skipped). */
  getChunkTexts(ids: readonly string[]): Array<{ id: string; seq: number; ts: number; text: string }> {
    const get = this.stmt('SELECT id, seq, ts, text FROM chunks WHERE id = ?');
    return ids
      .map((id) => get.get(id) as { id: string; seq: number; ts: number; text: string } | undefined)
      .filter((r): r is { id: string; seq: number; ts: number; text: string } => !!r);
  }

  /** Distillation state of every group of a session, by group index. */
  groupStates(sessionId: string): Map<number, DistillGroupState> {
    const rows = this.stmt('SELECT * FROM distill_groups WHERE session_id = ?').all(sessionId) as Array<{
      grp: number; input_hash: string; status: string; attempts: number; cost_usd: number;
      input_tokens: number; output_tokens: number; notes: number; distilled_at: number; error: string | null;
    }>;
    return new Map(rows.map((r) => [r.grp, {
      group: r.grp,
      inputHash: r.input_hash,
      status: r.status === 'ok' ? 'ok' : 'error',
      attempts: r.attempts,
      costUsd: r.cost_usd,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      notes: r.notes,
      distilledAt: r.distilled_at,
      ...(r.error ? { error: r.error } : {}),
    } satisfies DistillGroupState]));
  }

  /**
   * Make the notes of one group of a session exactly `notes`: the group's old
   * notes go (FTS and vectors with them), the new ones are inserted unembedded.
   * Other groups' notes and the session's turns are untouched. With `run`, the
   * group's distillation state is recorded in the same transaction, so notes
   * and "this input was distilled" can never disagree.
   */
  replaceGroupNotes(sessionId: string, group: number, notes: readonly NoteInput[], run?: DistillRunRecord): string[] {
    return this.tx(() => {
      this.deleteGroupNotes(sessionId, group);
      const insert = this.stmt(`INSERT INTO chunks(id, session_id, seq, ts, kind, text, hash)
                                VALUES (?, ?, ?, ?, 'decision', ?, ?) RETURNING rid`);
      const meta = this.stmt('INSERT INTO note_meta(chunk_rid, grp, note_kind, sources) VALUES (?, ?, ?, ?)');
      const ids: string[] = [];
      for (const n of notes) {
        if (n.sessionId !== sessionId) throw new Error(`history: note ${n.id} belongs to ${n.sessionId}, not ${sessionId}`);
        const r = insert.get(n.id, sessionId, n.seq, Math.round(n.ts || 0), n.text, n.hash) as { rid: number };
        meta.run(r.rid, group, n.noteKind, JSON.stringify(n.sources));
        ids.push(n.id);
      }
      if (run) this.recordGroupRun(sessionId, group, { ...run, ok: true }, notes.length);
      return ids;
    });
  }

  /** The stored notes of one group, in id order (for copying to another workspace's DB). */
  getGroupNotes(sessionId: string, group: number): NoteInput[] {
    const rows = this.stmt(`SELECT c.id, c.session_id, c.seq, c.ts, c.text, c.hash, m.note_kind, m.sources
                            FROM chunks c JOIN note_meta m ON m.chunk_rid = c.rid
                            WHERE c.session_id = ? AND m.grp = ? ORDER BY c.rid`)
      .all(sessionId, group) as unknown as Array<ChunkRow & { note_kind: string; sources: string }>;
    return rows.map((r) => ({
      id: r.id, sessionId: r.session_id, seq: r.seq, ts: r.ts, kind: 'decision' as const,
      text: r.text, files: [], hash: r.hash, noteKind: r.note_kind as DecisionNoteKind, sources: parseCwds(r.sources),
    }));
  }

  private deleteGroupNotes(sessionId: string, group: number): void {
    const rows = this.stmt(`SELECT c.rid FROM chunks c JOIN note_meta m ON m.chunk_rid = c.rid
                            WHERE c.session_id = ? AND m.grp = ?`).all(sessionId, group) as Array<{ rid: number }>;
    const del = this.stmt('DELETE FROM chunks WHERE rid = ?');
    for (const r of rows) {
      del.run(r.rid);
      this.cache?.remove(r.rid);
    }
  }

  /**
   * Record one distillation run of a group. Success resets attempts and stores
   * the note count; a failure keeps the previous notes, and bumps attempts only
   * when it counts. Cost accumulates per group and into the DB-wide spent total,
   * which deleteNotes keeps: money spent stays spent.
   */
  recordGroupRun(sessionId: string, group: number, run: DistillRunRecord, notes?: number): void {
    this.tx(() => {
      const prev = this.groupStates(sessionId).get(group);
      const sameInput = prev?.inputHash === run.inputHash;
      const attempts = run.ok ? 0 : (sameInput ? prev!.attempts : 0) + (run.countsAsAttempt ? 1 : 0);
      this.stmt(`INSERT INTO distill_groups(session_id, grp, input_hash, status, attempts, cost_usd, input_tokens,
                   output_tokens, notes, distilled_at, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(session_id, grp) DO UPDATE SET input_hash = excluded.input_hash, status = excluded.status,
                   attempts = excluded.attempts, cost_usd = distill_groups.cost_usd + excluded.cost_usd,
                   input_tokens = distill_groups.input_tokens + excluded.input_tokens,
                   output_tokens = distill_groups.output_tokens + excluded.output_tokens,
                   notes = excluded.notes, distilled_at = excluded.distilled_at, error = excluded.error`)
        .run(
          sessionId, group, run.inputHash, run.ok ? 'ok' : 'error', attempts, run.costUsd || 0,
          Math.round(run.inputTokens || 0), Math.round(run.outputTokens || 0),
          run.ok ? (notes ?? 0) : (prev?.notes ?? 0), Math.round(run.at), run.ok ? null : (run.error ?? 'failed'),
        );
      if (run.costUsd > 0) {
        this.stmt(`INSERT INTO meta(key, value) VALUES ('distill_spent_usd', ?)
                   ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS REAL) + CAST(excluded.value AS REAL) AS TEXT)`)
          .run(String(run.costUsd));
      }
    });
  }

  /** Drop the notes and state of groups at index >= `groupCount` (the session's grouping shrank). */
  pruneGroups(sessionId: string, groupCount: number): void {
    const stale = [...this.groupStates(sessionId).keys()].filter((g) => g >= groupCount);
    if (!stale.length) return;
    this.tx(() => {
      for (const g of stale) {
        this.deleteGroupNotes(sessionId, g);
        this.stmt('DELETE FROM distill_groups WHERE session_id = ? AND grp = ?').run(sessionId, g);
      }
    });
  }

  /** Delete every note and every group's state; returns how many notes went. The spent total stays. */
  deleteNotes(): number {
    return this.tx(() => {
      const rids = this.stmt("SELECT rid FROM chunks WHERE kind = 'decision'").all() as Array<{ rid: number }>;
      this.stmt("DELETE FROM chunks WHERE kind = 'decision'").run();
      this.stmt('DELETE FROM distill_groups').run();
      for (const r of rids) this.cache?.remove(r.rid);
      return rids.length;
    });
  }

  /** Notes stored and total spent on distillation in this DB. */
  distillTotals(): { notes: number; spentUsd: number } {
    const r = this.stmt(`SELECT (SELECT COUNT(*) FROM chunks WHERE kind = 'decision') AS notes,
                         (SELECT value FROM meta WHERE key = 'distill_spent_usd') AS spent`)
      .get() as { notes: number; spent: string | null };
    const spent = Number(r.spent ?? 0);
    return { notes: r.notes, spentUsd: Number.isFinite(spent) ? spent : 0 };
  }
}
