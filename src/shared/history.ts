// ─── Workspace history: shared contract ──────────────────────────────────────
// Opt-in feature (AppSettings.historyEnabled, off by default): archive every
// Claude Code session that ran inside a workspace's folder, index it, and let
// agents search it via the sg-history skill. Nothing in src/main/history may
// download, spawn, watch or write anything until the user has consented.
//
// Modules (src/main/history/):
//   transcripts.ts  parse ~/.claude/projects/**/*.jsonl into turn-level chunks
//   store.ts        one node:sqlite DB per workspace (chunks, FTS, vectors)
//   runtime.ts      download/verify/spawn llama-server + the embedding model
//   indexer.ts      orchestrates the above (scan, ingest, embed, watch)

/** Embedding width stored and searched (EmbeddingGemma 2, MRL-truncated). */
export const HISTORY_EMBED_DIM = 256;

/** One Claude Code transcript file, as found under ~/.claude/projects. */
export interface SessionMeta {
  /** Session id (file stem for a main session, `agent-…` for a subagent). */
  id: string;
  /** Absolute path of the .jsonl file. */
  file: string;
  /** Main session id this subagent transcript belongs to; undefined for a main session. */
  parentSessionId?: string;
  /** Every distinct `cwd` seen in the file's records (used for workspace matching). */
  cwds: string[];
  /** First / last record timestamp, ms since epoch (0 when unknown). */
  firstTs: number;
  lastTs: number;
  /** `ai-title` record, when Claude Code wrote one. */
  title?: string;
  gitBranch?: string;
}

/**
 * `decision` is a machine-written note distilled from a session's turns (see
 * src/main/history/distill.ts), stored alongside them; never produced by
 * transcript parsing.
 */
export type ChunkKind = 'turn' | 'compact_summary' | 'decision';

/** What a decision note records (AppSettings.historyDistill). */
export type DecisionNoteKind = 'decision' | 'rejected' | 'gotcha' | 'convention';

/**
 * One retrievable unit: a user prompt plus everything the assistant said and
 * thought until the next user prompt (or a compaction summary). Ids are
 * deterministic (`<sessionId>:<seq>`) so re-parsing a grown file yields the same
 * ids and only new/changed chunks are re-embedded.
 */
export interface TranscriptChunk {
  id: string;
  sessionId: string;
  seq: number;
  /** Timestamp of the chunk's first record, ms since epoch. */
  ts: number;
  kind: ChunkKind;
  /** Redacted display text: `User: …\n\nAssistant: …`, thinking marked `[thinking]`. */
  text: string;
  /** Files the assistant created/edited in this turn (Edit/Write/NotebookEdit inputs), absolute paths. */
  files: string[];
  /** Stable content hash of `text` + `files`, used to detect changed chunks. */
  hash: string;
}

export interface ParsedTranscript {
  meta: SessionMeta;
  chunks: TranscriptChunk[];
}

/** Produces L2-normalized HISTORY_EMBED_DIM vectors. */
export interface Embedder {
  embed(texts: string[], kind: 'document' | 'query'): Promise<Float32Array[]>;
}

export interface SearchHit {
  chunkId: string;
  sessionId: string;
  ts: number;
  kind: ChunkKind;
  /** Short excerpt around the best match (a few lines), not the whole chunk. */
  snippet: string;
  score: number;
  sessionTitle?: string;
  /** Set on a `decision` hit: the note's kind and the chunk ids of the turns it was distilled from. */
  note?: { kind: DecisionNoteKind; sources: string[] };
}

export interface SearchQuery {
  text: string;
  /** Query embedding; when absent (runtime unavailable) search is lexical only. */
  vector?: Float32Array;
  limit?: number;
  /** Only chunks at or after this time (ms since epoch). */
  since?: number;
}

/**
 * What the user is consenting to, shown next to the Settings toggle before
 * anything is installed. Computed from `stat()` of the transcript files only —
 * reading transcripts or touching the network needs consent first.
 */
export interface HistoryEstimate {
  /** Transcript files under the Claude projects dir that fall in some workspace folder. */
  transcriptFiles: number;
  transcriptBytes: number;
  /** llama-server archive + embedding model download size. */
  downloadBytes: number;
  /** Rough on-disk size of runtime + all workspace indexes. */
  diskBytes: number;
  /** Rough first-import duration on this machine, minutes. */
  firstImportMinutes: number;
}

export interface HistoryWorkspaceStats {
  workspaceId: string;
  sessions: number;
  chunks: number;
  embeddedChunks: number;
  dbBytes: number;
}

export interface HistoryStatus {
  enabled: boolean;
  progress: HistoryProgress;
  workspaces: HistoryWorkspaceStats[];
  /** Decision-note distillation; absent until the service has looked at its state. */
  distill?: HistoryDistillStatus;
}

