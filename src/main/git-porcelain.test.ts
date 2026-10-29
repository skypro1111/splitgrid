import { describe, it, expect } from 'vitest';
import {
  parseDecorations,
  parseLog,
  parseRawNumstat,
  parseRefs,
  parseRemotes,
  parseStashList,
  parseStatus,
  parseTrack,
  parseWorktrees,
} from './git-porcelain';

// Fixtures below are literal bytes captured from git (2.x) — see the format
// strings in git-porcelain.ts. \0 separates fields, \x01 separates records.
const z = '\0';
const rs = '\x01';

describe('parseTrack', () => {
  it('reads ahead/behind counts', () => {
    expect(parseTrack('[ahead 2, behind 1]')).toEqual({ ahead: 2, behind: 1, gone: false });
    expect(parseTrack('[ahead 3]')).toEqual({ ahead: 3, behind: 0, gone: false });
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false });
    expect(parseTrack('[gone]')).toEqual({ ahead: 0, behind: 0, gone: true });
  });
});

describe('parseDecorations', () => {
  it('classifies HEAD, branches, remotes and tags', () => {
    const refs = parseDecorations('HEAD -> main, github/main, tag: v1.1.0, feature/work', ['github']);
    expect(refs).toEqual([
      { name: 'main', kind: 'branch', isHead: true },
      { name: 'github/main', kind: 'remote' },
      { name: 'v1.1.0', kind: 'tag' },
      // Slash-containing local branch is NOT mistaken for a remote when the
      // remote list is known.
      { name: 'feature/work', kind: 'branch' },
    ]);
  });

  it('handles detached HEAD and an empty decoration', () => {
    expect(parseDecorations('HEAD')).toEqual([{ name: 'HEAD', kind: 'head', isHead: true }]);
    expect(parseDecorations('')).toEqual([]);
  });
});

