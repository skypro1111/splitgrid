// Parsers for git's machine-readable output.
//
// Every format here is one git promises not to break (`--porcelain=v2`, `-z`
// raw/numstat, `for-each-ref --format`, `worktree list --porcelain`), so the pane
// never scrapes human-facing text. Pure functions, no spawning — git-manager.ts
// owns the process side and hands the bytes here.

import type {
  GitBranch,
  GitCommit,
  GitFileChange,
  GitFileStatus,
  GitRefLabel,
  GitStashEntry,
  GitStatus,
  GitStatusFile,
  GitTag,
  GitWorktree,
} from '../shared/git-types';

const NUL = '\0';
/** Record separator for the log/stash formats — NUL already separates fields. */
const RS = '\x01';

/**
 * `git log --format=...` layout: %x01 starts each record, %x00 separates fields.
 * Body comes last because it is the only field that may contain newlines.
 */
export const LOG_FORMAT =
  '%x01%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%D%x00%s%x00%b';

/** Splits `[ahead 2, behind 1]` (or `[gone]`) into counts. */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: track.includes('gone'),
  };
}

/**
 * Turns a `%D` decoration string into ref labels.
 *
 * `remotes` makes `origin/feature/x` resolve as a remote branch rather than a
 * local branch that happens to contain a slash; without it we fall back to
 * "has a slash" only when nothing else matches.
 */
export function parseDecorations(decorations: string, remotes: string[] = []): GitRefLabel[] {
  const out: GitRefLabel[] = [];
  for (const raw of decorations.split(',')) {
    const item = raw.trim();
    if (!item) continue;

    if (item.startsWith('tag: ')) {
      out.push({ name: item.slice(5), kind: 'tag' });
      continue;
    }
    const headArrow = /^HEAD -> (.+)$/.exec(item);
    if (headArrow) {
      out.push({ name: headArrow[1], kind: 'branch', isHead: true });
      continue;
    }
    if (item === 'HEAD') {
      out.push({ name: 'HEAD', kind: 'head', isHead: true });
      continue;
    }
    if (item === 'refs/stash') {
      out.push({ name: 'stash', kind: 'stash' });
      continue;
    }
    const isRemote = remotes.length
      ? remotes.some((r) => item === r || item.startsWith(`${r}/`))
      : item.includes('/');
    out.push({ name: item, kind: isRemote ? 'remote' : 'branch' });
  }
  return out;
}

/** Parses `git log --format=LOG_FORMAT` output. */
export function parseLog(stdout: string, remotes: string[] = []): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of stdout.split(RS)) {
    if (!record.trim()) continue;
    const f = record.split(NUL);
    if (f.length < 10) continue;
    commits.push({
      sha: f[0],
      parents: f[1] ? f[1].split(' ').filter(Boolean) : [],
      authorName: f[2],
      authorEmail: f[3],
      authorDate: Number(f[4]) || 0,
      committerName: f[5],
      committerDate: Number(f[6]) || 0,
      refs: parseDecorations(f[7], remotes),
      subject: f[8],
      // git appends a trailing newline after %b for every record.
      body: f.slice(9).join(NUL).replace(/\n+$/, ''),
    });
  }
  return commits;
}

/** Field order the `for-each-ref` call must use. */
export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(HEAD)',
  '%(worktreepath)',
  '%(creatordate:unix)',
  '%(contents:subject)',
].join('%00');

export interface ParsedRefs {
  branches: GitBranch[];
  tags: GitTag[];
}

export function parseRefs(stdout: string): ParsedRefs {
  const branches: GitBranch[] = [];
  const tags: GitTag[] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split(NUL);
    if (f.length < 8) continue;
    const [fullName, sha, upstream, track, head, worktreePath, date, subject] = f;

    if (fullName.startsWith('refs/tags/')) {
      tags.push({
        name: fullName.slice('refs/tags/'.length),
        fullName,
        sha,
        date: Number(date) || 0,
        subject,
      });
      continue;
    }

    const isRemote = fullName.startsWith('refs/remotes/');
    const name = isRemote
      ? fullName.slice('refs/remotes/'.length)
      : fullName.replace(/^refs\/heads\//, '');
    // `origin/HEAD` is a symbolic pointer, not a branch anyone checks out.
    if (isRemote && name.endsWith('/HEAD')) continue;

    const { ahead, behind } = parseTrack(track);
    branches.push({
      name,
      fullName,
      sha,
      isRemote,
      isHead: head === '*',
      upstream: upstream || null,
      ahead,
      behind,
      worktreePath: worktreePath || null,
      date: Number(date) || 0,
      subject,
    });
  }

  return { branches, tags };
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktrees(stdout: string, currentRoot?: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  let current: GitWorktree | null = null;

  const flush = () => {
    if (current) out.push(current);
    current = null;
  };

  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const sep = line.indexOf(' ');
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? '' : line.slice(sep + 1);

    switch (key) {
      case 'worktree':
        flush();
        current = {
          path: value,
          head: null,
          branch: null,
          bare: false,
          detached: false,
          locked: false,
          lockedReason: null,
          prunable: false,
          isMain: out.length === 0,
          isCurrent: false,
        };
        break;
      case 'HEAD':
        if (current) current.head = value;
        break;
      case 'branch':
        if (current) current.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'bare':
        if (current) current.bare = true;
        break;
      case 'detached':
        if (current) current.detached = true;
        break;
      case 'locked':
        if (current) {
          current.locked = true;
          current.lockedReason = value || null;
        }
        break;
      case 'prunable':
        if (current) current.prunable = true;
        break;
    }
  }
  flush();

  if (currentRoot) {
    for (const wt of out) wt.isCurrent = samePath(wt.path, currentRoot);
  }
  return out;
}

