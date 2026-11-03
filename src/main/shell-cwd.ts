import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';

// ─── Live working directory of a terminal's shell ───────────────────────────
// A pane persists the folder its terminal was CREATED in; after a `cd` that is
// stale, so a reopened workspace put every terminal back where it started. The
// shell manager polls these readers and pushes changes to the renderer, which
// keeps the pane's saved cwd current — on disk at all times, so a killed or
// crashed app restores from it too, not only a clean close.
//
// It reads the SHELL's cwd (the pty's root pid), not the foreground job's: with
// `claude` or `vim` running, the shell still sits in the folder it was started
// from, and that is the folder to reopen.
//
// macOS: one `lsof` for every pid. Linux: /proc/<pid>/cwd. Windows (incl. WSL):
// no process API for a shell's cwd, so nothing is reported and the pane keeps
// its creation folder, as before.

/** Parse `lsof -a -d cwd -p <pids> -Fn` output into pid → cwd. */
export function parseLsofCwd(output: string): Map<number, string> {
  const byPid = new Map<number, string>();
  let pid = 0;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value) || 0;
    } else if (tag === 'n' && pid > 0 && value.startsWith('/') && !byPid.has(pid)) {
      byPid.set(pid, value);
    }
  }
  return byPid;
}

/** Linux marks a cwd whose directory was removed as "<path> (deleted)". */
export function normalizeProcCwd(link: string): string | null {
  if (!link.startsWith('/') || link.endsWith(' (deleted)')) return null;
  return link;
}

function lsofCwds(pids: number[]): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn', '-w'],
      { timeout: 1500, maxBuffer: 1024 * 1024 },
      // lsof exits 1 when ANY listed pid is gone, yet still prints the rest —
      // so parse stdout whatever the exit status.
      (_error, stdout) => resolve(parseLsofCwd(typeof stdout === 'string' ? stdout : '')),
    );
  });
}

async function procCwds(pids: number[]): Promise<Map<number, string>> {
  const byPid = new Map<number, string>();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const cwd = normalizeProcCwd(await readlink(`/proc/${pid}/cwd`));
        if (cwd) byPid.set(pid, cwd);
      } catch {
        // Gone, or not ours to read — no value, the pane keeps what it has.
      }
    }),
  );
  return byPid;
}

/** pid → cwd for the given shell pids. Never rejects; unknown pids are absent. */
export function readShellCwds(
  pids: number[],
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, string>> {
  const valid = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (valid.length === 0) return Promise.resolve(new Map());
  if (platform === 'darwin') return lsofCwds(valid);
  if (platform === 'linux') return procCwds(valid);
  return Promise.resolve(new Map());
}

export interface CwdCandidate {
  id: string;
  pid: number;
  cwd?: string;
}

/** Sessions whose live cwd differs from the one last recorded for them. */
export function changedCwds(
  sessions: CwdCandidate[],
  byPid: Map<number, string>,
): Array<{ id: string; cwd: string }> {
  const out: Array<{ id: string; cwd: string }> = [];
  for (const s of sessions) {
    const live = byPid.get(s.pid);
    if (live && live !== s.cwd) out.push({ id: s.id, cwd: live });
  }
  return out;
}

/**
 * The folder to start a shell in: the first candidate that still exists, else
 * home. A restored pane's cwd can be a folder deleted since (a temp checkout, a
 * removed worktree) — spawning there would fail the whole terminal.
 */
export function pickSpawnCwd(
  candidates: Array<string | undefined>,
  home: string,
  exists: (p: string) => boolean,
): string {
  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  return home;
}
