import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

// ─── Claude Code pane diagnostics ────────────────────────────────────────────
// A hung pane is the hard case: the renderer shows "Starting…" and nothing
// says WHERE it stopped — the SDK import, the CLI spawn, the initialize
// round-trip, or the IPC hop back to the pane. So every step of a session's
// life is stamped here, in memory (for the /agent bridge to read live) and
// appended to an NDJSON file (so a crash or a freeze still leaves the trail).
//
// Deliberately dependency-free: no Electron import, so it stays unit-testable
// and cannot itself fail during early startup.

export interface AgentDiagEntry {
  at: number;
  sessionId: string;
  step: string;
  detail?: Record<string, unknown>;
}

const MAX_ENTRIES = 3000;
/** The NDJSON file rolls over to `<log>.1` past this, so it can't grow forever. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const entries: AgentDiagEntry[] = [];

let logPath: string | null = null;
let writeChain: Promise<void> = Promise.resolve();
/** Bytes in the current file; null until the sink has been prepared once. */
let logBytes: number | null = null;

/** Point the NDJSON sink at a writable dir (userData). Optional. */
export function configureAgentDiagnostics(dir: string): void {
  logPath = path.join(dir, 'agent-panes.log');
  logBytes = null;
}

/** First write: create the dir and learn the existing size. Later: rotate. */
async function prepareSink(target: string, incoming: number): Promise<void> {
  if (logBytes === null) {
    await mkdir(path.dirname(target), { recursive: true });
    logBytes = await stat(target).then((s) => s.size, () => 0);
  }
  if (logBytes + incoming > MAX_LOG_BYTES) {
    await rename(target, `${target}.1`).catch(() => {});
    logBytes = 0;
  }
}

/** Record one step. Never throws — diagnostics must not break a session. */
export function agentDiag(
  sessionId: string,
  step: string,
  detail?: Record<string, unknown>,
): void {
  const entry: AgentDiagEntry = { at: Date.now(), sessionId, step, ...(detail ? { detail } : {}) };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  const target = logPath;
  if (!target) return;
  // Serialised appends so interleaved sessions can't tear a line.
  const line = `${JSON.stringify(entry)}\n`;
  writeChain = writeChain
    .then(async () => {
      await prepareSink(target, Buffer.byteLength(line));
      await appendFile(target, line, 'utf8');
      logBytes = (logBytes ?? 0) + Buffer.byteLength(line);
    })
    .catch(() => {
      // A diagnostics sink that fails is still better than a crashed session.
    });
}

/** Recent steps, newest last. Filter by session and cap the tail. */
export function readAgentDiagnostics(sessionId?: string, tail = 200): AgentDiagEntry[] {
  const filtered = sessionId ? entries.filter((entry) => entry.sessionId === sessionId) : entries;
  return filtered.slice(Math.max(0, filtered.length - tail));
}

/** Absolute path of the NDJSON log, for pointing a human at it. */
export function agentDiagnosticsLogPath(): string | null {
  return logPath;
}

/** Test seam. */
export function resetAgentDiagnostics(): void {
  entries.length = 0;
  logPath = null;
  logBytes = null;
}
