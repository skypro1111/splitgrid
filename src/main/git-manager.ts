// Git access for the repository pane.
//
// Everything goes through the real `git` binary — not a JS reimplementation —
// so worktrees, submodules, alternates, hooks and the user's own git config all
// behave exactly as they do in their terminal. Output is asked for in
// machine-readable form and parsed by the pure functions in git-porcelain.ts.

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import type {
  GitCommandResult,
  GitCommitDetail,
  GitDiffSides,
  GitDiffSource,
  GitLogOptions,
  GitLogPage,
  GitRemote,
  GitRepoInfo,
  GitStashEntry,
  GitStatus,
  GitWorktree,
} from '../shared/git-types';
import {
  LOG_FORMAT,
  REF_FORMAT,
  STASH_FORMAT,
  parseLog,
  parseRawNumstat,
  parseRefs,
  parseRemotes,
  parseStashList,
  parseStatus,
  parseWorktrees,
  type ParsedRefs,
} from './git-porcelain';

/** A single blob side larger than this is not worth loading into an editor. */
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
/** Enough headroom for `git log` over a large repository. */
const MAX_BUFFER = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30_000;
/** Fetch/pull/push talk to a server, so they get a much longer leash. */
const NETWORK_TIMEOUT = 180_000;

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Never block on a credential prompt we have no terminal to answer.
    GIT_TERMINAL_PROMPT: '0',
    // Reading state must not fight the user's own git for the index lock.
    GIT_OPTIONAL_LOCKS: '0',
    // Keep any human-facing text git slips out predictable.
    LC_ALL: 'C',
    // Pagers and editors would hang a non-interactive child.
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

/** Runs git and resolves even on failure — callers decide what a non-zero code means. */
export function runGit(
  cwd: string,
  args: string[],
  options: { timeout?: number; encoding?: 'utf8' } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: gitEnv(),
        maxBuffer: MAX_BUFFER,
        timeout: options.timeout ?? DEFAULT_TIMEOUT,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : error
            ? 1
            : 0;
        resolve({
          ok: !error,
          code,
          stdout: stdout ?? '',
          stderr: stderr || (error ? error.message : ''),
        });
      }
    );
  });
}

/** Same, but keeps the bytes — blobs may be binary or non-UTF8. */
function runGitBuffer(cwd: string, args: string[]): Promise<{ ok: boolean; buffer: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env: gitEnv(), maxBuffer: MAX_BUFFER, timeout: DEFAULT_TIMEOUT, windowsHide: true, encoding: 'buffer' },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          buffer: Buffer.isBuffer(stdout) ? stdout : Buffer.from(''),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
        });
      }
    );
  });
}

/** Fails fast on a ref/path that git would read as an option. */
function assertNotOption(value: string, what: string): void {
  if (value.startsWith('-')) throw new Error(`Invalid ${what}: ${value}`);
}

function toResult(run: RunResult): GitCommandResult {
  return { ok: run.ok, stdout: run.stdout, stderr: run.stderr };
}

// ── Repository discovery ─────────────────────────────────────────────────────

