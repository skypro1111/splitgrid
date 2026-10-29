import { describe, expect, it } from 'vitest';
import { rankFileMatches, scoreMatch, type ProjectFile } from './project-files';

const files: ProjectFile[] = [
  { path: 'src/renderer/App.tsx', isDirectory: false },
  { path: 'src/renderer/components/agent/AgentPanel.tsx', isDirectory: false },
  { path: 'src/renderer/apple-touch-icon.png', isDirectory: false },
  { path: 'src/main', isDirectory: true },
  { path: 'package.json', isDirectory: false },
];

describe('scoreMatch', () => {
  it('ranks a filename prefix above a path hit', () => {
    expect(scoreMatch('src/renderer/App.tsx', 'app')).toBeGreaterThan(
      scoreMatch('src/renderer/apple-touch-icon.png', 'renderer'),
    );
  });

  it('accepts a subsequence as a last resort', () => {
    expect(scoreMatch('src/renderer/App.tsx', 'srApp')).toBeGreaterThan(0);
  });

  it('rejects what does not match at all', () => {
    expect(scoreMatch('package.json', 'zzz')).toBe(-1);
  });

  it('matches everything on an empty query', () => {
    expect(scoreMatch('anything', '')).toBeGreaterThan(0);
  });
});

describe('rankFileMatches', () => {
  it('puts the filename match first', () => {
    expect(rankFileMatches(files, 'app', 3)[0].path).toBe('src/renderer/App.tsx');
  });

  it('finds a nested file by its name', () => {
    expect(rankFileMatches(files, 'AgentPanel', 3)[0].path).toBe(
      'src/renderer/components/agent/AgentPanel.tsx',
    );
  });

  it('respects the limit', () => {
    expect(rankFileMatches(files, '', 2)).toHaveLength(2);
  });

  it('drops non-matches instead of padding the list', () => {
    expect(rankFileMatches(files, 'zzzz', 5)).toEqual([]);
  });

  it('breaks a tie towards directories, which the user keeps typing into', () => {
    const tie: ProjectFile[] = [
      { path: 'lib', isDirectory: true },
      { path: 'lib', isDirectory: false },
    ];
    expect(rankFileMatches(tie, 'lib', 2)[0].isDirectory).toBe(true);
  });
});
