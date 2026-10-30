import { Worker } from 'node:worker_threads';
import { IndexerHost, type HostConfig, type HostRequest } from './indexer-host';
import type { Embedder } from './types';

// ─── Workspace history: main-side client of the indexer host ─────────────────
// Main talks to the indexer only through `call()`. In the app the host lives in
// a worker thread (history-worker.ts) so parsing and SQLite never block the
// main thread; tests pass `inProcess: true` to run the same host directly.
// Embedding requests from the host are answered with main's runtime.
//
// The worker is started on the first call and terminated by close(), so a
// disabled feature holds no thread.

export type WorkerInbound =
  | { type: 'request'; id: number; request: HostRequest }
  | { type: 'embedResult'; embedId: number; vectors?: Float32Array[]; error?: string };

export type WorkerOutbound =
  | { type: 'result'; id: number; result?: unknown; error?: string }
  | { type: 'embed'; embedId: number; texts: string[]; kind: 'document' | 'query' }
  | { type: 'batch' };

export interface IndexerClientOptions extends HostConfig {
  embedder: Embedder;
  onBatch: () => void;
  /** Absolute path of the built history-worker.js; ignored when inProcess. */
  workerPath?: string;
  inProcess?: boolean;
}

export class IndexerClient {
  private worker: Worker | null = null;
  private host: IndexerHost | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly opts: IndexerClientOptions) {}

  call<T>(request: HostRequest): Promise<T> {
    if (this.opts.inProcess) {
      this.host ??= new IndexerHost(this.opts, this.opts.embedder, { onBatch: this.opts.onBatch });
      return this.host.handle(request) as Promise<T>;
    }
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ type: 'request', id, request } satisfies WorkerInbound);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (!this.opts.workerPath) throw new Error('history worker path not configured');
    const config: HostConfig = { projectsDir: this.opts.projectsDir, dataDir: this.opts.dataDir };
    const worker = new Worker(this.opts.workerPath, { workerData: config });
    worker.on('message', (msg: WorkerOutbound) => {
      if (msg.type === 'batch') {
        this.opts.onBatch();
      } else if (msg.type === 'embed') {
        this.opts.embedder.embed(msg.texts, msg.kind).then(
          (vectors) => worker.postMessage({ type: 'embedResult', embedId: msg.embedId, vectors } satisfies WorkerInbound),
          (err: unknown) => worker.postMessage({
            type: 'embedResult', embedId: msg.embedId, error: err instanceof Error ? err.message : String(err),
          } satisfies WorkerInbound),
        );
      } else {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.error !== undefined) waiter.reject(new Error(msg.error));
        else waiter.resolve(msg.result);
      }
    });
    // A crashed worker fails everything in flight; the next call starts a new one.
    const fail = (err: Error) => {
      for (const w of this.pending.values()) w.reject(err);
      this.pending.clear();
      this.worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', (code) => { if (this.worker === worker) fail(new Error(`history worker exited (${code})`)); });
    this.worker = worker;
    return worker;
  }

  /** Close the DBs and stop the worker thread. */
  async close(): Promise<void> {
    if (this.opts.inProcess) {
      await this.host?.handle({ method: 'close' });
      this.host = null;
      return;
    }
    const worker = this.worker;
    if (!worker) return;
    await this.call({ method: 'close' }).catch(() => {});
    this.worker = null;
    await worker.terminate();
  }
}
