import { describe, expect, it } from 'vitest';
import {
  classifyTool,
  diffLines,
  diffStat,
  fileChangeDiff,
  shortPath,
  todoEntries,
} from './toolPresentation';

describe('classifyTool', () => {
  it('separates the kinds a reader actually scans for', () => {
    expect(classifyTool('Bash', { command: 'npm test' }, 'npm test')).toMatchObject({
      kind: 'command',
      verb: 'Ran',
      target: 'npm test',
      mutates: true,
    });
    expect(classifyTool('Edit', { file_path: '/a/b/App.tsx' }, 'x')).toMatchObject({
      kind: 'file-change',
      verb: 'Edited',
      target: 'b/App.tsx',
    });
    expect(classifyTool('Read', { file_path: '/a/b/App.tsx' }, 'x')).toMatchObject({
      kind: 'file-read',
      verb: 'Read',
    });
    expect(classifyTool('Grep', { pattern: 'foo' }, 'x')).toMatchObject({ kind: 'search' });
    expect(classifyTool('WebFetch', { url: 'https://x' }, 'x')).toMatchObject({ kind: 'web' });
    expect(classifyTool('Task', { description: 'audit' }, 'x')).toMatchObject({ kind: 'task' });
    expect(classifyTool('TodoWrite', {}, 'x')).toMatchObject({ kind: 'todo' });
  });

  it('names the server and tool of an MCP call', () => {
    expect(classifyTool('mcp__github__create_issue', {}, 'x')).toMatchObject({
      kind: 'mcp',
      verb: 'github',
      target: 'create_issue',
    });
  });

  it('falls back to the summary for unknown tools', () => {
    expect(classifyTool('SomeNewTool', {}, 'did a thing')).toMatchObject({
      kind: 'other',
      verb: 'SomeNewTool',
      target: 'did a thing',
    });
  });

  it('marks only tools that can change the tree as mutating', () => {
    expect(classifyTool('Write', { file_path: 'a' }, 'a').mutates).toBe(true);
    expect(classifyTool('Read', { file_path: 'a' }, 'a').mutates).toBe(false);
  });
});

describe('shortPath', () => {
  it('keeps the tail that identifies a file', () => {
    expect(shortPath('/very/long/path/to/App.tsx')).toBe('to/App.tsx');
    expect(shortPath('App.tsx')).toBe('App.tsx');
  });
});

describe('diffLines', () => {
  it('marks removals and additions around unchanged context', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc');
    expect(diff).toEqual([
      { sign: ' ', text: 'a' },
      { sign: '-', text: 'b' },
      { sign: '+', text: 'B' },
      { sign: ' ', text: 'c' },
    ]);
  });

  it('elides long unchanged stretches', () => {
    const before = ['x', ...Array.from({ length: 20 }, (_, i) => `line${i}`), 'y'].join('\n');
    const after = ['X', ...Array.from({ length: 20 }, (_, i) => `line${i}`), 'y'].join('\n');
    const diff = diffLines(before, after);
    expect(diff.some((line) => line.text === '…')).toBe(true);
    expect(diff.length).toBeLessThan(12);
  });

  it('reports nothing for identical input', () => {
    expect(diffLines('same\ntext', 'same\ntext')).toEqual([]);
  });
});

describe('fileChangeDiff', () => {
  it('diffs an Edit from its before/after', () => {
    const diff = fileChangeDiff('Edit', { old_string: 'one', new_string: 'two' });
    expect(diffStat(diff ?? [])).toEqual({ added: 1, removed: 1 });
  });

  it('treats a Write as all-added', () => {
    const diff = fileChangeDiff('Write', { content: 'a\nb' });
    expect(diffStat(diff ?? [])).toEqual({ added: 2, removed: 0 });
  });

  it('has nothing to show for other tools', () => {
    expect(fileChangeDiff('Bash', { command: 'ls' })).toBeNull();
    expect(fileChangeDiff('Edit', {})).toBeNull();
  });
});

describe('todoEntries', () => {
  it('reads the plan out of a TodoWrite call', () => {
    const todos = todoEntries({
      todos: [
        { content: 'first', status: 'completed' },
        { content: 'second', status: 'in_progress' },
        { content: '', status: 'pending' },
      ],
    });
    expect(todos).toEqual([
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'in_progress' },
    ]);
  });

  it('is empty for anything else', () => {
    expect(todoEntries({})).toEqual([]);
    expect(todoEntries(null)).toEqual([]);
  });
});
