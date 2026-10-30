import { app } from 'electron';
import { existsSync, readdirSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { EmbeddingRuntime, isAbortError } from './runtime';
import type { DistillInputResult, DistillScanResult, IndexedWorkspace } from './indexer';
import { IndexerClient } from './indexer-client';
import { commitsForFile, matchEditsToCommits, type FileEdit } from './git-why';
import { DISTILL_MODEL_LABEL, HAIKU_PRICE, type DistillRunResult } from './distill';
import { ClaudeCliDistillRunner, type DistillRunner } from './distill-runner';
import { makeClaudeEnv, resolveClaudeExecutable } from '../agent/claude-executable';
import type {
  HistoryDistillEstimate, HistoryDistillStatus,
  Embedder, HistoryEstimate, HistoryProgress, HistoryService, HistoryStatus, HistoryWhyEntry, HistoryWorkspaceStats, SearchHit,
} from './types';

// ─── Workspace history: service ──────────────────────────────────────────────
// The one object Settings (IPC) and the agent bridge talk to. Owns the
// embedding runtime and the background loop; transcript parsing and every DB
// read/write happen in a worker thread behind IndexerClient (see indexer-host.ts).
//
// CONSENT: constructing the service does nothing. Until enable() is called it
// downloads nothing, spawns nothing, watches nothing and writes nothing.
// estimate() is the only thing that runs before consent, and it only stat()s
// transcript files. enable() is the consent: it installs the runtime (download +
// sha256 verify) and starts indexing in the background. disable() undoes all of
// it, optionally deleting the runtime and every index.
//
// Even while enabled the runtime only runs on demand: llama-server starts for an
// embedding batch or a search and stops itself after a few idle minutes (see
// runtime.ts), so an idle, fully indexed history costs nothing but disk.

// Back-off between background passes when nothing tells us to look sooner.
const RESCAN_INTERVAL_MS = 10 * 60_000;
// Claude Code appends to a transcript on every turn; coalesce those writes.
const WATCH_DEBOUNCE_MS = 30_000;
// Settings re-renders on every status push; one per second is plenty.
const STATUS_THROTTLE_MS = 1_000;

// Rough first-import cost model for the consent prompt, measured on the spike
// (M4, EmbeddingGemma 2 Q8 via llama-server): ~3 embeddable tokens per KB of
// transcript JSONL (tool output and metadata dominate the files), ~2.5k tok/s,
// and an index of roughly 4.7× the stored text (FTS trigram ≈ 3.7× + text + vectors).
const TOKENS_PER_BYTE = 0.003;
const TOKENS_PER_SECOND = 2_500;
const INDEX_BYTES_PER_BYTE = 0.05;

// Decision notes (distill.ts): after a failure that says nothing about the
// input (not logged in, usage limit, network, Claude Code missing) the loop
// backs off instead of retrying on every watch event.
const DISTILL_BACKOFF_MIN_MS = 5 * 60_000;
const DISTILL_BACKOFF_MAX_MS = 60 * 60_000;

export interface HistoryServiceDeps {
  /** <userData>/history: runtime/ and db/ live under it; deleteData removes it. */
  rootDir: string;
  projectsDir: string;
  workspaces: () => IndexedWorkspace[];
  /** Injected in tests; defaults to the real llama.cpp runtime under rootDir/runtime. */
  runtime?: RuntimeLike;
  /** Built history-worker.js. Without it (tests) the indexer runs in-process. */
  workerPath?: string;
  log?: (msg: string) => void;
  /** Injected in tests; defaults to `claude -p` with Haiku (distill-runner.ts). */
  distillRunner?: DistillRunner;
  /** AppSettings.claudeBinaryPath, read at run time; empty = auto-detect. */
  claudeBinaryPath?: () => string;
  /** Clock for the settle rule; injected in tests. */
  now?: () => number;
}

/** The slice of EmbeddingRuntime the service uses (lets tests fake it). */
export interface RuntimeLike extends Embedder {
  isSupported(): boolean;
  isInstalled(): boolean;
  downloadBytes(): number;
  install(opts: { signal?: AbortSignal; onProgress?: (p: { downloadedBytes: number; totalBytes: number }) => void }): Promise<void>;
  uninstall(): Promise<void>;
  stop(): Promise<void>;
}

/** Claude Code's project-dir naming: every non-alphanumeric char becomes `-`. */
export function claudeProjectSlug(folder: string): string {
  return folder.replace(/[^A-Za-z0-9]/g, '-');
}

function jsonlBytes(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string, depth: number) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { bytes += statSync(p).size; files++; } catch { /* vanished */ }
      } else if (e.isDirectory() && depth < 2 && e.name !== 'tool-results') {
        walk(p, depth + 1);
      }
    }
  };
  walk(dir, 0);
  return { files, bytes };
}