describe('parseLog', () => {
  const record = (fields: string[]) => rs + fields.join(z);

  it('parses commits, parents and multi-line bodies', () => {
    const stdout =
      record([
        'aa1d546',
        '9c4f727 1234abc',
        'skravchenko',
        's@example.com',
        '1785084899',
        'skravchenko',
        '1785084900',
        'HEAD -> main, github/main',
        'Keep screenshots',
        'line one\nline two\n\n',
      ]) +
      record(['9c4f727', '', 'Someone', 'a@b.c', '1700000000', 'Someone', '1700000000', '', 'root', '']);

    const commits = parseLog(stdout, ['github']);
    expect(commits).toHaveLength(2);
    expect(commits[0].sha).toBe('aa1d546');
    expect(commits[0].parents).toEqual(['9c4f727', '1234abc']);
    expect(commits[0].authorDate).toBe(1785084899);
    expect(commits[0].body).toBe('line one\nline two');
    expect(commits[0].refs.map((r) => r.name)).toEqual(['main', 'github/main']);
    // Root commit: no parents, no decorations.
    expect(commits[1].parents).toEqual([]);
    expect(commits[1].refs).toEqual([]);
  });

  it('returns nothing for empty output', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('parseRefs', () => {
  it('splits branches from tags and reads upstream tracking', () => {
    const stdout = [
      ['refs/heads/main', 'aa1d546', 'github/main', '[ahead 1, behind 2]', '*', '/repo', '1785084899', 'Keep screenshots'].join(z),
      ['refs/heads/feature/work', 'aaf9ed9', '', '', ' ', '/repo/.claude/worktrees/feature-work', '1780436575', 'feat: agent'].join(z),
      ['refs/remotes/origin/main', 'e42d160', '', '', ' ', '', '1785084914', 'Keep screenshots'].join(z),
      ['refs/remotes/origin/HEAD', 'e42d160', '', '', ' ', '', '1785084914', 'Keep screenshots'].join(z),
      ['refs/tags/1.1.0', '87abea4', '', '', ' ', '', '1780917991', 'chore(release)'].join(z),
    ].join('\n');

    const { branches, tags } = parseRefs(stdout);

    expect(branches.map((b) => b.name)).toEqual(['main', 'feature/work', 'origin/main']);
    expect(branches[0]).toMatchObject({ isHead: true, isRemote: false, upstream: 'github/main', ahead: 1, behind: 2 });
    expect(branches[1]).toMatchObject({ isHead: false, worktreePath: '/repo/.claude/worktrees/feature-work' });
    expect(branches[2]).toMatchObject({ isRemote: true, upstream: null });
    // origin/HEAD is a symbolic pointer, not a branch.
    expect(branches.some((b) => b.name.endsWith('/HEAD'))).toBe(false);
    expect(tags).toEqual([
      { name: '1.1.0', fullName: 'refs/tags/1.1.0', sha: '87abea4', date: 1780917991, subject: 'chore(release)' },
    ]);
  });
});

describe('parseWorktrees', () => {
  it('parses the main worktree and a linked one', () => {
    const stdout = [
      'worktree /repo',
      'HEAD aa1d546',
      'branch refs/heads/main',
      '',
      'worktree /repo/.claude/worktrees/feature-work',
      'HEAD aaf9ed9',
      'branch refs/heads/feature/work',
      '',
    ].join('\n');

    const trees = parseWorktrees(stdout, '/repo/.claude/worktrees/feature-work');
    expect(trees).toHaveLength(2);
    expect(trees[0]).toMatchObject({ path: '/repo', branch: 'main', isMain: true, isCurrent: false });
    expect(trees[1]).toMatchObject({ branch: 'feature/work', isMain: false, isCurrent: true });
  });

  it('reads detached, locked and prunable flags', () => {
    const stdout = [
      'worktree /repo',
      'HEAD aa1d546',
      'detached',
      '',
      'worktree /repo/wt',
      'HEAD bbb',
      'branch refs/heads/wip',
      'locked reason here',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    const trees = parseWorktrees(stdout);
    expect(trees[0].detached).toBe(true);
    expect(trees[0].branch).toBeNull();
    expect(trees[1]).toMatchObject({ locked: true, lockedReason: 'reason here', prunable: true });
  });
});

describe('parseStatus', () => {
  it('parses branch headers, modified, renamed and untracked files', () => {
    // Captured from `git status --porcelain=v2 --branch --untracked-files=all -z`.
    const stdout = [
      '# branch.oid 38cedb9',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '2 R. N... 100644 100644 100644 ba077a4 ba077a4 R100 b2.bin',
      'b.bin',
      '1 .M N... 100644 100644 100644 d68dd40 d68dd40 new.txt',
      '1 M. N... 100644 100644 100644 aaa bbb staged.txt',
      '? u.txt',
      '! ignored.txt',
    ].join(z) + z;

    const status = parseStatus(stdout);

    expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
    expect(status.files).toHaveLength(5);

    const [renamed, modified, staged, untracked, ignored] = status.files;
    expect(renamed).toMatchObject({ path: 'b2.bin', origPath: 'b.bin', staged: true, unstaged: false });
    expect(modified).toMatchObject({ path: 'new.txt', staged: false, unstaged: true });
    expect(staged).toMatchObject({ path: 'staged.txt', staged: true, unstaged: false });
    expect(untracked).toMatchObject({ path: 'u.txt', untracked: true, unstaged: true, staged: false });
    expect(ignored).toMatchObject({ path: 'ignored.txt', ignored: true });
  });

  it('marks unmerged paths as conflicted', () => {
    const stdout = 'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt' + z;
    const [file] = parseStatus(stdout).files;
    expect(file).toMatchObject({ path: 'conflict.txt', conflicted: true });
  });

  it('reports a detached HEAD as no branch', () => {
    expect(parseStatus('# branch.head (detached)' + z).branch).toBeNull();
  });

  it('keeps spaces in paths', () => {
    const stdout = '1 .M N... 100644 100644 100644 aaa bbb my file.txt' + z;
    expect(parseStatus(stdout).files[0].path).toBe('my file.txt');
  });
});

describe('parseRawNumstat', () => {
  it('parses a plain modification', () => {
    // `git show --format= --raw --numstat -z`
    const stdout =
      ':100644 100644 019f0ff a87ddf5 M' + z + 'CHANGELOG.md' + z +
      '23\t0\tCHANGELOG.md' + z;

    expect(parseRawNumstat(stdout)).toEqual([
      { path: 'CHANGELOG.md', origPath: null, status: 'M', score: null, additions: 23, deletions: 0, binary: false },
    ]);
  });

  it('pairs a rename with its line counts', () => {
    // Captured verbatim: the numstat record for a rename has an empty path
    // field, then the old and new paths as separate NUL tokens.
    const stdout =
      ':100644 100644 de98044 d68dd40 R075' + z + 'old.txt' + z + 'new.txt' + z +
      '1\t0\t' + z + 'old.txt' + z + 'new.txt' + z;

    expect(parseRawNumstat(stdout)).toEqual([
      { path: 'new.txt', origPath: 'old.txt', status: 'R', score: 75, additions: 1, deletions: 0, binary: false },
    ]);
  });

  it('flags binary files instead of counting lines', () => {
    const stdout =
      ':000000 100644 0000000 2299c37 A' + z + 'logo.png' + z +
      '-\t-\tlogo.png' + z;

    expect(parseRawNumstat(stdout)[0]).toMatchObject({ binary: true, additions: 0, deletions: 0 });
  });

  it('parses several files in one commit', () => {
    const stdout =
      ':100644 100644 aaa bbb M' + z + 'a.ts' + z +
      ':000000 100644 000 ccc A' + z + 'b.ts' + z +
      ':100644 000000 ddd 000 D' + z + 'c.ts' + z +
      '1\t2\ta.ts' + z + '10\t0\tb.ts' + z + '0\t5\tc.ts' + z;

    const files = parseRawNumstat(stdout);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['a.ts', 'M', 1, 2],
      ['b.ts', 'A', 10, 0],
      ['c.ts', 'D', 0, 5],
    ]);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseRawNumstat('')).toEqual([]);
  });
});

describe('parseStashList', () => {
  it('splits the branch out of the WIP subject', () => {
    const stdout =
      rs + ['stash@{0}', '0e5dee3', 'WIP on main: 38cedb9 merge side', '1788876266'].join(z) +
      rs + ['stash@{1}', 'abc1234', 'On feature/x: my message', '1788876000'].join(z);

    expect(parseStashList(stdout)).toEqual([
      { index: 0, ref: 'stash@{0}', sha: '0e5dee3', message: '38cedb9 merge side', branch: 'main', date: 1788876266 },
      { index: 1, ref: 'stash@{1}', sha: 'abc1234', message: 'my message', branch: 'feature/x', date: 1788876000 },
    ]);
  });

  it('returns nothing when the stash is empty', () => {
    expect(parseStashList('')).toEqual([]);
  });
});

describe('parseRemotes', () => {
  it('collapses the fetch/push pair', () => {
    const stdout = [
      'origin\tgit@github.com:me/repo.git (fetch)',
      'origin\tgit@github.com:me/repo.git (push)',
      'github\thttps://github.com/me/repo.git (fetch)',
      'github\thttps://github.com/me/other.git (push)',
    ].join('\n');

    expect(parseRemotes(stdout)).toEqual([
      { name: 'origin', fetchUrl: 'git@github.com:me/repo.git', pushUrl: 'git@github.com:me/repo.git' },
      { name: 'github', fetchUrl: 'https://github.com/me/repo.git', pushUrl: 'https://github.com/me/other.git' },
    ]);
  });
});
