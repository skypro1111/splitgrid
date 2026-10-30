import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from '../atomic-write';
import { discoverTranscriptFiles, parseTranscript, transcriptBelongsTo, type TranscriptFile } from './transcripts';
import { HistoryStore, type DistillGroupState } from './store';
import {
  DISTILL_GROUP_CHARS, DISTILL_MAX_ATTEMPTS, DISTILL_OUTPUT_TOKENS_PER_GROUP, DISTILL_PROMPT_OVERHEAD_TOKENS,
  buildNoteChunks, callCostUsd, groupSessionChunks, isSessionSettled, renderGroupInput, tokensForChars,
  type DistillGroup, type DistillRunResult,
} from './distill';
import type { Embedder, ParsedTranscript } from './types';

// ─── Workspace history: indexer ──────────────────────────────────────────────
// Turns Claude Code transcripts into per-workspace indexes. One pass:
//   1. stat every transcript under the projects dir (cheap, no reads),
//   2. for each file that changed since we last saw it, parse it once and
//      remember the cwds it ran in (files.json) so later passes can decide
//      workspace membership without re-reading unchanged files,
//   3. for every workspace whose folder contains one of those cwds and whose DB
//      hasn't seen this size/mtime yet, write the session + chunks to that
//      workspace's DB (the store diffs by hash, so only changed chunks are new),
//   4. embed whatever chunks have no vector yet, a batch at a time.
// A transcript that ran in two overlapping workspace folders lands in both DBs:
// each DB is self-contained so a workspace's index can be deleted on its own.
//
// Embedding is the only expensive step. It runs in small batches and checks
// `shouldStop` between them, so pause/disable take effect within one batch.

export interface IndexedWorkspace {
  id: string;
  workingDirectory: string | null;
}

export interface IndexerOptions {
  /** Claude Code's projects dir (~/.claude/projects or $CLAUDE_CONFIG_DIR/projects). */
  projectsDir: string;
  /** Where the per-workspace DBs and files.json live (<userData>/history/db). */
  dataDir: string;
  /** Current workspaces, read on every pass so new or moved folders are picked up. */
  workspaces: () => IndexedWorkspace[];
  embedder: Embedder;
  /** Chunks per embedding request. */
  batchSize?: number;
  log?: (msg: string) => void;
}

export interface IndexerProgress {
  totalChunks: number;
  embeddedChunks: number;
}

/** One group to distill. The same group in overlapping workspaces is distilled once and written to all of them. */
export interface DistillPlanItem {
  workspaceId: string;
  sessionId: string;
  group: number;
  inputHash: string;
  alsoWorkspaceIds: string[];
}

/** A plan item's rendered input, plus what commit needs to place the notes. */
export interface DistillInputResult {
  text: string;
  chars: number;
  seqs: number[];
  /** [seq, ts] of the group's turns. */
  tsBySeq: Array<[number, number]>;
  firstSeq: number;
  lastTs: number;
}

/** Counts behind HistoryDistillStatus and HistoryDistillEstimate (one DB pass, no model). */
export interface DistillScanResult {
  plan: DistillPlanItem[];
  groupsDistilled: number;
  groupsPending: number;
  groupsFailed: number;
  groupsUnsettled: number;
  notes: number;
  spentUsd: number;
  pendingInputTokens: number;
  pendingOutputTokens: number;
  backlogUsd: number;
  monthlyGroups: number;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  monthlyUsd: number;
}

const MONTH_MS = 30 * 86_400_000;

/** What we know about a transcript file without re-reading it. */
interface SeenFile {
  size: number;
  mtimeMs: number;
  cwds: string[];
}

const SEEN_FILE = 'files.json';
const DB_SUFFIX = '.sqlite';

// Workspace ids come from our own store (uuids), but they end up in a file
// name, so anything outside a safe charset is replaced rather than trusted.
function dbFileName(workspaceId: string): string {
  return `${workspaceId.replace(/[^A-Za-z0-9_-]/g, '_')}${DB_SUFFIX}`;
}

export class HistoryIndexer {
  private readonly opts: Required<Omit<IndexerOptions, 'log'>> & { log: (m: string) => void };
  private readonly stores = new Map<string, HistoryStore>();
  private seen: Record<string, SeenFile> | null = null;

  constructor(opts: IndexerOptions) {
    this.opts = { batchSize: 16, log: () => {}, ...opts };
  }

  dbPath(workspaceId: string): string {
    return path.join(this.opts.dataDir, dbFileName(workspaceId));
  }