/**
 * The main-process facade over the whole feature. Settings (IPC) and the agent
 * bridge talk only to this; it owns the runtime, the stores and the indexer.
 * Every method other than getStatus/estimate is a no-op or error while disabled.
 */
export interface HistoryService {
  getStatus(): HistoryStatus;
  estimate(): Promise<HistoryEstimate>;
  /** Consent given: install the runtime (download + verify), then index everything. */
  enable(): Promise<void>;
  /** Stop everything; with deleteData also remove the runtime and every index. */
  disable(opts: { deleteData: boolean }): Promise<void>;
  pause(): void;
  resume(): void;
  onStatus(listener: (status: HistoryStatus) => void): () => void;

  // Agent queries, always scoped to one workspace.
  search(workspaceId: string, query: string, opts?: { limit?: number; since?: number }): Promise<SearchHit[]>;
  sessionsForFile(workspaceId: string, filePath: string, limit?: number): Promise<Array<{ sessionId: string; chunkId: string; ts: number; title?: string }>>;
  showChunk(workspaceId: string, chunkId: string, radius?: number): Promise<Array<{ chunkId: string; ts: number; text: string }>>;
  listSessions(workspaceId: string, limit?: number): Promise<Array<{ sessionId: string; title?: string; firstTs: number; lastTs: number; chunks: number }>>;
  /**
   * Which sessions produced a file's recent commits, or the commit that last
   * touched one line: git gives the commits, the index the edits between them.
   */
  why(workspaceId: string, filePath: string, line?: number): Promise<HistoryWhyEntry[]>;

  // Decision notes (AppSettings.historyDistill). Only meaningful while enabled.
  /** What distilling the backlog and keeping up would cost — computed from the DBs, runs no model. */
  distillEstimate(): Promise<HistoryDistillEstimate>;
  /** Start / stop distillation. Off keeps the notes already written. */
  setDistillEnabled(enabled: boolean): void;
  /** Remove every decision note and distillation state (the spent total is kept). */
  deleteNotes(): Promise<void>;
}

/** Distillation progress, surfaced in Settings ("N of M groups distilled"). */
export interface HistoryDistillStatus {
  enabled: boolean;
  /**
   * running: a group is with Claude right now; idle: nothing settled is left;
   * waiting: backing off after a failure that wasn't about the input (not
   * logged in, usage limit, network); paused: history is paused.
   */
  state: 'off' | 'idle' | 'running' | 'waiting' | 'paused' | 'error';
  /** Groups of settled sessions that are distilled / still to do / given up on. */
  groupsDistilled: number;
  groupsPending: number;
  groupsFailed: number;
  /** Groups of sessions still active (or active within the settle window); distilled later. */
  groupsUnsettled: number;
  notes: number;
  /** Sum of the CLI's total_cost_usd over every run (API-rate equivalent; not billed on a subscription). */
  spentUsd: number;
  error?: string;
}

/**
 * The cost of decision notes, shown BEFORE they are enabled. Tokens are
 * estimated as chars/3 plus a fixed prompt overhead per group, output as a
 * fixed amount per group; dollars at the model's list price.
 */
export interface HistoryDistillEstimate {
  model: string;
  /** USD per million tokens at the price tier groups fall into. */
  priceInputPerMTok: number;
  priceOutputPerMTok: number;
  /** Settled groups not distilled yet (deduplicated across workspaces). */
  pendingGroups: number;
  pendingInputTokens: number;
  pendingOutputTokens: number;
  backlogUsd: number;
  /** Groups of sessions too recent to distill yet. */
  unsettledGroups: number;
  /** Ongoing cost at the last 30 days' rate of new conversation. */
  monthlyGroups: number;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  monthlyUsd: number;
  /** Actually spent so far, as reported by Claude Code. */
  spentUsd: number;
  notes: number;
}

/** One commit and the session edits that most likely produced it (see git-why.ts). */
export interface HistoryWhyEntry {
  commit: { sha: string; ts: number; subject: string; author: string; uncommitted?: boolean };
  edits: Array<{ sessionId: string; chunkId: string; ts: number; title?: string; snippet: string }>;
}

/** Progress of the per-workspace indexer, surfaced in Settings. */
export interface HistoryProgress {
  state: 'off' | 'installing' | 'indexing' | 'idle' | 'paused' | 'error';
  /** Install phase: bytes downloaded / total, across binary + model. */
  downloadedBytes?: number;
  totalBytes?: number;
  /** Indexing phase: chunks embedded / known. */
  embeddedChunks?: number;
  totalChunks?: number;
  error?: string;
}
