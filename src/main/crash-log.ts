import { app } from 'electron';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Crash diagnostics, shared by the main process, the shell manager's spawn trace
// and (through an IPC channel) the renderer. One append-only file in the home
// directory — deliberately not userData, so it survives a reinstall and is easy
// to ask a user for.
//
// The point of the file is to tell an app that CRASHED from one the user quit:
// every launch writes `session start`, a clean exit writes `session end`, so a
// `session start` with no matching `session end` is a hard crash. Whatever was
// logged just before it is the lead.
const CRASH_LOG = path.join(homedir(), 'splitgrid-terminal-debug.log');
const MAX_BYTES = 4 * 1024 * 1024;

export function crashLog(msg: string, source = 'main'): void {
  try {
    // Keep the file bounded — it is append-only across every launch, and a log
    // too big to open is a log nobody can diagnose from.
    try {
      if (statSync(CRASH_LOG).size > MAX_BYTES) {
        renameSync(CRASH_LOG, `${CRASH_LOG}.1`); // one generation back is plenty
      }
    } catch {
      // No file yet, or rotation refused — keep appending either way.
    }
    appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] [${source}] ${msg}\n`);
  } catch {
    // Best-effort: diagnostics must never be able to break the app.
  }
}

export function logSessionStart(): void {
  crashLog(
    `session start pid=${process.pid} version=${app.getVersion()} electron=${process.versions.electron} platform=${process.platform} ${process.arch}`,
  );
}