  /** The workspace's store, opened on first use; undefined when it has no DB yet and `create` is false. */
  store(workspaceId: string, create = false): HistoryStore | undefined {
    const open = this.stores.get(workspaceId);
    if (open) return open;
    const file = this.dbPath(workspaceId);
    if (!create && !existsSync(file)) return undefined;
    mkdirSync(this.opts.dataDir, { recursive: true });
    const store = HistoryStore.open(file);
    this.stores.set(workspaceId, store);
    return store;
  }

  /** Workspaces that have a folder, i.e. the only ones history can apply to. */
  private indexable(): Array<{ id: string; folder: string }> {
    return this.opts
      .workspaces()
      .filter((w): w is { id: string; workingDirectory: string } => !!w.workingDirectory && !!w.workingDirectory.trim())
      .map((w) => ({ id: w.id, folder: w.workingDirectory }));
  }

  private loadSeen(): Record<string, SeenFile> {
    if (this.seen) return this.seen;
    try {
      const raw = JSON.parse(readFileSync(path.join(this.opts.dataDir, SEEN_FILE), 'utf8')) as unknown;
      this.seen = raw && typeof raw === 'object' ? (raw as Record<string, SeenFile>) : {};
    } catch {
      this.seen = {};
    }
    return this.seen;
  }

  private saveSeen(): void {
    if (!this.seen) return;
    mkdirSync(this.opts.dataDir, { recursive: true });
    writeFileAtomicSync(path.join(this.opts.dataDir, SEEN_FILE), JSON.stringify(this.seen), { mode: 0o600 });
  }

  /**
   * Bring every workspace DB up to date with the transcripts on disk (steps
   * 1–3 above). Returns the number of chunks that now need embedding.
   */
  async scan(shouldStop: () => boolean = () => false): Promise<number> {
    const workspaces = this.indexable();
    if (!workspaces.length) return 0;
    const files = await discoverTranscriptFiles(this.opts.projectsDir);
    const seen = this.loadSeen();
    const present = new Set<string>();
    let pending = 0;
    let seenDirty = false;

    for (const file of files) {
      if (shouldStop()) break;
      present.add(file.file);
      let parsed: ParsedTranscript | null = null;
      const prev = seen[file.file];
      if (!prev || prev.size !== file.size || prev.mtimeMs !== file.mtimeMs) {
        parsed = await this.parse(file);
        if (!parsed) continue;
        seen[file.file] = { size: file.size, mtimeMs: file.mtimeMs, cwds: parsed.meta.cwds };
        seenDirty = true;
      }
      const cwds = seen[file.file].cwds;
      for (const ws of workspaces) {
        if (!transcriptBelongsTo({ cwds }, ws.folder)) continue;
        const store = this.store(ws.id, true)!;
        const state = store.getFileState(file.file);
        if (state && state.size === file.size && state.mtimeMs === file.mtimeMs) continue;
        parsed ??= await this.parse(file);
        if (!parsed) break;
        store.upsertSession(parsed.meta);
        pending += store.replaceSessionChunks(parsed.meta.id, parsed.chunks).length;
        store.setFileState(file.file, { size: file.size, mtimeMs: file.mtimeMs, sessionId: parsed.meta.id });
      }
    }

    // Transcripts Claude Code has since deleted (its own cleanup) are kept in
    // our DBs on purpose: preserving history past that cleanup is the point.
    // Only the bookkeeping entry goes, so files.json doesn't grow forever.
    for (const file of Object.keys(seen)) {
      if (!present.has(file) && !shouldStop()) {
        delete seen[file];
        seenDirty = true;
      }
    }
    if (seenDirty) this.saveSeen();
    return pending;
  }

