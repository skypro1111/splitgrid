import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_PREFIX,
  EmbeddingRuntime,
  IdleTimer,
  LLAMA_ASSETS,
  LLAMA_CPP_TAG,
  MAX_INPUT_CHARS,
  MODEL_ASSET,
  QUERY_PREFIX,
  clampInput,
  downloadVerified,
  extractCommand,
  isAbortError,
  isKeptFile,
  makeBatches,
  selectLlamaAsset,
  serverArgs,
  sha256File,
  truncateNormalize,
  withPrefix,
} from './runtime';
import { HISTORY_EMBED_DIM } from './types';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('manifest + platform selection', () => {
  it('maps each supported platform to its own pinned asset', () => {
    expect(selectLlamaAsset('darwin', 'arm64')?.url).toContain(`llama-${LLAMA_CPP_TAG}-bin-macos-arm64.tar.gz`);
    expect(selectLlamaAsset('darwin', 'x64')?.url).toContain('bin-macos-x64.tar.gz');
    expect(selectLlamaAsset('linux', 'x64')?.url).toContain('bin-ubuntu-x64.tar.gz');
    expect(selectLlamaAsset('win32', 'x64')?.url).toContain('bin-win-cpu-x64.zip');
  });

  it('returns null for unsupported combinations', () => {
    expect(selectLlamaAsset('win32', 'arm64')).toBeNull();
    expect(selectLlamaAsset('linux', 'arm64')).toBeNull();
    expect(selectLlamaAsset('freebsd', 'x64')).toBeNull();
    // Prototype keys must not resolve to anything.
    expect(selectLlamaAsset('constructor' as NodeJS.Platform, '' as string)).toBeNull();
  });

  it('pins every asset by https URL, lowercase sha256 and size', () => {
    for (const a of [...Object.values(LLAMA_ASSETS), MODEL_ASSET]) {
      expect(a.url.startsWith('https://')).toBe(true);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.size).toBeGreaterThan(1_000_000);
    }
    // The model URL is commit-pinned, never `main`.
    expect(MODEL_ASSET.url).toContain(`/resolve/${MODEL_ASSET.revision}/`);
    expect(MODEL_ASSET.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('keeps the shared libs the server needs and drops the other tools', () => {
    const mac = LLAMA_ASSETS['darwin-arm64'];
    expect(mac.libPattern.test('libllama.0.dylib')).toBe(true);
    expect(mac.libPattern.test('llama-cli')).toBe(false);
    const linux = LLAMA_ASSETS['linux-x64'];
    expect(linux.libPattern.test('libllama.so.0.8.0')).toBe(true);
    expect(linux.libPattern.test('libggml-cpu-haswell.so')).toBe(true);
    expect(linux.libPattern.test('llama-connect')).toBe(false);
    const win = LLAMA_ASSETS['win32-x64'];
    expect(win.libPattern.test('libomp.dll')).toBe(true);
    expect(win.libPattern.test('llama-connect.exe')).toBe(false);
    for (const a of Object.values(LLAMA_ASSETS)) {
      for (const lib of a.requiredLibs) expect(isKeptFile(a, lib)).toBe(true);
      expect(isKeptFile(a, path.posix.basename(a.serverPath))).toBe(true);
    }
    // Other tools' -impl libs are dropped; the server's is kept.
    expect(isKeptFile(mac, 'libllama-cli-impl.dylib')).toBe(false);
    expect(isKeptFile(mac, 'libllama-server-impl.dylib')).toBe(true);
    expect(isKeptFile(linux, 'libllama-bench-impl.so')).toBe(false);
    expect(isKeptFile(win, 'llama-cli-impl.dll')).toBe(false);
    expect(isKeptFile(win, 'llama-server.exe')).toBe(true);
    expect(isKeptFile(win, 'llama.exe')).toBe(false);
  });

  it('extracts with the system tool, using System32 tar.exe on Windows', () => {
    expect(extractCommand('tar.gz', '/a.tgz', '/d', 'darwin')).toEqual({ cmd: 'tar', args: ['-xzf', '/a.tgz', '-C', '/d'] });
    expect(extractCommand('tar.gz', '/a.tgz', '/d', 'linux').cmd).toBe('tar');
    const win = extractCommand('zip', 'C:\\a.zip', 'C:\\d', 'win32');
    expect(win.cmd.toLowerCase()).toMatch(/system32\\tar\.exe$/);
    expect(win.args).toEqual(['-xf', 'C:\\a.zip', '-C', 'C:\\d']);
  });

  it('builds the llama-server command line', () => {
    const args = serverArgs({ modelPath: '/m.gguf', port: 4321, threads: 3 });
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(flag('-m')).toBe('/m.gguf');
    expect(args).toContain('--embedding');
    expect(flag('--pooling')).toBe('mean');
    expect(flag('-c')).toBe('8192');
    expect(flag('-ub')).toBe('8192');
    expect(flag('--host')).toBe('127.0.0.1');
    expect(flag('--port')).toBe('4321');
    expect(flag('-np')).toBe('1');
    expect(flag('-t')).toBe('3');
  });
});

describe('input/output shaping', () => {
  it('prefixes documents and queries differently', () => {
    expect(withPrefix('hello', 'document')).toBe(`${DOCUMENT_PREFIX}hello`);
    expect(withPrefix('hello', 'query')).toBe(`${QUERY_PREFIX}hello`);
    expect(DOCUMENT_PREFIX).toBe('title: none | text: ');
    expect(QUERY_PREFIX).toBe('task: search result | query: ');
  });

  it('clamps over-long inputs without splitting a surrogate pair', () => {
    expect(clampInput('short')).toBe('short');
    expect(clampInput('x'.repeat(MAX_INPUT_CHARS + 50)).length).toBe(MAX_INPUT_CHARS);
    const s = 'ab😀cd'; // 😀 is two UTF-16 code units at index 2–3
    expect(clampInput(s, 3)).toBe('ab');
    expect(clampInput(s, 4)).toBe('ab😀');
  });

  it('truncates to HISTORY_EMBED_DIM and re-normalises', () => {
    const v = Array.from({ length: 768 }, (_, i) => Math.sin(i + 1));
    const out = truncateNormalize(v);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(HISTORY_EMBED_DIM);
    const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    // Direction preserved: same ratios as the input's prefix.
    expect(out[1] / out[0]).toBeCloseTo(v[1] / v[0], 4);
  });

  it('leaves a zero vector as zeros and rejects short vectors', () => {
    expect(Array.from(truncateNormalize(new Array(300).fill(0), 4))).toEqual([0, 0, 0, 0]);
    expect(() => truncateNormalize([1, 2, 3])).toThrow(/3 dims/);
  });

  it('batches by item count and char budget, never emitting an empty batch', () => {
    expect(makeBatches([])).toEqual([]);
    expect(makeBatches(['a', 'b', 'c', 'd', 'e'], 2).map((b) => b.length)).toEqual([2, 2, 1]);
    const big = 'x'.repeat(30);
    expect(makeBatches([big, big, big], 10, 50).map((b) => b.length)).toEqual([1, 1, 1]);
    // An input bigger than the whole budget still goes, alone.
    expect(makeBatches(['x'.repeat(100), 'y'], 10, 50)).toEqual([['x'.repeat(100)], ['y']]);
  });
});

describe('IdleTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after the idle period when nothing is in flight', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const t = new IdleTimer(5 * 60_000, onIdle);
    t.busy();
    t.release();
    expect(t.armed).toBe(true);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(t.armed).toBe(false);
    vi.advanceTimersByTime(60 * 60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('never fires while a request is in flight, and restarts the clock on new work', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const t = new IdleTimer(1000, onIdle);
    t.busy();
    t.busy();
    t.release(); // one still in flight
    expect(t.armed).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
    t.release();
    vi.advanceTimersByTime(900);
    t.busy(); // new work cancels the pending shutdown
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();
    t.release();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('cancel() disarms', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const t = new IdleTimer(1000, onIdle);
    t.busy();
    t.release();
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe('downloadVerified (loopback server)', () => {
  const payload = Buffer.from('splitgrid embedding runtime test payload\n'.repeat(1000));
  let server: http.Server;
  let base = '';
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sg-runtime-test-'));
    server = http.createServer((req, res) => {
      if (req.url === '/file') {
        res.writeHead(200, { 'content-length': String(payload.length) });
        res.end(payload);
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/file' }); // relative, like HF's hops
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else if (req.url === '/offsite') {
        res.writeHead(302, { location: 'http://example.com/file' });
        res.end();
      } else if (req.url === '/slow') {
        res.writeHead(200);
        res.write(payload.subarray(0, 100)); // then hang
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('downloads through a redirect, reports bytes, and lands the verified file', async () => {
    const dest = path.join(dir, 'ok', 'file.bin');
    let bytes = 0;
    await downloadVerified(`${base}/redirect`, dest, sha(payload), { onBytes: (n) => (bytes += n) });
    expect(readFileSync(dest).equals(payload)).toBe(true);
    expect(bytes).toBe(payload.length);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(await sha256File(dest)).toBe(sha(payload));
  });

  it('deletes the file and fails clearly on a checksum mismatch', async () => {
    const dest = path.join(dir, 'bad', 'file.bin');
    const fake = 'f'.repeat(64);
    await expect(downloadVerified(`${base}/file`, dest, fake)).rejects.toThrow(/Checksum mismatch.*expected sha256 f{64}/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('does not replace an existing good file when the new download fails verification', async () => {
    const dest = path.join(dir, 'keep.bin');
    writeFileSync(dest, 'previous');
    await expect(downloadVerified(`${base}/file`, dest, '0'.repeat(64))).rejects.toThrow(/Checksum mismatch/);
    expect(readFileSync(dest, 'utf-8')).toBe('previous');
  });

  it('fails on HTTP errors, redirect loops and non-https off-loopback hops', async () => {
    await expect(downloadVerified(`${base}/missing`, path.join(dir, 'x'), sha(payload))).rejects.toThrow(/HTTP 404/);
    await expect(downloadVerified(`${base}/loop`, path.join(dir, 'y'), sha(payload))).rejects.toThrow(/Too many redirects/);
    await expect(downloadVerified(`${base}/offsite`, path.join(dir, 'z'), sha(payload))).rejects.toThrow(/non-https/);
    await expect(downloadVerified('http://example.com/f', path.join(dir, 'w'), sha(payload))).rejects.toThrow(/non-https/);
  });

  it('cancels via AbortSignal and cleans up the partial file', async () => {
    const dest = path.join(dir, 'abort', 'file.bin');
    const ctl = new AbortController();
    const p = downloadVerified(`${base}/slow`, dest, sha(payload), {
      signal: ctl.signal,
      onBytes: () => ctl.abort(),
    });
    const err = await p.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});

describe('EmbeddingRuntime (no side effects until asked)', () => {
  it('construction touches neither disk nor process table', () => {
    const root = path.join(os.tmpdir(), `sg-runtime-never-created-${process.pid}-${Date.now()}`);
    const rt = new EmbeddingRuntime({ rootDir: root, platform: 'darwin', arch: 'arm64' });
    expect(existsSync(root)).toBe(false);
    expect(rt.isInstalled()).toBe(false);
    expect(existsSync(root)).toBe(false);
    expect(rt.isSupported()).toBe(true);
    expect(rt.downloadBytes()).toBe(LLAMA_ASSETS['darwin-arm64'].size + MODEL_ASSET.size);
    expect(rt.modelPath).toBe(path.join(root, 'models', MODEL_ASSET.file));
  });

  it('reports unsupported platforms and refuses to install there', async () => {
    const rt = new EmbeddingRuntime({ rootDir: '/nonexistent', platform: 'linux', arch: 'arm64' });
    expect(rt.isSupported()).toBe(false);
    expect(rt.isInstalled()).toBe(false);
    await expect(rt.install()).rejects.toThrow(/isn't available/);
  });

  it('embed([]) is a no-op and embed() before install fails without spawning', async () => {
    const rt = new EmbeddingRuntime({ rootDir: path.join(os.tmpdir(), 'sg-runtime-absent'), platform: 'darwin', arch: 'arm64' });
    await expect(rt.embedder().embed([], 'query')).resolves.toEqual([]);
    await expect(rt.embed(['x'], 'query')).rejects.toThrow(/not installed/);
    await rt.stop();
  });
});
