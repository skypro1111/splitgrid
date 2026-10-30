import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EmbeddingRuntime, type InstallProgress } from './runtime';
import { HISTORY_EMBED_DIM } from './types';

// Real end-to-end check: downloads the pinned llama.cpp release + model (~335
// MB), spawns llama-server and embeds. Excluded from the default run; execute with
//   VITEST_LIVE=1 npx vitest run src/main/history/runtime.live.test.ts
// Set SG_RUNTIME_LIVE_DIR to reuse an install root across runs.

const root = process.env.SG_RUNTIME_LIVE_DIR || mkdtempSync(path.join(os.tmpdir(), 'sg-runtime-live-'));
const norm = (v: Float32Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('EmbeddingRuntime live', () => {
  const rt = new EmbeddingRuntime({ rootDir: root, idleMs: 3_000, log: (m) => console.log(m) });

  it('installs and verifies', async () => {
    const seen: InstallProgress[] = [];
    const t0 = Date.now();
    await rt.install({ onProgress: (p) => seen.push(p) });
    console.log(`install: ${((Date.now() - t0) / 1000).toFixed(1)}s, last progress`, seen[seen.length - 1]);
    expect(rt.isInstalled()).toBe(true);
    // A second install is a no-op (nothing to fetch).
    await rt.install();
  }, 900_000);

  it('embeds documents and queries as unit 256-d vectors', async () => {
    const t0 = Date.now();
    const docs = await rt.embed(
      ['How to bake sourdough bread at home with a starter.', 'Kubernetes pod scheduling and node affinity rules.'],
      'document',
    );
    console.log(`first embed (incl. server start): ${Date.now() - t0}ms`);
    const [q] = await rt.embed(['bread baking'], 'query');
    for (const v of [...docs, q]) {
      expect(v.length).toBe(HISTORY_EMBED_DIM);
      expect(norm(v)).toBeCloseTo(1, 4);
    }
    console.log('cos(query, bread) =', dot(q, docs[0]).toFixed(4), ' cos(query, k8s) =', dot(q, docs[1]).toFixed(4));
    expect(dot(q, docs[0])).toBeGreaterThan(dot(q, docs[1]));
  }, 180_000);

  it('throughput, over-long input, restart after crash, idle shutdown', async () => {
    const para = 'The indexer walks every Claude Code transcript under the workspace folder and embeds each turn. ';
    const texts = Array.from({ length: 64 }, (_, i) => `${i}: ${para.repeat(20)}`);
    const chars = texts.reduce((s, t) => s + t.length, 0);
    const t0 = Date.now();
    const out = await rt.embed(texts, 'document');
    const secs = (Date.now() - t0) / 1000;
    console.log(`throughput: ${texts.length} docs, ${chars} chars in ${secs.toFixed(2)}s ≈ ${Math.round(chars / 4 / secs)} tok/s (chars/4 estimate)`);
    expect(out.length).toBe(64);

    // ~24k CJK chars → >8192 tokens even after the 20k clamp; must be halved, not fail.
    const [cjk] = await rt.embed(['中文'.repeat(12_000)], 'document');
    expect(cjk.length).toBe(HISTORY_EMBED_DIM);

    // Kill the server behind the runtime's back; next call must restart transparently.
    const child = (rt as unknown as { child: { pid: number; kill: (s: string) => void } | null }).child;
    expect(child).not.toBeNull();
    child!.kill('SIGKILL');
    await sleep(300);
    const [again] = await rt.embed(['still works'], 'query');
    expect(again.length).toBe(HISTORY_EMBED_DIM);

    await sleep(4_000);
    expect((rt as unknown as { child: unknown }).child).toBeNull();
    await rt.stop();
  }, 300_000);
});
