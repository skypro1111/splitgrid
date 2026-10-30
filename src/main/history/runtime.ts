import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeFileAtomicSync } from '../atomic-write';
import { HISTORY_EMBED_DIM, type Embedder } from './types';

// ─── Workspace history: local embedding runtime ──────────────────────────────
// Embeddings come from llama.cpp's `llama-server` running EmbeddingGemma 2
// (Q8_0 GGUF, ~310 MB) on loopback. NOTHING here ships with the app: the binary
// and the model are fetched only by install(), which the caller invokes after
// the user has consented in Settings. Importing this module or constructing
// EmbeddingRuntime touches neither the network nor the disk and spawns nothing —
// every side effect sits behind install() / embed().
//
// Why a sidecar process rather than an in-process binding: no native npm module
// to rebuild per Electron ABI, a crash in the model can't take main down, and
// the OS can deprioritise / we can kill it when idle so a 300 MB model isn't
// resident while the user isn't indexing.
//
// Integrity: every download is pinned by URL *and* sha256 (below). The hash is
// computed while streaming and compared before the file is renamed into place,
// so a truncated / tampered / MITM'd file never lands where it could be run.

// ─── Pinned manifest ─────────────────────────────────────────────────────────
// llama.cpp b11960 (commit 8642541b2) is the same build Homebrew ships as
// llama.cpp 0.8.0, which the embeddinggemma-2 spike validated (cosine ≥0.9993 vs
// the MLX/ONNX references). sha256 + size come from the GitHub release API's
// per-asset `digest` (`gh api repos/ggml-org/llama.cpp/releases/tags/b11960`) and
// were re-checked by hashing the downloaded archives.
//
// Windows/Linux use the plain CPU builds: they need nothing beyond the archive
// (the Vulkan builds need a Vulkan loader + driver, absent on many VMs/servers,
// and may land on a software rasteriser slower than the CPU path). Both CPU
// builds carry every ggml-cpu-<microarch> variant and pick one at runtime, so a
// single archive covers old and new x64 CPUs. Vulkan/CUDA are a later opt-in.
export const LLAMA_CPP_TAG = 'b11960';

export type RuntimePlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64';

export interface LlamaAsset {
  key: RuntimePlatformKey;
  url: string;
  sha256: string;
  /** Archive size in bytes (from the release API) — used for progress totals. */
  size: number;
  archive: 'tar.gz' | 'zip';
  /** Archive-relative path (`/`-separated) of the server binary. Its directory is what gets kept. */
  serverPath: string;
  /**
   * Siblings of the server binary that must come along: the shared libraries it
   * links (`@loader_path` on macOS, `$ORIGIN` on Linux, exe dir on Windows) plus
   * the ggml backend/CPU-variant libs it dlopens at runtime, including the
   * versioned symlinks (libllama.0.dylib → libllama.0.8.0.dylib) the loader
   * actually resolves. Everything else (llama-cli, llama-connect, …) is dropped.
   */
  libPattern: RegExp;
  /** A few libs whose absence means a broken extract; checked by isInstalled(). */
  requiredLibs: string[];
}

