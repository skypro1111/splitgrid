import { HistoryIndexer, type DistillInputResult, type DistillPlanItem, type IndexedWorkspace } from './indexer';
import type { DistillRunResult } from './distill';
import type { Embedder, HistoryWorkspaceStats, SearchHit } from './types';

// ─── Workspace history: indexer host ─────────────────────────────────────────
// Everything that touches SQLite or parses transcripts runs behind this host,
// off Electron's main thread: parsing a large live transcript is seconds of
// synchronous JSON work, and the first FTS insert of a big session is another
// second or so — either would freeze every window. history-worker.ts runs the
// host in a worker thread; tests drive it in-process through the same message
// shapes, so the protocol is what's tested.
//
// Embeddings are the one thing the host can't do itself: the llama-server
// runtime is owned by main (it spawns and stops the process), so the host asks
// main through the `embed` callback.

export type HostRequest =
  | { method: 'scan'; workspaces: IndexedWorkspace[] }
  | { method: 'embedPending'; workspaces: IndexedWorkspace[] }
  | { method: 'setStopped'; stopped: boolean }
  | { method: 'stats'; workspaces: IndexedWorkspace[] }
  | { method: 'search'; workspaceId: string; text: string; vector?: Float32Array; limit?: number; since?: number }
  | { method: 'sessionsForFile'; workspaceId: string; filePath: string; limit: number }
  | { method: 'fileEdits'; workspaceId: string; filePath: string }
  | { method: 'showChunk'; workspaceId: string; chunkId: string; radius: number }
  | { method: 'listSessions'; workspaceId: string; limit: number }
  // Decision notes (distill.ts): main runs the model, the host plans and stores.
  | { method: 'distillScan'; workspaces: IndexedWorkspace[]; now: number; write: boolean }
  | { method: 'distillInput'; workspaces: IndexedWorkspace[]; item: DistillPlanItem }
  | { method: 'distillCommit'; workspaces: IndexedWorkspace[]; item: DistillPlanItem; input: Pick<DistillInputResult, 'tsBySeq' | 'firstSeq' | 'lastTs'>; result: DistillRunResult; now: number }
  | { method: 'deleteNotes'; workspaces: IndexedWorkspace[] }
  | { method: 'close' };

export interface HostConfig {
  projectsDir: string;
  dataDir: string;
}

export interface HostEvents {
  /** Called after each embedded batch so main can refresh progress. */
  onBatch(): void;
}

export class IndexerHost {
  private indexer: HistoryIndexer | null = null;
  private workspaces: IndexedWorkspace[] = [];
  private stopped = false;

  constructor(
    private readonly config: HostConfig,
    private readonly embedder: Embedder,
    private readonly events: HostEvents,
  ) {}

  private get ix(): HistoryIndexer {
    this.indexer ??= new HistoryIndexer({
      projectsDir: this.config.projectsDir,
      dataDir: this.config.dataDir,
      workspaces: () => this.workspaces,
      embedder: this.embedder,
    });
    return this.indexer;
  }

  private readonly shouldStop = () => this.stopped;

  async handle(req: HostRequest): Promise<unknown> {
    switch (req.method) {
      case 'setStopped':
        this.stopped = req.stopped;
        return null;
      case 'scan':
        this.workspaces = req.workspaces;
        return this.ix.scan(this.shouldStop);
      case 'embedPending':
        this.workspaces = req.workspaces;
        await this.ix.embedPending(this.shouldStop, () => this.events.onBatch());
        return null;
      case 'stats': {
        this.workspaces = req.workspaces;
        const out: HistoryWorkspaceStats[] = [];
        for (const ws of req.workspaces) {
          const stats = this.ix.store(ws.id)?.stats();
          if (stats) out.push({ workspaceId: ws.id, ...stats });
        }
        return out;
      }
      case 'search': {
        const store = this.ix.store(req.workspaceId);
        if (!store) return [] as SearchHit[];
        return store.search({ text: req.text, vector: req.vector, limit: req.limit, since: req.since });
      }
      case 'sessionsForFile': {
        const store = this.ix.store(req.workspaceId);
        if (!store) return [];
        // One line per session (its newest edit): agents want "which sessions",
        // and `show` reaches the rest of a session's edits.
        return store.sessionsForFile(req.filePath, req.limit).flatMap((e) =>
          e.chunks.slice(0, 1).map((c) => ({ sessionId: e.sessionId, chunkId: c.chunkId, ts: c.ts, title: e.sessionTitle })),
        );
      }
      case 'fileEdits': {
        // Every session edit of the file (not one per session like above):
        // `why` attributes edits to commits by time, so it needs them all.
        const store = this.ix.store(req.workspaceId);
        if (!store) return [];
        return store.sessionsForFile(req.filePath, 200).flatMap((e) =>
          e.chunks.map((c) => ({ sessionId: e.sessionId, chunkId: c.chunkId, ts: c.ts, title: e.sessionTitle, snippet: c.snippet })),
        );
      }
      case 'showChunk': {
        const store = this.ix.store(req.workspaceId);
        const chunk = store?.getChunk(req.chunkId);
        if (!store || !chunk) return [];
        return store
          .getSessionChunks(chunk.sessionId, { aroundChunkId: req.chunkId, radius: req.radius })
          .map((c) => ({ chunkId: c.id, ts: c.ts, text: c.text }));
      }
      case 'listSessions': {
        const store = this.ix.store(req.workspaceId);
        if (!store) return [];
        return store.listSessions(req.limit).map((s) => ({
          sessionId: s.id, title: s.title, firstTs: s.firstTs, lastTs: s.lastTs, chunks: s.chunkCount,
        }));
      }
      case 'distillScan':
        this.workspaces = req.workspaces;
        return this.ix.distillScan(req.now, req.write);
      case 'distillInput':
        this.workspaces = req.workspaces;
        return this.ix.distillInput(req.item);
      case 'distillCommit':
        this.workspaces = req.workspaces;
        return this.ix.distillCommit(req.item, req.input, req.result, req.now);
      case 'deleteNotes':
        this.workspaces = req.workspaces;
        return this.ix.deleteNotes();
      case 'close':
        this.indexer?.close();
        this.indexer = null;
        return null;
    }
  }
}
