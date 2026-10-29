// Exercises git-manager against a real repository built by the real `git`.
//
// The parsers have their own fixture tests; what this pins down is the half that
// fixtures cannot: that the arguments we hand git actually produce the output
// those parsers expect — merges included, which git shows nothing for unless
// asked exactly the right way.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import * as git from './git-manager';

let repo: string;
let worktreeDir: string;

const run = (args: string[], cwd = repo) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' },
  });

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'sg-git-'));
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@example.com']);
  run(['config', 'user.name', 'T']);
  run(['config', 'commit.gpgsign', 'false']);

  writeFileSync(path.join(repo, 'old.txt'), 'a\nb\nc\n');
  writeFileSync(path.join(repo, 'keep.txt'), 'keep\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'root']);
  run(['tag', 'v1.0.0']);

  run(['checkout', '-q', '-b', 'side']);
  writeFileSync(path.join(repo, 'side.txt'), 'side\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'side work']);

  run(['checkout', '-q', 'main']);
  run(['mv', 'old.txt', 'new.txt']);
  writeFileSync(path.join(repo, 'new.txt'), 'a\nb\nc\nd\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'rename and edit']);

  run(['merge', '-q', '--no-ff', 'side', '-m', 'merge side']);

  worktreeDir = path.join(repo, '..', path.basename(repo) + '-wt');
  run(['worktree', 'add', '-q', '-b', 'wt-branch', worktreeDir]);
}, 60_000);

afterAll(() => {
  for (const dir of [repo, worktreeDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('detectRepo', () => {
  it('resolves the root, HEAD and branch', async () => {
    const info = await git.detectRepo(repo);
    expect(info).not.toBeNull();
    expect(info!.branch).toBe('main');
    expect(info!.detached).toBe(false);
    expect(info!.head).toMatch(/^[0-9a-f]{40}$/);
    expect(info!.operation).toBeNull();
  });

  it('resolves a subdirectory to the same root', async () => {
    const sub = path.join(repo, 'nested', 'deeper');
    mkdirSync(sub, { recursive: true });
    const info = await git.detectRepo(sub);
    expect(info!.root).toBe((await git.detectRepo(repo))!.root);
  });

  it('returns null outside a repository', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'sg-plain-'));
    try {
      expect(await git.detectRepo(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('getLog', () => {
  it('returns commits newest-first with their parents and decorations', async () => {
    const page = await git.getLog(repo, { limit: 50 });
    const subjects = page.commits.map((c) => c.subject);
    expect(subjects[0]).toBe('merge side');
    expect(subjects).toContain('rename and edit');
    expect(subjects).toContain('root');

    const merge = page.commits[0];
    expect(merge.parents).toHaveLength(2);
    expect(merge.refs.some((r) => r.name === 'main' && r.isHead)).toBe(true);
    expect(merge.authorEmail).toBe('t@example.com');

    const root = page.commits.find((c) => c.subject === 'root')!;
    expect(root.parents).toEqual([]);
    expect(root.refs.some((r) => r.kind === 'tag' && r.name === 'v1.0.0')).toBe(true);
  });

  it('reports when more commits remain', async () => {
    const page = await git.getLog(repo, { limit: 1 });
    expect(page.commits).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('filters by message', async () => {
    const page = await git.getLog(repo, { limit: 50, search: 'side work' });
    expect(page.commits.map((c) => c.subject)).toEqual(['side work']);
  });
});

describe('getRefs / getWorktrees', () => {
  it('lists branches, the checked-out one, and tags', async () => {
    const { branches, tags } = await git.getRefs(repo);
    const main = branches.find((b) => b.name === 'main')!;
    expect(main.isHead).toBe(true);
    expect(branches.map((b) => b.name)).toEqual(expect.arrayContaining(['main', 'side', 'wt-branch']));
    expect(tags.map((t) => t.name)).toEqual(['v1.0.0']);
  });

  it('reports the branch checked out in a linked worktree', async () => {
    const { branches } = await git.getRefs(repo);
    expect(branches.find((b) => b.name === 'wt-branch')!.worktreePath).toBeTruthy();
  });

  it('lists the main worktree first and marks the current one', async () => {
    const trees = await git.getWorktrees(repo);
    expect(trees).toHaveLength(2);
    expect(trees[0].isMain).toBe(true);
    expect(trees[0].isCurrent).toBe(true);
    expect(trees[1].branch).toBe('wt-branch');
  });
});

describe('getCommitDetail', () => {
  it('reports a rename with its line counts', async () => {
    const sha = run(['rev-parse', 'HEAD^']).trim();
    const detail = await git.getCommitDetail(repo, sha);
    expect(detail.commit.subject).toBe('rename and edit');
    const renamed = detail.files.find((f) => f.path === 'new.txt')!;
    expect(renamed.status).toBe('R');
    expect(renamed.origPath).toBe('old.txt');
    expect(renamed.additions).toBe(1);
  });

  it('shows a merge against its first parent instead of nothing', async () => {
    const detail = await git.getCommitDetail(repo, 'HEAD');
    expect(detail.commit.parents).toHaveLength(2);
    expect(detail.files.map((f) => f.path)).toEqual(['side.txt']);
  });
});

describe('getDiff', () => {
  it('returns both sides of a file changed by a commit', async () => {
    const sha = run(['rev-parse', 'HEAD^']).trim();
    const diff = await git.getDiff(repo, { kind: 'commit', sha }, 'new.txt', 'old.txt');
    expect(diff.original).toBe('a\nb\nc\n');
    expect(diff.modified).toBe('a\nb\nc\nd\n');
    expect(diff.binary).toBe(false);
  });

  it('gives an added file an empty original side', async () => {
    const sha = run(['rev-parse', 'side']).trim();
    const diff = await git.getDiff(repo, { kind: 'commit', sha }, 'side.txt');
    expect(diff.original).toBe('');
    expect(diff.modified).toBe('side\n');
  });
});

describe('working copy', () => {
  it('stages, reports status, commits and unstages', async () => {
    writeFileSync(path.join(repo, 'keep.txt'), 'keep\nmore\n');
    writeFileSync(path.join(repo, 'fresh.txt'), 'new file\n');

    const dirty = await git.getStatus(repo);
    expect(dirty.branch).toBe('main');
    expect(dirty.files.find((f) => f.path === 'keep.txt')).toMatchObject({ unstaged: true, staged: false });
    expect(dirty.files.find((f) => f.path === 'fresh.txt')).toMatchObject({ untracked: true });

    expect((await git.stage(repo, ['keep.txt'])).ok).toBe(true);
    const staged = await git.getStatus(repo);
    expect(staged.files.find((f) => f.path === 'keep.txt')).toMatchObject({ staged: true });

    // The staged side diffs HEAD against the index.
    const diff = await git.getDiff(repo, { kind: 'staged' }, 'keep.txt');
    expect(diff.original).toBe('keep\n');
    expect(diff.modified).toBe('keep\nmore\n');

    expect((await git.unstage(repo, ['keep.txt'])).ok).toBe(true);
    expect((await git.getStatus(repo)).files.find((f) => f.path === 'keep.txt')!.staged).toBe(false);

    await git.stage(repo, ['keep.txt']);
    expect((await git.commit(repo, 'update keep')).ok).toBe(true);
    expect((await git.getLog(repo, { limit: 1 })).commits[0].subject).toBe('update keep');
  }, 20_000);

  it('refuses an empty commit message', async () => {
    const result = await git.commit(repo, '   ');
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/empty/i);
  });

  it('stashes and drops', async () => {
    writeFileSync(path.join(repo, 'keep.txt'), 'stash me\n');
    expect((await git.stashPush(repo, { message: 'wip' })).ok).toBe(true);

    const stashes = await git.getStashes(repo);
    expect(stashes[0]).toMatchObject({ index: 0, ref: 'stash@{0}', branch: 'main' });
    expect(stashes[0].message).toContain('wip');

    expect((await git.stashAction(repo, 'drop', 'stash@{0}')).ok).toBe(true);
    expect(await git.getStashes(repo)).toEqual([]);
  }, 20_000);
});

describe('argument safety', () => {
  it('refuses a ref that git would read as an option', async () => {
    await expect(git.getDiff(repo, { kind: 'commit', sha: 'HEAD' }, '--output=/tmp/pwned')).rejects.toThrow(
      /Invalid path/
    );
    await expect(git.getCommitDetail(repo, '--upload-pack=touch')).rejects.toThrow(/Invalid revision/);
  });

  it('treats paths literally, not as globs', async () => {
    // `[ab].txt` as a glob would also match `a.txt` — discarding one must not delete the other.
    writeFileSync(path.join(repo, '[ab].txt'), 'bracket\n');
    writeFileSync(path.join(repo, 'a.txt'), 'innocent\n');
    expect((await git.discard(repo, [], ['[ab].txt'])).ok).toBe(true);

    const files = (await git.getStatus(repo)).files.map((f) => f.path);
    expect(files).not.toContain('[ab].txt');
    expect(files).toContain('a.txt');
  }, 20_000);
});