  private async parse(file: TranscriptFile): Promise<ParsedTranscript | null> {
    try {
      return await parseTranscript({ file: file.file, id: file.id, parentSessionId: file.parentSessionId });
    } catch (err) {
      // Vanished between stat and read, or unreadable: skip it this pass.
      this.opts.log(`history: skip ${file.file}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Embed chunks without a vector, across all workspace DBs, until none are
   * left or `shouldStop` turns true. `onBatch` reports progress after each batch.
   */
  async embedPending(shouldStop: () => boolean, onBatch?: () => void): Promise<void> {
    for (const ws of this.indexable()) {
      const store = this.store(ws.id);
      if (!store) continue;
      for (;;) {
        if (shouldStop()) return;
        const batch = store.pendingEmbeddings(this.opts.batchSize);
        if (!batch.length) break;
        const vectors = await this.opts.embedder.embed(batch.map((b) => b.text), 'document');
        if (shouldStop()) return;
        store.setVectors(batch.map((b, i) => ({ id: b.id, vector: vectors[i], hash: b.hash })));
        onBatch?.();
      }
    }
  }

  // ─── Decision notes (distill.ts) ───────────────────────────────────────────
  // The model runs in main (it owns process spawning, like llama-server); this
  // side plans groups, renders their input and stores the result.

  /**
   * One pass over every workspace DB: group each main session, compare group
   * hashes with the stored state, and count. A group counts once even when it
   * sits in several overlapping workspaces' DBs (same session, same hash).
   * With `write`, groups whose session shrank are pruned, and a pending group
   * already distilled in another workspace's DB gets that DB's notes copied
   * instead of being distilled again. Without it (estimate), nothing is written.
   */
  distillScan(now: number, write: boolean): DistillScanResult {
    type Entry = { wsId: string; store: HistoryStore; sessionId: string; lastTs: number; group: DistillGroup; state?: DistillGroupState };
    const entries: Entry[] = [];
    const doneByHash = new Map<string, { store: HistoryStore; sessionId: string; group: number }>();
    const recentBySession = new Map<string, number>();
    let notes = 0;
    let spentUsd = 0;
    for (const ws of this.indexable()) {
      const store = this.store(ws.id);
      if (!store) continue;
      const totals = store.distillTotals();
      notes += totals.notes;
      spentUsd += totals.spentUsd;
      for (const cand of store.distillCandidates()) {
        const groups = groupSessionChunks(cand.chunks);
        if (write) store.pruneGroups(cand.sessionId, groups.length);
        const states = store.groupStates(cand.sessionId);
        for (const group of groups) {
          const state = states.get(group.index);
          if (state?.status === 'ok' && state.inputHash === group.inputHash) {
            doneByHash.set(group.inputHash, { store, sessionId: cand.sessionId, group: group.index });
          }
          entries.push({ wsId: ws.id, store, sessionId: cand.sessionId, lastTs: cand.lastTs, group, state });
        }
        if (!recentBySession.has(cand.sessionId)) {
          const recent = cand.chunks.filter((c) => c.ts >= now - MONTH_MS).reduce((sum, c) => sum + c.chars, 0);
          recentBySession.set(cand.sessionId, recent);
        }
      }
    }

    const out: DistillScanResult = {
      plan: [], groupsDistilled: 0, groupsPending: 0, groupsFailed: 0, groupsUnsettled: 0, notes, spentUsd,
      pendingInputTokens: 0, pendingOutputTokens: 0, backlogUsd: 0,
      monthlyGroups: 0, monthlyInputTokens: 0, monthlyOutputTokens: 0, monthlyUsd: 0,
    };
    // Best status per (session, group) across workspaces: done > failed > pending > unsettled.
    const RANK = { done: 3, failed: 2, pending: 1, unsettled: 0 } as const;
    const status = new Map<string, keyof typeof RANK>();
    const planByHash = new Map<string, DistillPlanItem & { lastTs: number }>();
    for (const e of entries) {
      const key = `${e.sessionId}#${e.group.index}`;
      const sameInput = e.state?.inputHash === e.group.inputHash;
      let s: keyof typeof RANK;
      if (e.state?.status === 'ok' && sameInput) s = 'done';
      else if (e.state?.status === 'error' && sameInput && e.state.attempts >= DISTILL_MAX_ATTEMPTS) s = 'failed';
      else if (!isSessionSettled(e.lastTs, now)) s = 'unsettled';
      else {
        const src = doneByHash.get(e.group.inputHash);
        if (src && write) {
          e.store.replaceGroupNotes(e.sessionId, e.group.index, src.store.getGroupNotes(src.sessionId, src.group), {
            inputHash: e.group.inputHash, ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, at: now,
          });
          s = 'done';
        } else if (src) {
          s = 'done'; // copied for free on the next real pass
        } else {
          s = 'pending';
          const planned = planByHash.get(e.group.inputHash);
          if (planned) {
            if (planned.workspaceId !== e.wsId && !planned.alsoWorkspaceIds.includes(e.wsId)) planned.alsoWorkspaceIds.push(e.wsId);
          } else {
            planByHash.set(e.group.inputHash, {
              workspaceId: e.wsId, sessionId: e.sessionId, group: e.group.index, inputHash: e.group.inputHash,
              alsoWorkspaceIds: [], lastTs: e.lastTs,
            });
            const input = tokensForChars(e.group.chars) + DISTILL_PROMPT_OVERHEAD_TOKENS;
            out.pendingInputTokens += input;
            out.pendingOutputTokens += DISTILL_OUTPUT_TOKENS_PER_GROUP;
            out.backlogUsd += callCostUsd(input, DISTILL_OUTPUT_TOKENS_PER_GROUP);
          }
        }
      }
      const prev = status.get(key);
      if (!prev || RANK[s] > RANK[prev]) status.set(key, s);
    }
    for (const s of status.values()) {
      if (s === 'done') out.groupsDistilled++;
      else if (s === 'failed') out.groupsFailed++;
      else if (s === 'pending') out.groupsPending++;
      else out.groupsUnsettled++;
    }
    // Newest sessions first: the most recent decisions are the ones agents ask about.
    out.plan = [...planByHash.values()]
      .sort((a, b) => b.lastTs - a.lastTs || a.sessionId.localeCompare(b.sessionId) || a.group - b.group)
      .map((p) => ({ workspaceId: p.workspaceId, sessionId: p.sessionId, group: p.group, inputHash: p.inputHash, alsoWorkspaceIds: p.alsoWorkspaceIds }));

    // Ongoing rate: the last 30 days of new conversation, grouped per session
    // the way a distillation would group it.
    for (const chars of recentBySession.values()) {
      if (chars <= 0) continue;
      const groups = Math.ceil(chars / DISTILL_GROUP_CHARS);
      const input = tokensForChars(chars) + groups * DISTILL_PROMPT_OVERHEAD_TOKENS;
      const output = groups * DISTILL_OUTPUT_TOKENS_PER_GROUP;
      out.monthlyGroups += groups;
      out.monthlyInputTokens += input;
      out.monthlyOutputTokens += output;
      out.monthlyUsd += callCostUsd(input / groups, output / groups) * groups;
    }
    return out;
  }

  /** Render a planned group, or null when the session changed since planning (re-planned next pass). */
  distillInput(item: DistillPlanItem): DistillInputResult | null {
    const store = this.store(item.workspaceId);
    const cand = store?.distillCandidates().find((c) => c.sessionId === item.sessionId);
    if (!store || !cand) return null;
    const group = groupSessionChunks(cand.chunks)[item.group];
    if (!group || group.inputHash !== item.inputHash) return null;
    const chunks = store.getChunkTexts(group.chunkIds);
    const tsBySeq = new Map<number, number>();
    for (const c of chunks) tsBySeq.set(c.seq, Math.max(tsBySeq.get(c.seq) ?? 0, c.ts));
    const text = renderGroupInput(chunks, { title: cand.title });
    return {
      text,
      chars: text.length,
      seqs: [...tsBySeq.keys()],
      tsBySeq: [...tsBySeq],
      firstSeq: group.firstSeq,
      lastTs: Math.max(0, ...tsBySeq.values()),
    };
  }

  /**
   * Store a run's outcome for the planned group in every workspace that holds
   * it. The cost is recorded once (in the item's own workspace). Returns the
   * number of notes written.
   */
  distillCommit(item: DistillPlanItem, input: Pick<DistillInputResult, 'tsBySeq' | 'firstSeq' | 'lastTs'>, result: DistillRunResult, now: number): number {
    const targets = [item.workspaceId, ...item.alsoWorkspaceIds];
    const usage = result.usage ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    const notes = result.ok
      ? buildNoteChunks(item.sessionId, { index: item.group, firstSeq: input.firstSeq, lastTs: input.lastTs }, result.notes, new Map(input.tsBySeq))
      : [];
    targets.forEach((wsId, i) => {
      const store = this.store(wsId);
      if (!store) return;
      const run = {
        inputHash: item.inputHash,
        ok: result.ok,
        countsAsAttempt: !result.ok && result.inputSpecific,
        costUsd: i === 0 ? usage.costUsd : 0,
        inputTokens: i === 0 ? usage.inputTokens : 0,
        outputTokens: i === 0 ? usage.outputTokens : 0,
        at: now,
        ...(result.ok ? {} : { error: result.error }),
      };
      if (result.ok) store.replaceGroupNotes(item.sessionId, item.group, notes, run);
      else store.recordGroupRun(item.sessionId, item.group, run);
    });
    return notes.length;
  }

  /** Delete every decision note in every workspace DB; returns how many went. */
  deleteNotes(): number {
    let n = 0;
    for (const ws of this.indexable()) n += this.store(ws.id)?.deleteNotes() ?? 0;
    return n;
  }

  progress(): IndexerProgress {
    let totalChunks = 0;
    let embeddedChunks = 0;
    for (const ws of this.indexable()) {
      const stats = this.store(ws.id)?.stats();
      if (!stats) continue;
      totalChunks += stats.chunks;
      embeddedChunks += stats.embeddedChunks;
    }
    return { totalChunks, embeddedChunks };
  }

  close(): void {
    for (const store of this.stores.values()) {
      try { store.close(); } catch { /* already closed */ }
    }
    this.stores.clear();
    this.seen = null;
  }
}
