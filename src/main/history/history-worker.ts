import { parentPort, workerData } from 'node:worker_threads';
import { IndexerHost, type HostConfig, type HostRequest } from './indexer-host';
import type { WorkerInbound, WorkerOutbound } from './indexer-client';

// ─── Workspace history: worker thread entry ──────────────────────────────────
// Built as its own bundle (forge.config.ts → .vite/build/history-worker.js) and
// started by IndexerClient. Hosts all transcript parsing and SQLite work so the
// Electron main thread never blocks on it. Embedding requests go back to main,
// which owns the llama-server runtime.

if (!parentPort) throw new Error('history-worker must run as a worker thread');
const port = parentPort;

let embedSeq = 0;
const embedWaiters = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

const post = (msg: WorkerOutbound) => port.postMessage(msg);

const host = new IndexerHost(
  workerData as HostConfig,
  {
    embed: (texts, kind) =>
      new Promise<Float32Array[]>((resolve, reject) => {
        const embedId = ++embedSeq;
        embedWaiters.set(embedId, { resolve, reject });
        post({ type: 'embed', embedId, texts, kind });
      }),
  },
  { onBatch: () => post({ type: 'batch' }) },
);

port.on('message', (msg: WorkerInbound) => {
  if (msg.type === 'embedResult') {
    const waiter = embedWaiters.get(msg.embedId);
    if (!waiter) return;
    embedWaiters.delete(msg.embedId);
    if (msg.error !== undefined) waiter.reject(new Error(msg.error));
    else waiter.resolve(msg.vectors ?? []);
    return;
  }
  const { id, request } = msg;
  host.handle(request as HostRequest).then(
    (result) => post({ type: 'result', id, result }),
    (err: unknown) => post({ type: 'result', id, error: err instanceof Error ? err.message : String(err) }),
  );
});