const GH = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_TAG}`;

export const LLAMA_ASSETS: Readonly<Record<RuntimePlatformKey, LlamaAsset>> = {
  'darwin-arm64': {
    key: 'darwin-arm64',
    url: `${GH}/llama-${LLAMA_CPP_TAG}-bin-macos-arm64.tar.gz`,
    sha256: '58e5a5e1d7c2bf66cedd9c29e0323f3e570660a70a1e2156d32eed08f4cc1e3c',
    size: 16_465_074,
    archive: 'tar.gz',
    serverPath: `llama-${LLAMA_CPP_TAG}/llama-server`,
    libPattern: /\.dylib$/,
    requiredLibs: ['libllama-server-impl.dylib', 'libllama.0.dylib', 'libggml-base.0.dylib', 'libggml-metal.0.dylib'],
  },
  'darwin-x64': {
    key: 'darwin-x64',
    url: `${GH}/llama-${LLAMA_CPP_TAG}-bin-macos-x64.tar.gz`,
    sha256: 'd1e6c9ddcaed9a3b1bb8f3d946bdb3481c7b919357a4029dcb747762397f1da5',
    size: 12_205_764,
    archive: 'tar.gz',
    serverPath: `llama-${LLAMA_CPP_TAG}/llama-server`,
    libPattern: /\.dylib$/,
    requiredLibs: ['libllama-server-impl.dylib', 'libllama.0.dylib', 'libggml-base.0.dylib', 'libggml-cpu.0.dylib'],
  },
  'linux-x64': {
    key: 'linux-x64',
    url: `${GH}/llama-${LLAMA_CPP_TAG}-bin-ubuntu-x64.tar.gz`,
    sha256: '31cc3a6bc638ac6c48dc4b1b74888f1eaadf3d14227c1e5f67daf9a49541d97a',
    size: 22_686_210,
    archive: 'tar.gz',
    serverPath: `llama-${LLAMA_CPP_TAG}/llama-server`,
    libPattern: /\.so(\.\d+)*$/,
    requiredLibs: ['libllama-server-impl.so', 'libllama.so.0', 'libggml-base.so.0', 'libggml-cpu-x64.so'],
  },
  'win32-x64': {
    key: 'win32-x64',
    url: `${GH}/llama-${LLAMA_CPP_TAG}-bin-win-cpu-x64.zip`,
    sha256: '73f962f82850d244db47eaacb9d913637027b82399124324298576d58c5f4287',
    size: 24_407_745,
    archive: 'zip',
    // The Windows zips are flat (no top-level directory).
    serverPath: 'llama-server.exe',
    libPattern: /\.dll$/i,
    requiredLibs: ['llama-server-impl.dll', 'llama.dll', 'ggml-base.dll', 'ggml-cpu-x64.dll', 'libomp.dll'],
  },
};

// Pinned to a commit so the bytes behind the URL can't change under us (`main`
// can be force-pushed); sha256 is the LFS oid from the HF tree API and matches
// the copy the spike benchmarked.
const MODEL_REPO = 'ggml-org/embeddinggemma-2-GGUF';
const MODEL_REVISION = '58faf90940886df2d62be555c8765d00dac362c5';
const MODEL_FILE = 'embeddinggemma-2-Q8_0.gguf';
export const MODEL_ASSET = {
  repo: MODEL_REPO,
  revision: MODEL_REVISION,
  file: MODEL_FILE,
  url: `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${MODEL_FILE}`,
  sha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
  size: 309_855_456,
} as const;

/**
 * Whether an extracted file is kept next to the server. Each llama tool ships
 * as a thin exe + `lib<tool>-impl` library, so the other tools' -impl libs
 * match the lib pattern but are dead weight; only the server's is kept.
 */
export function isKeptFile(asset: LlamaAsset, name: string): boolean {
  if (name === path.posix.basename(asset.serverPath)) return true;
  if (!asset.libPattern.test(name)) return false;
  return !/-impl\./i.test(name) || /llama-server-impl\./i.test(name);
}

/** The release asset for a platform/arch, or null when history search isn't offered there. */
export function selectLlamaAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): LlamaAsset | null {
  const key = `${platform}-${arch}`;
  return Object.prototype.hasOwnProperty.call(LLAMA_ASSETS, key)
    ? LLAMA_ASSETS[key as RuntimePlatformKey]
    : null;
}

// ─── Embedding input/output shaping ──────────────────────────────────────────
// EmbeddingGemma is trained with task prompts; documents and queries embed into
// comparable spaces only when each carries its own prefix.
export const DOCUMENT_PREFIX = 'title: none | text: ';
export const QUERY_PREFIX = 'task: search result | query: ';

export function withPrefix(text: string, kind: 'document' | 'query'): string {
  return (kind === 'query' ? QUERY_PREFIX : DOCUMENT_PREFIX) + text;
}

/**
 * Model context is 8192 tokens and llama-server rejects (500) any input that
 * doesn't fit in one ubatch. ~20k chars is ~5–7k tokens for prose/code, so this
 * cap keeps nearly everything in one shot; denser text (CJK, base64) that still
 * overflows is halved and retried in embedBatch.
 */
export const MAX_INPUT_CHARS = 20_000;
const MIN_RETRY_CHARS = 256;

export function clampInput(text: string, maxChars = MAX_INPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  // Don't cut a surrogate pair in half — a lone surrogate becomes U+FFFD noise.
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Matryoshka truncation: EmbeddingGemma's first N dims are a usable embedding
 * on their own, but only after re-normalising — the 768-d output is unit-norm,
 * its 256-d prefix isn't.
 */
export function truncateNormalize(vec: ArrayLike<number>, dim = HISTORY_EMBED_DIM): Float32Array {
  if (vec.length < dim) throw new Error(`embedding has ${vec.length} dims, need at least ${dim}`);
  const out = new Float32Array(dim);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    const v = vec[i];
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}

/**
 * Group inputs into requests. With -np 1 the server works through one input at
 * a time anyway, so batching only saves HTTP round-trips; the char budget keeps
 * a single request well inside the request timeout even on a slow CPU build.
 */
export function makeBatches(texts: string[], maxItems = 32, maxChars = 48_000): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const t of texts) {
    if (cur.length > 0 && (cur.length >= maxItems || chars + t.length > maxChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += t.length;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

// ─── Idle shutdown ───────────────────────────────────────────────────────────
// Reference-counted: busy() on every request start, release() on its end; the
// timer arms only once nothing is in flight, so a long indexing run never has
// the server pulled out from under it, and a quiet app frees the model's RAM.
export class IdleTimer {
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ms: number, private readonly onIdle: () => void) {}

  busy(): void {
    this.active++;
    this.cancel();
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) this.arm();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get armed(): boolean {
    return this.timer !== null;
  }

  private arm(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.active === 0) this.onIdle();
    }, this.ms);
    // Never keep the process alive just to shut a sidecar down.
    this.timer.unref?.();
  }
}

// ─── Verified download ───────────────────────────────────────────────────────
export function abortError(message = 'Cancelled'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR');
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Called with each chunk's byte count as it streams in. */
  onBytes?: (n: number) => void;
  maxRedirects?: number;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/**
 * Download `url` to `dest`, accepting it only if its sha256 equals `sha256`.
 * Streams into `<dest>.part` while hashing, then renames into place, so `dest`
 * is either absent or verified — never partial. Follows redirects (GitHub and
 * HF both bounce to a CDN) but refuses any non-https hop; plain http is allowed
 * only on loopback, which exists for the unit tests.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  sha256: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const part = `${dest}.part`;
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    const actual = await fetchToFile(url, part, opts, 0);
    if (actual !== sha256.toLowerCase()) {
      throw new Error(
        `Checksum mismatch for ${path.basename(dest)}: expected sha256 ${sha256}, got ${actual}. ` +
          'The download was corrupted or tampered with and has been discarded.',
      );
    }
    // Windows rename() won't replace an existing file.
    await rm(dest, { force: true });
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
    throw err;
  }
}

function fetchToFile(url: string, part: string, opts: DownloadOptions, hops: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`Invalid download URL: ${url}`));
      return;
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
      reject(new Error(`Refusing non-https download: ${u.protocol}//${u.host}`));
      return;
    }
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { headers: { 'user-agent': 'SplitGrid', accept: '*/*' }, signal: opts.signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops >= (opts.maxRedirects ?? 10)) {
          reject(new Error(`Too many redirects downloading ${u.host}${u.pathname}`));
          return;
        }
        // Location may be relative (HF's resolve-cache hops are).
        const next = new URL(res.headers.location, u).toString();
        fetchToFile(next, part, opts, hops + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} downloading ${u.host}${u.pathname}`));
        return;
      }
      const hash = createHash('sha256');
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          opts.onBytes?.(chunk.length);
          cb(null, chunk);
        },
      });
      pipeline(res, tap, createWriteStream(part), opts.signal ? { signal: opts.signal } : {})
        .then(() => resolve(hash.digest('hex')))
        .catch((err: unknown) => reject(opts.signal?.aborted ? abortError() : err));
    });
    req.on('error', (err) => reject(opts.signal?.aborted ? abortError() : err));
    // Socket-idle timeout: catches a stalled CDN connection, not a slow one.
    req.setTimeout(60_000, () => req.destroy(new Error(`Download stalled: ${u.host}`)));
  });
}

// ─── Extraction ──────────────────────────────────────────────────────────────
// No zip/tar npm dependency: the repo only has them transitively (forge
// tooling), which isn't something to build on. Every target OS has a system
// extractor — tar on macOS/Linux; on Windows 10+ the bundled bsdtar at
// System32\tar.exe, which reads zip. Its absolute path is used so a Git-for-
// Windows GNU tar earlier on PATH (which can't read zip) is never picked up.
export function extractCommand(
  archive: LlamaAsset['archive'],
  file: string,
  destDir: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    return { cmd: path.win32.join(sysRoot, 'System32', 'tar.exe'), args: ['-xf', file, '-C', destDir] };
  }
  if (archive === 'zip') return { cmd: 'unzip', args: ['-q', '-o', file, '-d', destDir] };
  return { cmd: 'tar', args: ['-xzf', file, '-C', destDir] };
}

function runTool(cmd: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, signal });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.once('error', (err) => reject(signal?.aborted ? abortError() : err));
    child.once('close', (code) => {
      if (signal?.aborted) reject(abortError());
      else if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

// ─── Server process ──────────────────────────────────────────────────────────
// Flags checked against `llama-server --help` of the pinned build:
//   --embedding --pooling mean     embedding-only server, mean pooling (what the model was trained with)
//   -c/-b/-ub 8192                 whole context in one ubatch — embeddings must fit a single ubatch
//   -np 1                          one slot, so the slot gets the full 8192 context
//   --host 127.0.0.1               loopback only; LLAMA_API_KEY (env, not argv, so it's not in `ps`) gates it
//   --offline                      never touch the network (it can't, but belt and braces)
//   --no-webui                     no chat UI on our port
//   --cache-ram 0                  no prompt cache: embedding inputs never repeat, the default reserves up to 8 GiB
//   -t N                           leave cores for the user on CPU builds
export function serverArgs(o: { modelPath: string; port: number; threads: number }): string[] {
  return [
    '-m', o.modelPath,
    '--embedding',
    '--pooling', 'mean',
    '-c', '8192',
    '-b', '8192',
    '-ub', '8192',
    '--host', '127.0.0.1',
    '--port', String(o.port),
    '-np', '1',
    '-t', String(o.threads),
    '--offline',
    '--no-webui',
    '--cache-ram', '0',
  ];
}

function defaultThreads(): number {
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, Math.floor(n / 2)));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class InputTooLargeError extends Error {}

interface InstalledRecord {
  version: 1;
  platform: RuntimePlatformKey;
  llama?: { tag: string; sha256: string };
  model?: { revision: string; sha256: string };
}

export interface InstallProgress {
  phase: 'download' | 'extract' | 'done';
  /** Bytes downloaded / total across binary + model (only what this install actually fetches). */
  downloadedBytes: number;
  totalBytes: number;
}

export interface InstallOptions {
  signal?: AbortSignal;
  onProgress?: (p: InstallProgress) => void;
}

export interface EmbeddingRuntimeOptions {
  /** Install root; the caller uses `<userData>/history/runtime`. Not created until install(). */
  rootDir: string;
  /** Stop the server after this long with no requests in flight (default 5 min). */
  idleMs?: number;
  /** CPU threads for llama-server (default: half the cores, 1–8). */
  threads?: number;
  /** Overrides for tests; default to the running process. */
  platform?: NodeJS.Platform;
  arch?: string;
  /** Diagnostics sink (server start/stop, restarts). */
  log?: (msg: string) => void;
}

const STARTUP_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 300_000;

export class EmbeddingRuntime {
  readonly rootDir: string;
  readonly asset: LlamaAsset | null;
  private readonly threads: number;
  private readonly log: (msg: string) => void;
  private readonly idle: IdleTimer;

  private installing: Promise<void> | null = null;
  private installAbort: AbortController | null = null;

  private child: ChildProcess | null = null;
  private ready = false;
  private port = 0;
  private apiKey = '';
  private starting: Promise<void> | null = null;
  /** Bumped by stopServer() so an in-progress start knows it was cancelled. */
  private generation = 0;

  constructor(opts: EmbeddingRuntimeOptions) {
    this.rootDir = opts.rootDir;
    this.asset = selectLlamaAsset(opts.platform ?? process.platform, opts.arch ?? process.arch);
    this.threads = opts.threads ?? defaultThreads();
    this.log = opts.log ?? (() => {});
    this.idle = new IdleTimer(opts.idleMs ?? 5 * 60_000, () => {
      this.log('history runtime: idle, stopping llama-server');
      void this.stopServer();
    });
  }

  // ── Paths ──
  get binDir(): string {
    return path.join(this.rootDir, 'bin');
  }
  get serverPath(): string {
    return path.join(this.binDir, path.posix.basename(this.asset?.serverPath ?? 'llama-server'));
  }
  get modelPath(): string {
    return path.join(this.rootDir, 'models', MODEL_ASSET.file);
  }
  private get recordPath(): string {
    return path.join(this.rootDir, 'installed.json');
  }
  private get tmpDir(): string {
    return path.join(this.rootDir, 'tmp');
  }

  isSupported(): boolean {
    return this.asset !== null;
  }

  /** Bytes a fresh install downloads (for the consent prompt). */
  downloadBytes(): number {
    return (this.asset?.size ?? 0) + MODEL_ASSET.size;
  }

  // ── Install state ──
  private readRecord(): InstalledRecord | null {
    try {
      const rec = JSON.parse(readFileSync(this.recordPath, 'utf-8')) as InstalledRecord;
      return rec && rec.version === 1 ? rec : null;
    } catch {
      return null;
    }
  }

  private binaryPresent(asset: LlamaAsset): boolean {
    if (!existsSync(this.serverPath)) return false;
    return asset.requiredLibs.every((lib) => existsSync(path.join(this.binDir, lib)));
  }

  private modelPresent(): boolean {
    // Size, not hash: hashing 300 MB on every check is too slow, and the hash
    // was verified before the file was renamed into place.
    try {
      return statSync(this.modelPath).size === MODEL_ASSET.size;
    } catch {
      return false;
    }
  }

  private binaryCurrent(rec: InstalledRecord | null, asset: LlamaAsset): boolean {
    return !!rec && rec.platform === asset.key && rec.llama?.sha256 === asset.sha256 && this.binaryPresent(asset);
  }

  private modelCurrent(rec: InstalledRecord | null): boolean {
    return !!rec && rec.model?.sha256 === MODEL_ASSET.sha256 && this.modelPresent();
  }

  /**
   * Cheap check (one small JSON read + a few stats): the recorded manifest
   * matches this build's pins and the files are where they should be. A pin bump
   * in a new app version makes this false, so the caller reinstalls — and
   * install() then re-fetches only the half whose pin changed.
   */
  isInstalled(): boolean {
    const asset = this.asset;
    if (!asset) return false;
    const rec = this.readRecord();
    return this.binaryCurrent(rec, asset) && this.modelCurrent(rec);
  }

  /**
   * Download, verify and unpack llama-server + the model. Call only after the
   * user consented. Concurrent calls share one install (the first caller's
   * progress callback and signal win). Rejects with an AbortError on cancel.
   */
  install(opts: InstallOptions = {}): Promise<void> {
    if (this.installing) return this.installing;
    const ctl = new AbortController();
    this.installAbort = ctl;
    const signal = opts.signal ? AbortSignal.any([opts.signal, ctl.signal]) : ctl.signal;
    this.installing = this.doInstall(signal, opts.onProgress).finally(() => {
      this.installing = null;
      this.installAbort = null;
    });
    return this.installing;
  }

  private async doInstall(signal: AbortSignal, onProgress?: (p: InstallProgress) => void): Promise<void> {
    const asset = this.asset;
    if (!asset) throw new Error(`Workspace history search isn't available on ${process.platform}-${process.arch}`);

    // A server running from the bin we're about to replace would keep the old
    // files open (and on Windows block their removal).
    await this.stopServer();

    let rec = this.readRecord();
    if (rec && rec.platform !== asset.key) rec = null;
    const needBinary = !this.binaryCurrent(rec, asset);
    const needModel = !this.modelCurrent(rec);
    const totalBytes = (needBinary ? asset.size : 0) + (needModel ? MODEL_ASSET.size : 0);
    let downloadedBytes = 0;
    let lastEmit = 0;
    const emit = (phase: InstallProgress['phase'], force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 100) return;
      lastEmit = now;
      onProgress?.({ phase, downloadedBytes, totalBytes });
    };
    const onBytes = (n: number) => {
      downloadedBytes += n;
      emit('download');
    };

    const record: InstalledRecord = { version: 1, platform: asset.key, llama: rec?.llama, model: rec?.model };
    const saveRecord = () => writeFileAtomicSync(this.recordPath, JSON.stringify(record, null, 2));

    emit('download', true);
    await mkdir(this.tmpDir, { recursive: true });
    try {
      if (needBinary) {
        // Invalidate before touching bin/ so a crash mid-swap can't leave a
        // record vouching for a half-replaced directory.
        record.llama = undefined;
        saveRecord();
        const archive = path.join(this.tmpDir, path.posix.basename(new URL(asset.url).pathname));
        await downloadVerified(asset.url, archive, asset.sha256, { signal, onBytes });
        emit('extract', true);
        await this.installBinary(asset, archive, signal);
        record.llama = { tag: LLAMA_CPP_TAG, sha256: asset.sha256 };
        saveRecord();
      }
      if (needModel) {
        record.model = undefined;
        saveRecord();
        emit('download', true);
        await downloadVerified(MODEL_ASSET.url, this.modelPath, MODEL_ASSET.sha256, { signal, onBytes });
        record.model = { revision: MODEL_ASSET.revision, sha256: MODEL_ASSET.sha256 };
        saveRecord();
      }
      if (!needBinary && !needModel) saveRecord();
      emit('done', true);
    } finally {
      await rm(this.tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async installBinary(asset: LlamaAsset, archive: string, signal: AbortSignal): Promise<void> {
    const staging = path.join(this.tmpDir, 'extract');
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const { cmd, args } = extractCommand(asset.archive, archive, staging);
    await runTool(cmd, args, signal);

    const serverSrc = path.join(staging, ...asset.serverPath.split('/'));
    if (!existsSync(serverSrc)) throw new Error(`llama-server not found in ${path.basename(archive)}`);
    const srcDir = path.dirname(serverSrc);

    // Keep the server + its shared libs; drop the other tools. rm() on a
    // symlink removes the link, never its target.
    for (const name of await readdir(srcDir)) {
      if (isKeptFile(asset, name)) continue;
      await rm(path.join(srcDir, name), { recursive: true, force: true });
    }
    for (const lib of asset.requiredLibs) {
      if (!existsSync(path.join(srcDir, lib))) throw new Error(`${lib} missing from ${path.basename(archive)}`);
    }
    if (process.platform !== 'win32') await chmod(serverSrc, 0o755);

    // macOS: files written by Node's https + tar carry no com.apple.quarantine
    // xattr (only LSQuarantine-aware apps / browsers set it), so Gatekeeper
    // never assesses them and the release's linker-signed binary just runs.
    // Strip it anyway in case the host app ever opts into LSFileQuarantine —
    // best effort, a missing attribute is the normal case.
    if (process.platform === 'darwin') {
      await runTool('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', srcDir]).catch(() => {});
    }

    await rm(this.binDir, { recursive: true, force: true });
    await rename(srcDir, this.binDir);
  }

  /** Stop the server, cancel any install, and delete everything under rootDir. */
  async uninstall(): Promise<void> {
    this.installAbort?.abort();
    await this.installing?.catch(() => {});
    await this.stop();
    await rm(this.rootDir, { recursive: true, force: true });
  }

  // ── Serving ──
  embedder(): Embedder {
    return { embed: (texts, kind) => this.embed(texts, kind) };
  }

  /** L2-normalised HISTORY_EMBED_DIM vectors, one per input, in order. Starts the server on demand. */
  async embed(texts: string[], kind: 'document' | 'query'): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    this.idle.busy();
    try {
      const out: Float32Array[] = [];
      for (const batch of makeBatches(texts.map((t) => clampInput(t)))) {
        out.push(...(await this.embedBatch(batch, kind)));
      }
      return out;
    } finally {
      this.idle.release();
    }
  }

  private async embedBatch(raw: string[], kind: 'document' | 'query'): Promise<Float32Array[]> {
    try {
      return await this.request(raw.map((t) => withPrefix(t, kind)));
    } catch (err) {
      if (!(err instanceof InputTooLargeError)) throw err;
      // Some input tokenised past the 8192-token ubatch. Find it by going one
      // at a time, then halve the offender until it fits — prefix kept intact.
      if (raw.length > 1) {
        const out: Float32Array[] = [];
        for (const t of raw) out.push(...(await this.embedBatch([t], kind)));
        return out;
      }
      const t = raw[0];
      if (t.length <= MIN_RETRY_CHARS) throw err;
      return this.embedBatch([clampInput(t, Math.floor(t.length / 2))], kind);
    }
  }

  private async request(inputs: string[]): Promise<Float32Array[]> {
    for (let attempt = 0; ; attempt++) {
      await this.ensureServer();
      try {
        return await this.post(inputs);
      } catch (err) {
        // Transport failure (process died, connection reset): restart once and
        // replay. HTTP-level errors are the server's answer, not a crash.
        if (err instanceof HttpStatusError || err instanceof InputTooLargeError || attempt >= 1) throw err;
        this.log(`history runtime: request failed (${(err as Error).message}); restarting llama-server`);
        await this.stopServer();
      }
    }
  }

  private async post(inputs: string[]): Promise<Float32Array[]> {
    const res = await fetch(`http://127.0.0.1:${this.port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: inputs, encoding_format: 'float' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch { /* not JSON */ }
      if (/too large/i.test(message)) throw new InputTooLargeError(message);
      throw new HttpStatusError(res.status, `llama-server HTTP ${res.status}: ${message.slice(0, 300)}`);
    }
    const body = JSON.parse(text) as { data?: { index: number; embedding: number[] }[] };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== inputs.length) {
      throw new HttpStatusError(res.status, `llama-server returned ${data.length} embeddings for ${inputs.length} inputs`);
    }
    return data.map((d) => truncateNormalize(d.embedding));
  }

  private async ensureServer(): Promise<void> {
    if (this.child && this.ready) return;
    if (!this.starting) {
      this.starting = this.startServer().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private async startServer(): Promise<void> {
    if (!this.isInstalled()) throw new Error('Embedding runtime is not installed');
    const gen = this.generation;
    // One retry covers the free-port race (another process grabbing the port
    // between freePort() and llama-server's bind).
    for (let attempt = 0; ; attempt++) {
      if (gen !== this.generation) throw new Error('llama-server start cancelled');
      try {
        await this.spawnOnce(gen);
        return;
      } catch (err) {
        if (attempt >= 1 || gen !== this.generation) throw err;
        this.log(`history runtime: llama-server failed to start (${(err as Error).message}); retrying`);
      }
    }
  }

  private async spawnOnce(gen: number): Promise<void> {
    const port = await freePort();
    const apiKey = randomBytes(24).toString('hex');
    // Drop any LLAMA_ARG_* the user's shell exported — they'd silently override our flags.
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('LLAMA_ARG_')) env[k] = v;
    env.LLAMA_API_KEY = apiKey;

    const child = spawn(this.serverPath, serverArgs({ modelPath: this.modelPath, port, threads: this.threads }), {
      cwd: this.binDir,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.ready = false;

    let stderrTail = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    let exited = false;
    let spawnError: Error | null = null;
    child.once('error', (err) => {
      spawnError = err;
      exited = true;
    });
    // If main dies without stop(), don't leave a 300 MB orphan behind.
    const killOnExit = () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    process.once('exit', killOnExit);
    child.once('exit', (code, sig) => {
      exited = true;
      process.removeListener('exit', killOnExit);
      if (this.child === child) {
        this.child = null;
        this.ready = false;
        this.log(`history runtime: llama-server exited (${sig ?? code})`);
      }
    });

    // Background work: never compete with the user's foreground apps.
    if (child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch { /* not permitted / already exited */ }
    }

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    const lastLines = () => stderrTail.trim().split('\n').slice(-5).join('\n');
    while (Date.now() < deadline) {
      if (gen !== this.generation) {
        await killChild(child);
        throw new Error('llama-server start cancelled');
      }
      if (exited) {
        throw spawnError ?? new Error(`llama-server exited during startup: ${lastLines()}`);
      }
      try {
        // 503 while the model loads, 200 once it can serve.
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(2_000),
        });
        await res.arrayBuffer().catch(() => {});
        if (res.ok && !exited) {
          this.port = port;
          this.apiKey = apiKey;
          this.ready = true;
          this.log(`history runtime: llama-server ready on 127.0.0.1:${port} (pid ${child.pid})`);
          return;
        }
      } catch { /* not listening yet */ }
      await sleep(250);
    }
    await killChild(child);
    throw new Error(`llama-server did not become healthy within ${STARTUP_TIMEOUT_MS / 1000}s: ${lastLines()}`);
  }

  private async stopServer(): Promise<void> {
    this.generation++;
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) await killChild(child);
  }

  /** For app quit: stop the server and the idle timer. A later embed() starts it again. */
  async stop(): Promise<void> {
    this.idle.cancel();
    await this.stopServer();
  }
}

function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(force);
      resolve();
    };
    const force = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      // Resolve regardless; the 'exit' listener cleans up whenever it lands.
      setTimeout(done, 500);
    }, 3_000);
    child.once('exit', done);
    try {
      child.kill('SIGTERM');
    } catch {
      done();
    }
  });
}