export class WorkspaceHistoryService implements HistoryService {
  private readonly deps: HistoryServiceDeps;
  private readonly log: (msg: string) => void;
  private runtimeInstance: RuntimeLike | null = null;
  private indexerInstance: IndexerClient | null = null;
  // getStatus() is synchronous (Settings polls it), DB stats are not: keep the
  // last known per-workspace stats and refresh them after every pass/batch.
  private workspaceStats: HistoryWorkspaceStats[] = [];

  private enabled = false;
  private paused = false;
  private progress: HistoryProgress = { state: 'off' };
  private installing: Promise<void> | null = null;
  private installAbort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private rerun = false;
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: HistoryStatus) => void>();
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  // Decision notes. distillOn mirrors AppSettings.historyDistill and only has
  // an effect while `enabled`: the loop runs after each index pass, one group
  // at a time, and pause / disable / turning it off abort the run in flight.
  private distillOn = false;
  private distillRunnerInstance: DistillRunner | null = null;
  private distillAbort: AbortController | null = null;
  private distillRetryAt = 0;
  private distillBackoffMs = 0;
  private distillScanned = false;
  private distill: HistoryDistillStatus = {
    enabled: false, state: 'off', groupsDistilled: 0, groupsPending: 0, groupsFailed: 0, groupsUnsettled: 0, notes: 0, spentUsd: 0,
  };

  constructor(deps: HistoryServiceDeps) {
    this.deps = deps;
    this.log = deps.log ?? ((m) => console.log(m));
  }

  // Both are created lazily: the real runtime only computes paths in its
  // constructor, but keeping them unborn until consent makes that a non-question.
  private get runtime(): RuntimeLike {
    this.runtimeInstance ??= this.deps.runtime ?? new EmbeddingRuntime({
      rootDir: path.join(this.deps.rootDir, 'runtime'),
      log: this.log,
    });
    return this.runtimeInstance;
  }

  private get indexer(): IndexerClient {
    this.indexerInstance ??= new IndexerClient({
      projectsDir: this.deps.projectsDir,
      dataDir: path.join(this.deps.rootDir, 'db'),
      embedder: this.runtime,
      onBatch: () => { void this.refreshCounts(); },
      workerPath: this.deps.workerPath,
      inProcess: !this.deps.workerPath,
    });
    return this.indexerInstance;
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  getStatus(): HistoryStatus {
    return { enabled: this.enabled, progress: { ...this.progress }, workspaces: [...this.workspaceStats], distill: this.distillStatus() };
  }

  onStatus(listener: (status: HistoryStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setProgress(next: HistoryProgress, force = false): void {
    this.progress = next;
    const now = Date.now();
    if (force || now - this.lastEmit >= STATUS_THROTTLE_MS) {
      this.emitNow();
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => this.emitNow(), STATUS_THROTTLE_MS - (now - this.lastEmit));
    }
  }

  private emitNow(): void {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    this.lastEmit = Date.now();
    const status = this.getStatus();
    for (const l of this.listeners) {
      try { l(status); } catch { /* a broken listener must not stop indexing */ }
    }
  }

  // ─── Consent ───────────────────────────────────────────────────────────────

  async estimate(): Promise<HistoryEstimate> {
    // Stat-only: the slug of a workspace folder names Claude Code's project dir
    // for sessions started there. Sessions started elsewhere that later moved
    // into the folder are missed here, which is fine for an estimate.
    const slugs = [...new Set(
      this.deps.workspaces().map((w) => w.workingDirectory?.trim()).filter((f): f is string => !!f).map(claudeProjectSlug),
    )];
    let transcriptFiles = 0;
    let transcriptBytes = 0;
    let dirs: string[] = [];
    try { dirs = readdirSync(this.deps.projectsDir); } catch { /* no Claude Code data yet */ }
    for (const dir of dirs) {
      if (!slugs.some((s) => dir === s || dir.startsWith(`${s}-`))) continue;
      const r = jsonlBytes(path.join(this.deps.projectsDir, dir));
      transcriptFiles += r.files;
      transcriptBytes += r.bytes;
    }
    const runtime = this.runtime;
    const downloadBytes = runtime.isInstalled() ? 0 : runtime.downloadBytes();
    const indexBytes = Math.round(transcriptBytes * INDEX_BYTES_PER_BYTE);
    return {
      transcriptFiles,
      transcriptBytes,
      downloadBytes,
      diskBytes: runtime.downloadBytes() + indexBytes,
      firstImportMinutes: Math.max(1, Math.round((transcriptBytes * TOKENS_PER_BYTE) / TOKENS_PER_SECOND / 60)),
    };
  }

  /**
   * Consent given. Idempotent: a second call while installing joins the same
   * install, and a call while already running is a no-op. Resolves once the
   * runtime is installed (or the install was paused); indexing continues in
   * the background.
   */
  async enable(): Promise<void> {
    if (this.enabled && !this.installing) return;
    if (this.installing) return this.installing;
    if (!this.runtime.isSupported()) throw new Error(`Workspace history is not available on ${process.platform}-${process.arch} yet.`);
    this.enabled = true;
    this.paused = false;
    const run = this.installRuntime().finally(() => { this.installing = null; });
    this.installing = run;
    return run;
  }

  private async installRuntime(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime.isInstalled()) {
      const abort = new AbortController();
      this.installAbort = abort;
      this.setProgress({ state: 'installing', downloadedBytes: 0, totalBytes: runtime.downloadBytes() }, true);
      try {
        await runtime.install({
          signal: abort.signal,
          onProgress: (p) => this.setProgress({ state: 'installing', downloadedBytes: p.downloadedBytes, totalBytes: p.totalBytes }),
        });
      } catch (err) {
        if (isAbortError(err) && (this.paused || !this.enabled)) {
          // Paused or turned off mid-download: not a failure. resume() / a
          // later enable() picks the install up again.
          if (this.enabled) this.setProgress({ state: 'paused' }, true);
          return;
        }
        this.enabled = false;
        this.setProgress({ state: 'error', error: (err as Error).message }, true);
        throw err;
      } finally {
        this.installAbort = null;
      }
    }
    if (!this.enabled) return;
    this.startBackground();
  }

  async disable(opts: { deleteData: boolean }): Promise<void> {
    this.enabled = false;
    this.paused = false;
    this.installAbort?.abort();
    // History off means distillation off too; re-enabling history asks again.
    this.distillOn = false;
    this.distillAbort?.abort();
    this.distillScanned = false;
    this.stopBackground();
    await this.installing?.catch(() => {});
    await this.shutdown();
    if (opts.deleteData) {
      // Works even when the feature was never fully enabled: a failed or
      // cancelled install leaves partial downloads that must not linger.
      if (this.runtimeInstance) await this.runtimeInstance.uninstall().catch(() => {});
      rmSync(this.deps.rootDir, { recursive: true, force: true });
    }
    this.setProgress({ state: 'off' }, true);
  }

  pause(): void {
    if (!this.enabled || this.paused) return;
    this.paused = true;
    // An install in flight is cancelled; the files already verified are kept,
    // and resume() downloads only what's missing.
    this.installAbort?.abort();
    this.distillAbort?.abort();
    this.stopHost(true);
    this.setProgress({ ...this.progress, state: 'paused' }, true);
  }

  resume(): void {
    if (!this.enabled || !this.paused) return;
    this.paused = false;
    if (!this.runtime.isInstalled()) {
      const run = this.installRuntime().finally(() => { this.installing = null; });
      this.installing = run;
      run.catch((err) => this.log(`[history] resume install failed: ${(err as Error).message}`));
      return;
    }
    this.setProgress({ ...this.progress, state: 'indexing' }, true);
    this.kick();
  }

  /** App quit: stop the server and close the DBs; consent stays as it is. */
  async dispose(): Promise<void> {
    const wasEnabled = this.enabled;
    this.enabled = false;
    this.installAbort?.abort();
    this.distillAbort?.abort();
    this.stopBackground();
    await this.shutdown();
    this.enabled = wasEnabled;
  }

  /** A workspace was added or its folder changed: look for its sessions soon. */
  notifyWorkspacesChanged(): void {
    if (this.enabled && !this.installing) this.scheduleScan();
  }

  private async shutdown(): Promise<void> {
    // Stop the host's loops first so an in-flight pass returns, then close.
    await this.indexerInstance?.call({ method: 'setStopped', stopped: true }).catch(() => {});
    await this.loop?.catch(() => {});
    await this.runtimeInstance?.stop().catch(() => {});
    await this.indexerInstance?.close().catch(() => {});
    this.indexerInstance = null;
    this.workspaceStats = [];
  }

  // ─── Background indexing ───────────────────────────────────────────────────

  private readonly shouldStop = () => !this.enabled || this.paused;

  private stopHost(stopped: boolean): void {
    void this.indexerInstance?.call({ method: 'setStopped', stopped }).catch(() => {});
  }

  private startBackground(): void {
    this.stopBackground();
    try {
      // Recursive fs.watch works on macOS and Windows, and on Linux with Node ≥ 20.
      this.watcher = watch(this.deps.projectsDir, { recursive: true }, (_event, name) => {
        if (name && String(name).endsWith('.jsonl')) this.scheduleScan();
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch {
      // No projects dir yet (Claude Code never ran): the interval covers it.
    }
    this.rescanTimer = setInterval(() => this.kick(), RESCAN_INTERVAL_MS);
    this.rescanTimer.unref?.();
    this.kick();
  }

  private stopBackground(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
  }

  private scheduleScan(): void {
    if (this.watchTimer) return;
    this.watchTimer = setTimeout(() => { this.watchTimer = null; this.kick(); }, WATCH_DEBOUNCE_MS);
    this.watchTimer.unref?.();
  }

  /** Run a scan + embed pass now, or right after the current one finishes. */
  private kick(): void {
    if (this.shouldStop()) return;
    if (this.loop) { this.rerun = true; return; }
    this.loop = this.runPasses().then(() => this.runDistill()).finally(() => {
      this.loop = null;
      // Distillation yields to a scan asked for while it ran (see runDistill).
      if (this.rerun) this.kick();
    });
  }

  private async runPasses(): Promise<void> {
    try {
      const indexer = this.indexer;
      do {
        this.rerun = false;
        // Re-armed every pass: a pause + resume while this loop was mid-batch
        // leaves the host stopped, and the rerun pass must clear that.
        await indexer.call({ method: 'setStopped', stopped: false });
        const workspaces = this.deps.workspaces();
        this.setProgress({ ...this.progress, state: 'indexing' });
        await indexer.call({ method: 'scan', workspaces });
        if (this.shouldStop()) break;
        await this.refreshCounts();
        await indexer.call({ method: 'embedPending', workspaces });
      } while (this.rerun && !this.shouldStop());
      await this.refreshCounts();
      if (this.enabled) this.setProgress({ ...this.progress, state: this.paused ? 'paused' : 'idle' }, true);
    } catch (err) {
      if (!this.enabled) return;
      this.log(`[history] indexing pass failed: ${(err as Error).message}`);
      // Stay enabled: the next watch event or interval retries. A broken
      // runtime surfaces here, which is what the Settings error line is for.
      this.setProgress({ ...this.progress, state: 'error', error: (err as Error).message }, true);
    }
  }

  /** Re-read per-workspace stats from the host and fold them into progress. */
  private async refreshCounts(): Promise<void> {
    if (!this.indexerInstance) return;
    try {
      this.workspaceStats = await this.indexerInstance.call<HistoryWorkspaceStats[]>({
        method: 'stats', workspaces: this.deps.workspaces(),
      });
    } catch {
      return; // closed mid-refresh (disable/quit)
    }
    if (!this.enabled) return;
    let totalChunks = 0;
    let embeddedChunks = 0;
    for (const s of this.workspaceStats) { totalChunks += s.chunks; embeddedChunks += s.embeddedChunks; }
    this.setProgress({ ...this.progress, totalChunks, embeddedChunks });
  }

  // ─── Agent queries ─────────────────────────────────────────────────────────

  private ensureEnabled(): IndexerClient {
    if (!this.enabled) throw new Error('history_disabled');
    return this.indexer;
  }

  async search(workspaceId: string, query: string, opts: { limit?: number; since?: number } = {}): Promise<SearchHit[]> {
    const indexer = this.ensureEnabled();
    if (!query.trim()) return [];
    let vector: Float32Array | undefined;
    try {
      [vector] = await this.runtime.embed([query], 'query');
    } catch (err) {
      // Runtime unavailable (still installing, crashed): lexical results beat none.
      this.log(`[history] query embedding failed, lexical only: ${(err as Error).message}`);
    }
    return indexer.call<SearchHit[]>({ method: 'search', workspaceId, text: query, vector, limit: opts.limit, since: opts.since });
  }

  async sessionsForFile(workspaceId: string, filePath: string, limit = 10) {
    return this.ensureEnabled().call<Array<{ sessionId: string; chunkId: string; ts: number; title?: string }>>({
      method: 'sessionsForFile', workspaceId, filePath, limit,
    });
  }

  async showChunk(workspaceId: string, chunkId: string, radius = 1) {
    return this.ensureEnabled().call<Array<{ chunkId: string; ts: number; text: string }>>({
      method: 'showChunk', workspaceId, chunkId, radius,
    });
  }

  async why(workspaceId: string, filePath: string, line?: number): Promise<HistoryWhyEntry[]> {
    const indexer = this.ensureEnabled();
    // git runs here in main: it is an async child process, so nothing blocks.
    const [commits, edits] = await Promise.all([
      commitsForFile(filePath, line),
      indexer.call<FileEdit[]>({ method: 'fileEdits', workspaceId, filePath }),
    ]);
    return matchEditsToCommits(commits, edits);
  }

  async listSessions(workspaceId: string, limit = 20) {
    return this.ensureEnabled().call<Array<{ sessionId: string; title?: string; firstTs: number; lastTs: number; chunks: number }>>({
      method: 'listSessions', workspaceId, limit,
    });
  }

  // ─── Decision notes ────────────────────────────────────────────────────────
  // CONSENT, second level: distillation runs Claude Haiku through the user's
  // Claude Code login, which costs plan limits or API money. It is off unless
  // AppSettings.historyDistill is on (written only by the history:distill-*
  // handlers, after Settings showed distillEstimate()), and only while history
  // itself is enabled and not paused. Nothing is spawned for it otherwise.

  private get distillRunner(): DistillRunner {
    this.distillRunnerInstance ??= this.deps.distillRunner ?? new ClaudeCliDistillRunner({
      executable: () => resolveClaudeExecutable({ configured: this.deps.claudeBinaryPath?.() ?? '' }),
      // Outside every workspace folder: no project context is picked up, and
      // the run can never be matched to a workspace.
      cwd: path.join(this.deps.rootDir, 'distill'),
      env: () => makeClaudeEnv(undefined),
      log: this.log,
    });
    return this.distillRunnerInstance;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private distillStatus(): HistoryDistillStatus {
    const state = !this.distillOn ? 'off' : this.paused ? 'paused' : this.distill.state;
    return { ...this.distill, enabled: this.distillOn, state };
  }

  private setDistill(patch: Partial<HistoryDistillStatus>, force = false): void {
    this.distill = { ...this.distill, ...patch };
    this.setProgress({ ...this.progress }, force);
  }

  private applyDistillScan(scan: DistillScanResult): void {
    this.distillScanned = true;
    this.setDistill({
      groupsDistilled: scan.groupsDistilled,
      groupsPending: scan.groupsPending,
      groupsFailed: scan.groupsFailed,
      groupsUnsettled: scan.groupsUnsettled,
      notes: scan.notes,
      spentUsd: scan.spentUsd,
    });
  }

  /** Mirror AppSettings.historyDistill. Turning it off stops the run in flight and keeps every note. */
  setDistillEnabled(enabled: boolean): void {
    if (this.distillOn === enabled) return;
    this.distillOn = enabled;
    this.distillRetryAt = 0;
    this.distillBackoffMs = 0;
    if (!enabled) this.distillAbort?.abort();
    this.setDistill({ enabled, state: enabled ? 'idle' : 'off', error: undefined }, true);
    if (enabled && this.enabled && !this.installing) this.kick();
  }

  /** The cost of the backlog and of keeping up, from the DBs alone (no model runs). */
  async distillEstimate(): Promise<HistoryDistillEstimate> {
    const scan = await this.ensureEnabled().call<DistillScanResult>({
      method: 'distillScan', workspaces: this.deps.workspaces(), now: this.now(), write: false,
    });
    this.applyDistillScan(scan);
    return {
      model: DISTILL_MODEL_LABEL,
      priceInputPerMTok: HAIKU_PRICE.low.input,
      priceOutputPerMTok: HAIKU_PRICE.low.output,
      pendingGroups: scan.plan.length,
      pendingInputTokens: scan.pendingInputTokens,
      pendingOutputTokens: scan.pendingOutputTokens,
      backlogUsd: scan.backlogUsd,
      unsettledGroups: scan.groupsUnsettled,
      monthlyGroups: scan.monthlyGroups,
      monthlyInputTokens: scan.monthlyInputTokens,
      monthlyOutputTokens: scan.monthlyOutputTokens,
      monthlyUsd: scan.monthlyUsd,
      spentUsd: scan.spentUsd,
      notes: scan.notes,
    };
  }

  /**
   * Delete every note and its group state. Refused while distillation is on:
   * it would immediately pay to distill everything again.
   */
  async deleteNotes(): Promise<void> {
    const indexer = this.ensureEnabled();
    if (this.distillOn) throw new Error('Turn decision notes off before deleting them.');
    const workspaces = this.deps.workspaces();
    await indexer.call({ method: 'deleteNotes', workspaces });
    await this.refreshCounts();
    this.applyDistillScan(await indexer.call<DistillScanResult>({ method: 'distillScan', workspaces, now: this.now(), write: false }));
  }

  private readonly distillShouldStop = () => this.shouldStop() || !this.distillOn || this.rerun;

  /**
   * One distillation pass, run after each index pass: plan, then distill the
   * pending groups newest-session first, ONE at a time. Between groups it stops
   * for pause / disable / off, and yields to a scan that was asked for
   * meanwhile (kick() re-runs it; the next pass re-plans).
   */
  private async runDistill(): Promise<void> {
    if (!this.enabled || this.shouldStop() || this.rerun || this.progress.state === 'error') return;
    const indexer = this.indexer;
    const workspaces = this.deps.workspaces();
    if (!this.distillOn) {
      // Off: still show how many notes exist and what was spent, once per enable.
      if (!this.distillScanned) {
        await indexer.call<DistillScanResult>({ method: 'distillScan', workspaces, now: this.now(), write: false })
          .then((scan) => this.applyDistillScan(scan), () => {});
      }
      return;
    }
    if (this.now() < this.distillRetryAt) return;
    try {
      const scan = await indexer.call<DistillScanResult>({ method: 'distillScan', workspaces, now: this.now(), write: true });
      this.applyDistillScan(scan);
      for (const item of scan.plan) {
        if (this.distillShouldStop()) break;
        const input = await indexer.call<DistillInputResult | null>({ method: 'distillInput', workspaces, item });
        if (!input) continue;
        if (this.distillShouldStop()) break;
        this.setDistill({ state: 'running', error: undefined });
        const abort = new AbortController();
        this.distillAbort = abort;
        let result: DistillRunResult;
        try {
          result = await this.distillRunner.run(input.text, { signal: abort.signal, validSeqs: new Set(input.seqs) });
        } finally {
          this.distillAbort = null;
        }
        if (!result.ok && result.aborted) break;
        const written = await indexer.call<number>({
          method: 'distillCommit', workspaces, item,
          input: { tsBySeq: input.tsBySeq, firstSeq: input.firstSeq, lastTs: input.lastTs }, result, now: this.now(),
        });
        const spentUsd = this.distill.spentUsd + (result.usage?.costUsd ?? 0);
        if (result.ok) {
          this.distillBackoffMs = 0;
          this.setDistill({
            spentUsd, notes: this.distill.notes + written,
            groupsDistilled: this.distill.groupsDistilled + 1, groupsPending: Math.max(0, this.distill.groupsPending - 1),
          });
          // Embed the new notes now so they are searchable right away; a
          // failure here is the indexer's to report, not distillation's.
          if (written) await indexer.call({ method: 'embedPending', workspaces }).catch(() => {});
          continue;
        }
        this.log(`[history] distilling ${item.sessionId} group ${item.group} failed: ${result.error}`);
        this.setDistill({ spentUsd });
        if (result.inputSpecific) continue; // counted as an attempt; the next group may be fine
        this.distillBackoffMs = Math.min(DISTILL_BACKOFF_MAX_MS, Math.max(DISTILL_BACKOFF_MIN_MS, this.distillBackoffMs * 2));
        this.distillRetryAt = this.now() + this.distillBackoffMs;
        this.setDistill({ state: 'waiting', error: result.error }, true);
        return;
      }
      // A pass that yielded or was stopped is re-planned by the next one; only
      // a finished pass needs fresh counts.
      if (!this.distillShouldStop()) {
        this.applyDistillScan(await indexer.call<DistillScanResult>({ method: 'distillScan', workspaces, now: this.now(), write: false }));
      }
      this.setDistill({ state: 'idle', error: undefined }, true);
    } catch (err) {
      if (!this.enabled) return;
      this.log(`[history] distillation pass failed: ${(err as Error).message}`);
      this.setDistill({ state: 'error', error: (err as Error).message }, true);
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let service: WorkspaceHistoryService | null = null;
let workspacesProvider: () => IndexedWorkspace[] = () => [];
let claudeBinaryProvider: () => string = () => '';

/** Wired by ipc-handlers: the Claude Code binary setting distillation runs. */
export function setHistoryClaudeBinaryProvider(fn: () => string): void {
  claudeBinaryProvider = fn;
}

/** Wired by ipc-handlers once the workspace store exists. */
export function setHistoryWorkspacesProvider(fn: () => IndexedWorkspace[]): void {
  workspacesProvider = fn;
}

function claudeProjectsDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return path.join(override && override.trim() ? override : path.join(homedir(), '.claude'), 'projects');
}

// The worker is its own bundle next to main.js (.vite/build). In a packaged app
// that dir is inside app.asar; worker_threads can't load a script from the
// archive, so forge.config.ts unpacks it and we point at the unpacked copy.
function historyWorkerPath(): string {
  const file = path.join(__dirname, 'history-worker.js');
  const unpacked = file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return unpacked !== file && existsSync(unpacked) ? unpacked : file;
}

export function getHistoryService(): WorkspaceHistoryService {
  if (!service) {
    service = new WorkspaceHistoryService({
      rootDir: path.join(app.getPath('userData'), 'history'),
      workerPath: historyWorkerPath(),
      projectsDir: claudeProjectsDir(),
      workspaces: () => workspacesProvider(),
      claudeBinaryPath: () => claudeBinaryProvider(),
    });
  }
  return service;
}

