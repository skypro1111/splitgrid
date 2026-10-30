import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WHY_GRACE_MS, WHY_MAX_COMMITS, commitsForFile, matchEditsToCommits, parseBlamePorcelain, parseLog,
  type FileEdit, type WhyCommit,
} from './git-why';

const H = 3_600_000;
const sha = (c: string) => c.repeat(40);
const commit = (c: string, ts: number, extra: Partial<WhyCommit> = {}): WhyCommit => ({ sha: sha(c), ts, subject: c, author: 'me', ...extra });
const edit = (sessionId: string, ts: number): FileEdit => ({ sessionId, chunkId: `${sessionId}:${ts}`, ts, snippet: '' });

describe('parsers', () => {
  it('reads the blamed commit, including an uncommitted line', () => {
    const out = `${sha('a')} 3 3 1\nauthor Ann\nauthor-time 1700000000\nsummary Fix the retry\nfilename a.ts\n\tcode\n`;
    expect(parseBlamePorcelain(out)).toEqual({ sha: sha('a'), ts: 1_700_000_000_000, subject: 'Fix the retry', author: 'Ann' });
    const dirty = `${sha('0')} 1 1 1\nauthor Not Committed Yet\nauthor-time 1700000100\nsummary Version of a.ts from a.ts\n`;
    expect(parseBlamePorcelain(dirty)).toMatchObject({ uncommitted: true, subject: '(not committed yet)' });
    expect(parseBlamePorcelain('fatal: no such path')).toBeNull();
  });

  it('reads log lines, keeping a subject that contains the separator', () => {
    const out = `${sha('b')}\x1f1700000000\x1fBob\x1fAdd x\n${sha('c')}\x1f1600000000\x1fCy\x1fa\x1fb\n\n`;
    expect(parseLog(out)).toEqual([
      { sha: sha('b'), ts: 1_700_000_000_000, author: 'Bob', subject: 'Add x' },
      { sha: sha('c'), ts: 1_600_000_000_000, author: 'Cy', subject: 'a\x1fb' },
    ]);
  });
});

describe('matchEditsToCommits', () => {
  it('attributes the work between two commits to the later one, one entry per session, nearest first', () => {
    const commits = [commit('b', 100 * H), commit('a', 50 * H)];
    const edits = [edit('s1', 99 * H), edit('s1', 98 * H), edit('s2', 70 * H), edit('s3', 40 * H), edit('s4', 100 * H + WHY_GRACE_MS + 1)];
    const [later, older] = matchEditsToCommits({ commits, olderTs: 30 * H }, edits);
    expect(later.edits.map((e) => e.chunkId)).toEqual([`s1:${99 * H}`, `s2:${70 * H}`]);
    expect(older.edits.map((e) => e.sessionId)).toEqual(['s3']);
  });

  it('bounds the oldest commit by the commit below it, and not at all for the file\'s first commit', () => {
    // Work that sat uncommitted for days before the file's first commit still counts.
    const edits = [edit('days-before', 50 * H - 96 * H)];
    expect(matchEditsToCommits({ commits: [commit('a', 50 * H)], olderTs: null }, edits)[0].edits).toHaveLength(1);
    expect(matchEditsToCommits({ commits: [commit('a', 50 * H)], olderTs: 10 * H }, edits)[0].edits).toEqual([]);
  });

  it('explains an uncommitted line by the edits since the last commit', () => {
    const now = 500 * H;
    const [entry] = matchEditsToCommits(
      { commits: [commit('0', 0, { uncommitted: true })], olderTs: now - 10 * H },
      [edit('s', now - H), edit('before-last-commit', now - 20 * H)],
      now,
    );
    expect(entry.edits.map((e) => e.sessionId)).toEqual(['s']);
  });
});

describe('commitsForFile (real git)', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });

  beforeAll(async () => {
    repo = realpathSync(await mkdtemp(path.join(tmpdir(), 'sg-why-')));
    git('init', '-q');
    await writeFile(path.join(repo, 'a b.ts'), 'one\ntwo\n');
    git('add', '.');
    git('commit', '-qm', 'first');
    await writeFile(path.join(repo, 'a b.ts'), 'one\nTWO\n');
    git('commit', '-qam', 'second');
  });
  afterAll(async () => { await rm(repo, { recursive: true, force: true }); });

  it('lists a file\'s commits newest first and blames one line', async () => {
    const file = path.join(repo, 'a b.ts');
    const whole = await commitsForFile(file);
    expect(whole.commits.map((c) => c.subject)).toEqual(['second', 'first']);
    expect(whole.olderTs).toBeNull();
    const first = await commitsForFile(file, 1);
    expect(first).toEqual({ commits: [expect.objectContaining({ subject: 'first' })], olderTs: null });
    const second = await commitsForFile(file, 2);
    expect(second.commits.map((c) => c.subject)).toEqual(['second']);
    // Bounded by the file's previous commit ("first").
    expect(second.olderTs).toBe(first.commits[0].ts);
  });

  it('yields nothing outside a repo or past the last line', async () => {
    expect(await commitsForFile(path.join(tmpdir(), 'nope.ts'))).toEqual({ commits: [], olderTs: null });
    expect((await commitsForFile(path.join(repo, 'a b.ts'), 99)).commits).toEqual([]);
    expect(WHY_MAX_COMMITS).toBeGreaterThan(1);
  });
});