/** Path comparison that tolerates trailing slashes and Windows case/separators. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/** Parses `git status --porcelain=v2 --branch --untracked-files=all -z`. */
export function parseStatus(stdout: string): GitStatus {
  const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const tokens = stdout.split(NUL).filter((t) => t.length > 0);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.startsWith('# ')) {
      const [, key, ...rest] = token.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') status.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }

    if (token.startsWith('1 ') || token.startsWith('2 ')) {
      const renamed = token.startsWith('2 ');
      const parts = token.split(' ');
      const xy = parts[1];
      // Fields 2..7 are fixed-width metadata; the path is everything after them
      // (9 fields for `1`, 10 for `2` — the extra one is the rename score).
      const pathFrom = renamed ? 9 : 8;
      const path = parts.slice(pathFrom).join(' ');
      const origPath = renamed ? tokens[++i] ?? null : null;
      status.files.push(makeStatusFile(xy, path, origPath));
      continue;
    }

    if (token.startsWith('u ')) {
      const parts = token.split(' ');
      const xy = parts[1];
      const path = parts.slice(10).join(' ');
      const file = makeStatusFile(xy, path, null);
      file.conflicted = true;
      status.files.push(file);
      continue;
    }

    if (token.startsWith('? ')) {
      const file = makeStatusFile('??', token.slice(2), null);
      file.untracked = true;
      file.unstaged = true;
      status.files.push(file);
      continue;
    }

    if (token.startsWith('! ')) {
      const file = makeStatusFile('!!', token.slice(2), null);
      file.ignored = true;
      status.files.push(file);
      continue;
    }
  }

  return status;
}

function makeStatusFile(xy: string, path: string, origPath: string | null): GitStatusFile {
  const index = xy[0] ?? '.';
  const worktree = xy[1] ?? '.';
  return {
    path,
    origPath,
    index,
    worktree,
    staged: index !== '.' && index !== '?' && index !== '!',
    unstaged: worktree !== '.' && worktree !== '?' && worktree !== '!',
    untracked: false,
    ignored: false,
    conflicted: false,
  };
}

/**
 * Parses the combined `--raw --numstat -z` output of `git show`/`diff`.
 *
 * git emits every raw record first, then every numstat record, so this walks the
 * raw section (each `:<modes> <shas> <status>` followed by one path — two for a
 * rename or copy) and then folds the line counts in by path.
 */
export function parseRawNumstat(stdout: string): GitFileChange[] {
  const tokens = stdout.split(NUL).filter((t) => t.length > 0 || false);
  const files: GitFileChange[] = [];
  const byPath = new Map<string, GitFileChange>();

  let i = 0;
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith(':')) break;

    const statusField = token.slice(token.lastIndexOf(' ') + 1);
    const letter = statusField[0] as GitFileStatus;
    const score = statusField.length > 1 ? Number(statusField.slice(1)) : null;
    const isRenameOrCopy = letter === 'R' || letter === 'C';

    const first = tokens[++i] ?? '';
    const second = isRenameOrCopy ? tokens[++i] ?? '' : null;

    const change: GitFileChange = {
      path: second ?? first,
      origPath: second ? first : null,
      status: letter,
      score: Number.isFinite(score) ? score : null,
      additions: 0,
      deletions: 0,
      binary: false,
    };
    files.push(change);
    byPath.set(change.path, change);
  }

  // Numstat section: `<added>\t<deleted>\t<path>`, or for renames a trailing tab
  // followed by the old and new paths as separate NUL-delimited tokens.
  for (; i < tokens.length; i++) {
    const parts = tokens[i].split('\t');
    if (parts.length < 3) continue;
    const [added, deleted, inlinePath] = parts;
    let path = inlinePath;
    if (!path) {
      // Rename: skip the source token, the destination is the file's path.
      i++;
      path = tokens[++i] ?? '';
    }
    const change = byPath.get(path);
    if (!change) continue;
    change.binary = added === '-' || deleted === '-';
    change.additions = change.binary ? 0 : Number(added) || 0;
    change.deletions = change.binary ? 0 : Number(deleted) || 0;
  }

  return files;
}

/** Format for the stash listing; mirrors LOG_FORMAT's record separator. */
export const STASH_FORMAT = '%x01%gd%x00%H%x00%gs%x00%at';

export function parseStashList(stdout: string): GitStashEntry[] {
  const out: GitStashEntry[] = [];
  for (const record of stdout.split(RS)) {
    if (!record.trim()) continue;
    const [ref, sha, subject, date] = record.split(NUL);
    if (!ref) continue;
    const index = Number(/stash@\{(\d+)\}/.exec(ref)?.[1] ?? out.length);
    // `%gs` reads "WIP on main: 1234abc subject" or "On main: message".
    const on = /^(?:WIP on|On) ([^:]+): (.*)$/s.exec(subject ?? '');
    out.push({
      index,
      ref: `stash@{${index}}`,
      sha: sha ?? '',
      message: (on ? on[2] : subject ?? '').replace(/\n+$/, ''),
      branch: on ? on[1] : null,
      date: Number(date) || 0,
    });
  }
  return out;
}

/** Parses `git remote -v`, collapsing the fetch/push pair into one entry. */
export function parseRemotes(stdout: string): Array<{ name: string; fetchUrl: string; pushUrl: string }> {
  const map = new Map<string, { name: string; fetchUrl: string; pushUrl: string }>();
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\s+(.*?)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    const [, name, url, kind] = m;
    const entry = map.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
    map.set(name, entry);
  }
  return [...map.values()];
}