/** Resolves the repository containing `dir`, or null when there is none. */
export async function detectRepo(dir: string): Promise<GitRepoInfo | null> {
  const probe = await runGit(dir, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-dir',
    '--git-common-dir',
  ]);
  if (!probe.ok) return null;

  const [root, gitDir, commonDir] = probe.stdout.split('\n').map((l) => l.trim());
  if (!root) return null;

  const [branchRun, headRun] = await Promise.all([
    runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGit(root, ['rev-parse', 'HEAD']),
  ]);

  const branch = branchRun.ok ? branchRun.stdout.trim() : null;
  return {
    root,
    gitDir: gitDir || path.join(root, '.git'),
    commonDir: commonDir || gitDir || path.join(root, '.git'),
    branch: branch || null,
    // An unborn branch (fresh `git init`) has a name but no commit yet.
    head: headRun.ok ? headRun.stdout.trim() : null,
    detached: !branch,
    operation: await detectOperation(gitDir || path.join(root, '.git')),
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function detectOperation(gitDir: string): Promise<GitRepoInfo['operation']> {
  if (await exists(path.join(gitDir, 'rebase-merge'))) return 'rebase';
  if (await exists(path.join(gitDir, 'rebase-apply'))) return 'rebase';
  if (await exists(path.join(gitDir, 'MERGE_HEAD'))) return 'merge';
  if (await exists(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (await exists(path.join(gitDir, 'REVERT_HEAD'))) return 'revert';
  if (await exists(path.join(gitDir, 'BISECT_LOG'))) return 'bisect';
  return null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getRemotes(repo: string): Promise<GitRemote[]> {
  const run = await runGit(repo, ['remote', '-v']);
  return run.ok ? parseRemotes(run.stdout) : [];
}

export async function getLog(repo: string, options: GitLogOptions = {}): Promise<GitLogPage> {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 20_000));
  const args = ['log', '--date-order', `--format=${LOG_FORMAT}`, `--max-count=${limit + 1}`];

  if (options.skip) args.push(`--skip=${Math.max(0, Math.floor(options.skip))}`);
  if (options.search) args.push('--grep', options.search, '--regexp-ignore-case');
  if (options.author) args.push('--author', options.author);

  if (options.all !== false && !options.refs?.length) {
    // Every branch tip and tag; without this the log is only HEAD's ancestry and
    // the graph shows no branching at all.
    args.push('--all');
  } else if (options.refs?.length) {
    for (const ref of options.refs) {
      assertNotOption(ref, 'revision');
      args.push(ref);
    }
  }

  if (options.path) {
    assertNotOption(options.path, 'path');
    args.push('--', options.path);
  }

  const run = await runGit(repo, args);
  // An unborn HEAD is not an error worth surfacing — the repo simply has no log.
  if (!run.ok) {
    if (/does not have any commits yet|unknown revision/i.test(run.stderr)) {
      return { commits: [], hasMore: false };
    }
    throw new Error(run.stderr.trim() || 'git log failed');
  }

  const remotes = (await getRemotes(repo)).map((r) => r.name);
  const commits = parseLog(run.stdout, remotes);
  const hasMore = commits.length > limit;
  return { commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
}

export async function getRefs(repo: string): Promise<ParsedRefs> {
  const run = await runGit(repo, [
    'for-each-ref',
    `--format=${REF_FORMAT}`,
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  if (!run.ok) return { branches: [], tags: [] };
  return parseRefs(run.stdout);
}

export async function getWorktrees(repo: string): Promise<GitWorktree[]> {
  // `worktree list` prints resolved absolute paths, so "which one am I in?" has
  // to be answered against this worktree's own root — the caller may have handed
  // us a subdirectory, or a path that walks a symlink (/var vs /private/var).
  const [run, rootRun] = await Promise.all([
    runGit(repo, ['worktree', 'list', '--porcelain']),
    runGit(repo, ['rev-parse', '--path-format=absolute', '--show-toplevel']),
  ]);
  if (!run.ok) return [];
  return parseWorktrees(run.stdout, rootRun.ok ? rootRun.stdout.trim() : repo);
}

export async function getStatus(repo: string): Promise<GitStatus> {
  const run = await runGit(repo, [
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=all',
    '-z',
  ]);
  if (!run.ok) throw new Error(run.stderr.trim() || 'git status failed');
  return parseStatus(run.stdout);
}

export async function getStashes(repo: string): Promise<GitStashEntry[]> {
  const run = await runGit(repo, ['stash', 'list', `--format=${STASH_FORMAT}`]);
  return run.ok ? parseStashList(run.stdout) : [];
}

export async function getCommitDetail(repo: string, sha: string): Promise<GitCommitDetail> {
  assertNotOption(sha, 'revision');

  const [metaRun, filesRun] = await Promise.all([
    runGit(repo, ['log', '-1', `--format=${LOG_FORMAT}`, sha]),
    // `-m --first-parent` makes a merge show the diff against its first parent
    // instead of git's default of showing nothing at all.
    runGit(repo, ['show', '--format=', '--raw', '--numstat', '-z', '-M', '-m', '--first-parent', sha]),
  ]);
  if (!metaRun.ok) throw new Error(metaRun.stderr.trim() || `unknown revision ${sha}`);

  const remotes = (await getRemotes(repo)).map((r) => r.name);
  const [commit] = parseLog(metaRun.stdout, remotes);
  if (!commit) throw new Error(`unknown revision ${sha}`);

  return { commit, files: filesRun.ok ? parseRawNumstat(filesRun.stdout) : [] };
}

/** Files changed in the working tree relative to the index, or index to HEAD. */
export async function getWorkingChanges(repo: string, staged: boolean): Promise<GitCommitDetail['files']> {
  const args = ['diff', '--raw', '--numstat', '-z', '-M'];
  if (staged) args.push('--cached');
  const run = await runGit(repo, args);
  return run.ok ? parseRawNumstat(run.stdout) : [];
}

// ── Diffs ────────────────────────────────────────────────────────────────────

function decodeBlob(buffer: Buffer): { text: string; binary: boolean; tooLarge: boolean } {
  if (buffer.length > MAX_BLOB_BYTES) return { text: '', binary: false, tooLarge: true };
  // git's own heuristic: a NUL byte near the start means binary.
  const probe = buffer.subarray(0, Math.min(buffer.length, 8000));
  if (probe.includes(0)) return { text: '', binary: true, tooLarge: false };
  return { text: buffer.toString('utf8'), binary: false, tooLarge: false };
}

/**
 * Reads one object (`rev:path` or `:path`), treating "not there" (added/deleted)
 * as empty. The size is asked first: a blob past MAX_BUFFER would otherwise fail
 * the read and come back empty — indistinguishable from a deleted file.
 */
async function readObject(repo: string, spec: string): Promise<{ text: string; binary: boolean; tooLarge: boolean }> {
  const size = await runGit(repo, ['cat-file', '-s', spec]);
  if (!size.ok) return { text: '', binary: false, tooLarge: false };
  if (Number(size.stdout.trim()) > MAX_BLOB_BYTES) return { text: '', binary: false, tooLarge: true };
  const run = await runGitBuffer(repo, ['show', spec]);
  if (!run.ok) return { text: '', binary: false, tooLarge: false };
  return decodeBlob(run.buffer);
}

function readBlob(repo: string, rev: string, file: string): Promise<{ text: string; binary: boolean; tooLarge: boolean }> {
  return readObject(repo, `${rev}:${file}`);
}

async function readWorktreeFile(repo: string, file: string): Promise<{ text: string; binary: boolean; tooLarge: boolean }> {
  try {
    const buffer = await fs.readFile(path.resolve(repo, file));
    return decodeBlob(buffer);
  } catch {
    return { text: '', binary: false, tooLarge: false };
  }
}

/**
 * Both sides of one file's diff, ready for a Monaco diff editor.
 *
 * A missing blob comes back as an empty side, which is exactly how an added or
 * deleted file should render — no need for the caller to know the status first.
 */
export async function getDiff(
  repo: string,
  source: GitDiffSource,
  file: string,
  origFile?: string | null
): Promise<GitDiffSides> {
  assertNotOption(file, 'path');
  const before = origFile || file;

  let original: { text: string; binary: boolean; tooLarge: boolean };
  let modified: { text: string; binary: boolean; tooLarge: boolean };
  let originalPath: string | null = before;
  const modifiedPath: string | null = file;

  switch (source.kind) {
    case 'commit': {
      assertNotOption(source.sha, 'revision');
      [original, modified] = await Promise.all([
        readBlob(repo, `${source.sha}^`, before),
        readBlob(repo, source.sha, file),
      ]);
      break;
    }
    case 'staged': {
      // HEAD vs the index — `:path` addresses the staged copy.
      [original, modified] = await Promise.all([
        readBlob(repo, 'HEAD', before),
        readIndexBlob(repo, file),
      ]);
      break;
    }
    case 'unstaged': {
      [original, modified] = await Promise.all([
        readIndexBlob(repo, before),
        readWorktreeFile(repo, file),
      ]);
      originalPath = before;
      break;
    }
    case 'stash': {
      assertNotOption(source.ref, 'revision');
      [original, modified] = await Promise.all([
        readBlob(repo, `${source.ref}^`, before),
        readBlob(repo, source.ref, file),
      ]);
      break;
    }
    default:
      original = { text: '', binary: false, tooLarge: false };
      modified = { text: '', binary: false, tooLarge: false };
  }

  return {
    original: original.text,
    modified: modified.text,
    originalPath,
    modifiedPath,
    binary: original.binary || modified.binary,
    tooLarge: original.tooLarge || modified.tooLarge,
  };
}

function readIndexBlob(repo: string, file: string): Promise<{ text: string; binary: boolean; tooLarge: boolean }> {
  return readObject(repo, `:${file}`);
}

/** The unified patch for one file, for the "view as patch" toggle. */
export async function getPatch(repo: string, source: GitDiffSource, file: string): Promise<string> {
  assertNotOption(file, 'path');
  const args = ['diff'];
  switch (source.kind) {
    case 'commit':
      assertNotOption(source.sha, 'revision');
      return (await runGit(repo, ['show', '--format=', '-M', '-m', '--first-parent', source.sha, '--', file])).stdout;
    case 'staged':
      args.push('--cached');
      break;
    case 'stash':
      assertNotOption(source.ref, 'revision');
      return (await runGit(repo, ['stash', 'show', '-p', source.ref, '--', file])).stdout;
    default:
      break;
  }
  args.push('-M', '--', file);
  return (await runGit(repo, args)).stdout;
}

// ── Working copy ─────────────────────────────────────────────────────────────

/** Stays well under Windows' 32K command-line limit, with room for the rest. */
const MAX_PATH_ARGS_CHARS = 16_000;

/**
 * Runs `args -- <paths>` over exact file paths, split across as many calls as the
 * command line needs ("Stage all" can hand over thousands of untracked files).
 *
 * `--literal-pathspecs` because these are paths from `git status`, not patterns:
 * left as globs, discarding `app/[id]/page.tsx` would also discard `app/i/page.tsx`.
 */
async function runOnPaths(repo: string, args: string[], paths: string[]): Promise<RunResult> {
  let last: RunResult = { ok: true, code: 0, stdout: '', stderr: '' };
  for (let i = 0; i < paths.length; ) {
    const chunk: string[] = [];
    let chars = 0;
    while (i < paths.length && (chunk.length === 0 || chars + paths[i].length + 3 <= MAX_PATH_ARGS_CHARS)) {
      chars += paths[i].length + 3;
      chunk.push(paths[i++]);
    }
    last = await runGit(repo, ['--literal-pathspecs', ...args, '--', ...chunk]);
    if (!last.ok) return last;
  }
  return last;
}

export async function stage(repo: string, paths: string[]): Promise<GitCommandResult> {
  if (!paths.length) return { ok: true, stdout: '', stderr: '' };
  return toResult(await runOnPaths(repo, ['add'], paths));
}

export async function unstage(repo: string, paths: string[]): Promise<GitCommandResult> {
  if (!paths.length) return { ok: true, stdout: '', stderr: '' };
  // `restore --staged` needs a commit to restore from; a repo with no commits
  // yet can only be unstaged with `rm --cached`.
  const head = await runGit(repo, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) return toResult(await runOnPaths(repo, ['rm', '--cached', '-r'], paths));
  return toResult(await runOnPaths(repo, ['restore', '--staged'], paths));
}

/**
 * Throws away uncommitted work: tracked files go back to the index, untracked
 * ones are deleted. Destructive and unrecoverable — the pane confirms first.
 */
export async function discard(repo: string, paths: string[], untracked: string[] = []): Promise<GitCommandResult> {
  const results: RunResult[] = [];
  if (paths.length) results.push(await runOnPaths(repo, ['restore', '--worktree'], paths));
  if (untracked.length) results.push(await runOnPaths(repo, ['clean', '-fd'], untracked));
  const failed = results.find((r) => !r.ok);
  return failed ? toResult(failed) : { ok: true, stdout: '', stderr: '' };
}

export async function commit(
  repo: string,
  message: string,
  options: { amend?: boolean; signoff?: boolean; noVerify?: boolean } = {}
): Promise<GitCommandResult> {
  if (!message.trim() && !options.amend) {
    return { ok: false, stdout: '', stderr: 'Empty commit message' };
  }
  const args = ['commit', '-m', message];
  if (options.amend) args.push('--amend');
  if (options.signoff) args.push('--signoff');
  if (options.noVerify) args.push('--no-verify');
  return toResult(await runGit(repo, args, { timeout: NETWORK_TIMEOUT }));
}

export async function stashPush(
  repo: string,
  options: { message?: string; includeUntracked?: boolean; keepIndex?: boolean } = {}
): Promise<GitCommandResult> {
  const args = ['stash', 'push'];
  if (options.includeUntracked) args.push('--include-untracked');
  if (options.keepIndex) args.push('--keep-index');
  if (options.message) args.push('-m', options.message);
  return toResult(await runGit(repo, args));
}

export async function stashAction(
  repo: string,
  action: 'apply' | 'pop' | 'drop',
  ref: string
): Promise<GitCommandResult> {
  assertNotOption(ref, 'stash ref');
  return toResult(await runGit(repo, ['stash', action, ref]));
}

// ── Refs ─────────────────────────────────────────────────────────────────────

export async function checkout(
  repo: string,
  ref: string,
  options: { newBranch?: string; force?: boolean } = {}
): Promise<GitCommandResult> {
  assertNotOption(ref, 'revision');
  const args = ['checkout'];
  if (options.force) args.push('--force');
  if (options.newBranch) {
    assertNotOption(options.newBranch, 'branch name');
    args.push('-b', options.newBranch);
  }
  args.push(ref);
  return toResult(await runGit(repo, args, { timeout: NETWORK_TIMEOUT }));
}

export async function createBranch(
  repo: string,
  name: string,
  startPoint?: string,
  checkoutAfter = false
): Promise<GitCommandResult> {
  assertNotOption(name, 'branch name');
  if (startPoint) assertNotOption(startPoint, 'revision');
  if (checkoutAfter) return checkout(repo, startPoint ?? 'HEAD', { newBranch: name });
  const args = ['branch', name];
  if (startPoint) args.push(startPoint);
  return toResult(await runGit(repo, args));
}

export async function deleteBranch(
  repo: string,
  name: string,
  options: { force?: boolean; remote?: string } = {}
): Promise<GitCommandResult> {
  assertNotOption(name, 'branch name');
  if (options.remote) {
    assertNotOption(options.remote, 'remote');
    return toResult(
      await runGit(repo, ['push', options.remote, '--delete', name], { timeout: NETWORK_TIMEOUT })
    );
  }
  return toResult(await runGit(repo, ['branch', options.force ? '-D' : '-d', name]));
}

export async function renameBranch(repo: string, from: string, to: string): Promise<GitCommandResult> {
  assertNotOption(from, 'branch name');
  assertNotOption(to, 'branch name');
  return toResult(await runGit(repo, ['branch', '-m', from, to]));
}

export async function mergeRef(
  repo: string,
  ref: string,
  options: { noFf?: boolean; squash?: boolean; message?: string } = {}
): Promise<GitCommandResult> {
  assertNotOption(ref, 'revision');
  const args = ['merge'];
  if (options.noFf) args.push('--no-ff');
  if (options.squash) args.push('--squash');
  if (options.message) args.push('-m', options.message);
  args.push(ref);
  return toResult(await runGit(repo, args, { timeout: NETWORK_TIMEOUT }));
}

export async function abortOperation(
  repo: string,
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert'
): Promise<GitCommandResult> {
  return toResult(await runGit(repo, [operation, '--abort']));
}

export async function createTag(
  repo: string,
  name: string,
  ref: string,
  message?: string
): Promise<GitCommandResult> {
  assertNotOption(name, 'tag name');
  assertNotOption(ref, 'revision');
  const args = ['tag'];
  if (message) args.push('-a', '-m', message);
  args.push(name, ref);
  return toResult(await runGit(repo, args));
}

export async function deleteTag(repo: string, name: string, remote?: string): Promise<GitCommandResult> {
  assertNotOption(name, 'tag name');
  if (remote) {
    assertNotOption(remote, 'remote');
    return toResult(
      await runGit(repo, ['push', remote, '--delete', `refs/tags/${name}`], { timeout: NETWORK_TIMEOUT })
    );
  }
  return toResult(await runGit(repo, ['tag', '-d', name]));
}

export async function resetTo(
  repo: string,
  ref: string,
  mode: 'soft' | 'mixed' | 'hard'
): Promise<GitCommandResult> {
  assertNotOption(ref, 'revision');
  return toResult(await runGit(repo, ['reset', `--${mode}`, ref]));
}

export async function revertCommit(repo: string, sha: string): Promise<GitCommandResult> {
  assertNotOption(sha, 'revision');
  return toResult(await runGit(repo, ['revert', '--no-edit', sha]));
}

export async function cherryPick(repo: string, sha: string): Promise<GitCommandResult> {
  assertNotOption(sha, 'revision');
  return toResult(await runGit(repo, ['cherry-pick', sha]));
}

// ── Remotes ──────────────────────────────────────────────────────────────────

export async function fetch(
  repo: string,
  options: { remote?: string; all?: boolean; prune?: boolean } = {}
): Promise<GitCommandResult> {
  const args = ['fetch'];
  if (options.all || !options.remote) args.push('--all');
  else {
    assertNotOption(options.remote, 'remote');
    args.push(options.remote);
  }
  if (options.prune) args.push('--prune');
  args.push('--tags');
  return toResult(await runGit(repo, args, { timeout: NETWORK_TIMEOUT }));
}

export async function pull(repo: string, options: { rebase?: boolean } = {}): Promise<GitCommandResult> {
  const args = ['pull'];
  if (options.rebase) args.push('--rebase');
  return toResult(await runGit(repo, args, { timeout: NETWORK_TIMEOUT }));
}

export async function push(
  repo: string,
  options: { remote?: string; branch?: string; setUpstream?: boolean; force?: boolean; tags?: boolean } = {}
): Promise<GitCommandResult> {
  const args = ['push'];
  // Only ever the safe force — it refuses when the remote moved under us.
  if (options.force) args.push('--force-with-lease');
  if (options.setUpstream) args.push('--set-upstream');
  if (options.tags) args.push('--tags');
  if (options.remote) {
    assertNotOption(options.remote, 'remote');
    args.push(options.remote);
    if (options.branch) {
      assertNotOption(options.branch, 'branch name');
      args.push(options.branch);
    }
  }
  return toResult(await runGit(repo, args, { timeout: NETWORK_TIMEOUT }));
}

// ── Worktrees ────────────────────────────────────────────────────────────────

export async function worktreeAdd(
  repo: string,
  targetPath: string,
  options: { ref?: string; newBranch?: string; detach?: boolean } = {}
): Promise<GitCommandResult> {
  assertNotOption(targetPath, 'path');
  const args = ['worktree', 'add'];
  if (options.newBranch) {
    assertNotOption(options.newBranch, 'branch name');
    args.push('-b', options.newBranch);
  }
  if (options.detach) args.push('--detach');
  args.push(targetPath);
  if (options.ref) {
    assertNotOption(options.ref, 'revision');
    args.push(options.ref);
  }
  return toResult(await runGit(repo, args, { timeout: NETWORK_TIMEOUT }));
}

export async function worktreeRemove(repo: string, targetPath: string, force = false): Promise<GitCommandResult> {
  assertNotOption(targetPath, 'path');
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(targetPath);
  return toResult(await runGit(repo, args));
}

export async function worktreePrune(repo: string): Promise<GitCommandResult> {
  return toResult(await runGit(repo, ['worktree', 'prune']));
}

export async function worktreeLock(repo: string, targetPath: string, lock: boolean): Promise<GitCommandResult> {
  assertNotOption(targetPath, 'path');
  return toResult(await runGit(repo, ['worktree', lock ? 'lock' : 'unlock', targetPath]));
}

// ── Ref watching ─────────────────────────────────────────────────────────────

/**
 * Watches the git directory so the pane refreshes when refs, HEAD or the index
 * move — including from the user's own terminal in the next pane over.
 *
 * Only the .git metadata is watched, never the worktree: walking a large
 * checkout for every keystroke of a build would cost far more than it is worth.
 * Working-copy status is refreshed on window focus and after the pane's own
 * commands instead.
 */
export class GitWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly info: GitRepoInfo,
    private readonly onChange: () => void,
    private readonly debounceMs = 300
  ) {}

  start(): void {
    if (this.watcher) return;
    const { gitDir, commonDir } = this.info;
    const targets = [
      path.join(gitDir, 'HEAD'),
      path.join(gitDir, 'index'),
      path.join(commonDir, 'refs'),
      path.join(commonDir, 'packed-refs'),
      path.join(commonDir, 'MERGE_HEAD'),
      path.join(commonDir, 'worktrees'),
    ];
    this.watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      depth: 3,
      // The index is rewritten in bursts; let it settle before re-reading.
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const fire = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.onChange(), this.debounceMs);
    };
    this.watcher.on('all', fire);
    this.watcher.on('error', () => { /* a vanished .git dir is not worth crashing over */ });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.watcher?.close();
    this.watcher = null;
  }
}
