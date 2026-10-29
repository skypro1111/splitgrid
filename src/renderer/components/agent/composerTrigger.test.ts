import { describe, expect, it } from 'vitest';
import {
  detectComposerTrigger,
  rankSlashCommands,
  replaceTextRange,
} from './composerTrigger';

describe('detectComposerTrigger', () => {
  it('detects a slash command at the start of the input', () => {
    expect(detectComposerTrigger('/rev', 4)).toEqual({
      kind: 'slash-command',
      query: 'rev',
      rangeStart: 0,
      rangeEnd: 4,
    });
  });

  it('detects a slash command at the start of any line', () => {
    const text = 'first line\n/con';
    expect(detectComposerTrigger(text, text.length)).toMatchObject({
      kind: 'slash-command',
      query: 'con',
      rangeStart: 11,
    });
  });

  it('treats a slash inside prose as prose', () => {
    expect(detectComposerTrigger('look at /etc/hosts', 18)).toBeNull();
  });

  it('stops offering commands once arguments are being typed', () => {
    expect(detectComposerTrigger('/review src', 11)).toBeNull();
  });

  it('detects an @ mention anywhere in the line', () => {
    const text = 'please read @src/main';
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: 'path',
      query: 'src/main',
      rangeStart: 12,
      rangeEnd: 21,
    });
  });

  it('offers every path on a bare @', () => {
    expect(detectComposerTrigger('@', 1)).toMatchObject({ kind: 'path', query: '' });
  });

  it('reads the trigger at the caret, not at the end of the text', () => {
    const text = '@src and more';
    expect(detectComposerTrigger(text, 4)).toMatchObject({ kind: 'path', query: 'src' });
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });

  it('returns null for ordinary prose', () => {
    expect(detectComposerTrigger('fix the bug', 11)).toBeNull();
    expect(detectComposerTrigger('', 0)).toBeNull();
  });
});

describe('replaceTextRange', () => {
  it('swaps the range and reports the caret', () => {
    expect(replaceTextRange('read @src/ma', 5, 12, '@src/main.ts ')).toEqual({
      text: 'read @src/main.ts ',
      cursor: 18,
    });
  });

  it('clamps an out-of-bounds range', () => {
    expect(replaceTextRange('hi', -5, 99, 'yo')).toEqual({ text: 'yo', cursor: 2 });
  });
});

describe('rankSlashCommands', () => {
  const commands = [
    { name: 'review', description: 'review the diff' },
    { name: 'run', description: 'launch the app' },
    { name: 'init', description: 'write a review checklist' },
  ];

  it('puts name prefixes above description matches', () => {
    expect(rankSlashCommands(commands, 'rev').map((c) => c.name)).toEqual(['review', 'init']);
  });

  it('prefers the shorter name on equal prefixes, description hits last', () => {
    // 'init' only qualifies through its description, so it ranks below both
    // name-prefix matches.
    expect(rankSlashCommands(commands, 'r').map((c) => c.name)).toEqual([
      'run',
      'review',
      'init',
    ]);
  });

  it('returns everything (capped) for an empty query', () => {
    expect(rankSlashCommands(commands, '', 2)).toHaveLength(2);
  });

  it('drops commands that match nothing', () => {
    expect(rankSlashCommands(commands, 'zzz')).toEqual([]);
  });
});
