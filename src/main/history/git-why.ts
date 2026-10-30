import path from 'node:path';
import { runGit } from '../git-manager';

// ─── Workspace history: "why is this file / line like this?" ─────────────────
// Links code to the sessions that wrote it: git says WHEN a line or file last
// changed, the index says WHICH sessions edited that file and when, and the
// edits that happened between the previous commit and this one are the
// conversation that produced the change. Timestamps are the join key, so this
// is a strong hint, not proof — an edit made, reverted and redone in another
// session still lands on the commit that shipped it.

/** Edits shortly after the commit time still belong to it (clock skew, amend). */
export const WHY_GRACE_MS = 10 * 60_000;
/** Commits examined for a whole-file `why`. */
export const WHY_MAX_COMMITS = 5;
/** Session edits reported per commit. */
export const WHY_EDITS_PER_COMMIT = 3;

export interface WhyCommit {
  sha: string;
  /** Author time, ms since epoch: when the change was made, which survives rebases better than commit time. */
  ts: number;
  subject: string;
  author: string;
  /** The line is not committed yet (blame reports the zero sha). */
  uncommitted?: boolean;
}

export interface FileEdit {
  sessionId: string;
  chunkId: string;
  ts: number;
  title?: string;
  snippet: string;
}

export interface WhyEntry {
  commit: WhyCommit;
  edits: FileEdit[];
}

export interface FileCommits {
  /** Newest first. */
  commits: WhyCommit[];
  /**
   * Time of the file's commit just older than the oldest one in `commits`, or
   * null when that oldest commit is the file's first: edits after it belong to
   * the oldest commit, and with no older commit every earlier edit does. Work
   * often sits uncommitted for days, so a fixed look-back window misses it.
   */
  olderTs: number | null;
}

const ZERO_SHA = /^0{40}$/;

/** First commit block of `git blame --porcelain -L n,n`. */
export function parseBlamePorcelain(out: string): WhyCommit | null {
  const lines = out.split('\n');
  const head = /^([0-9a-f]{40}) \d+ \d+/.exec(lines[0] ?? '');
  if (!head) return null;
  const field = (name: string) => {
    const l = lines.find((x) => x.startsWith(`${name} `));
    return l ? l.slice(name.length + 1) : '';
  };
  const sha = head[1];
  const uncommitted = ZERO_SHA.test(sha);
  return {
    sha,
    ts: Number(field('author-time')) * 1000 || 0,
    subject: uncommitted ? '(not committed yet)' : field('summary'),
    author: field('author'),
    ...(uncommitted ? { uncommitted: true } : {}),
  };
}

/** `git log --format=%H%x1f%at%x1f%an%x1f%s`, newest first. */
export function parseLog(out: string): WhyCommit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\x1f'))
    .filter((p) => p.length >= 4 && /^[0-9a-f]{40}$/.test(p[0]))
    .map(([sha, at, author, ...subject]) => ({ sha, ts: Number(at) * 1000, author, subject: subject.join('\x1f') }));
}

async function lastCommitTs(cwd: string, rev: string, name: string): Promise<number | null> {
  const r = await runGit(cwd, ['--literal-pathspecs', 'log', '-n1', '--format=%at', rev, '--', name]);
  const t = r.ok ? Number(r.stdout.trim()) : NaN;
  return Number.isFinite(t) && t > 0 ? t * 1000 : null;
}

/**
 * The commits that explain `file` (absolute path): the one that last touched
 * `line` when given, else the file's last few commits, plus the time bound
 * below them (see FileCommits). Git runs from the file's directory so no repo
 * root needs resolving; a file outside a repo (or a git failure) yields no
 * commits rather than an error.
 */
export async function commitsForFile(file: string, line?: number): Promise<FileCommits> {
  const cwd = path.dirname(file);
  const name = path.basename(file);
  if (line !== undefined) {
    const r = await runGit(cwd, ['--literal-pathspecs', 'blame', '--porcelain', '-L', `${line},${line}`, '--', name]);
    const c = r.ok ? parseBlamePorcelain(r.stdout) : null;
    if (!c) return { commits: [], olderTs: null };
    // Uncommitted: the work since the file's last commit. Committed: the work
    // since the file's previous commit before the blamed one.
    const olderTs = await lastCommitTs(cwd, c.uncommitted ? 'HEAD' : `${c.sha}^`, name);
    return { commits: [c], olderTs };
  }
  // One extra commit only to learn the bound below the ones we report.
  const r = await runGit(cwd, [
    '--literal-pathspecs', 'log', `-n${WHY_MAX_COMMITS + 1}`, '--follow', '--format=%H%x1f%at%x1f%an%x1f%s', '--', name,
  ]);
  const all = r.ok ? parseLog(r.stdout) : [];
  return { commits: all.slice(0, WHY_MAX_COMMITS), olderTs: all[WHY_MAX_COMMITS]?.ts ?? null };
}

/**
 * Attribute session edits of the file to commits (newest first): an edit
 * belongs to the newest commit it precedes (plus a small grace), as long as it
 * is newer than the next-older commit, i.e. the work between two commits
 * explains the later one. Below the oldest reported commit the bound is
 * `olderTs` (none for a file's first commit). An uncommitted line is explained
 * by the edits since the file's last commit.
 *
 * Edit times are turn START times (a chunk is one turn), so an edit late in a
 * turn that began before the previous commit is attributed to that older one.
 * Rare, and the session still shows up for the older commit.
 */
export function matchEditsToCommits(
  { commits, olderTs }: FileCommits,
  edits: FileEdit[],
  now = Date.now(),
): WhyEntry[] {
  return commits.map((commit, i) => {
    const older = commits[i + 1]?.ts ?? olderTs;
    const upper = (commit.uncommitted ? now : commit.ts) + WHY_GRACE_MS;
    const lower = older === null ? -Infinity : older + WHY_GRACE_MS;
    const inWindow = edits
      .filter((e) => e.ts > lower && e.ts <= upper)
      // Nearest to the commit first: the last edit before shipping is the most telling.
      .sort((a, b) => b.ts - a.ts);
    // One entry per session, so a long session doesn't crowd out the others.
    const seen = new Set<string>();
    const picked: FileEdit[] = [];
    for (const e of inWindow) {
      if (seen.has(e.sessionId)) continue;
      seen.add(e.sessionId);
      picked.push(e);
      if (picked.length >= WHY_EDITS_PER_COMMIT) break;
    }
    return { commit, edits: picked };
  });
}
