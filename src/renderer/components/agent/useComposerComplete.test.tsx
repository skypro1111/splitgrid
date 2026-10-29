import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useComposerComplete } from './useComposerComplete';

const searchSpy = vi.fn();

beforeEach(() => {
  searchSpy.mockReset().mockResolvedValue([
    { path: 'src/main.ts', isDirectory: false },
    { path: 'src/renderer', isDirectory: true },
  ]);
  (window as unknown as { electronAPI: unknown }).electronAPI = { agentSearchFiles: searchSpy };
});

afterEach(() => cleanup());

const COMMANDS = [
  { name: 'review', description: 'review the diff' },
  { name: 'context', description: 'show context usage' },
];

function mount(draft: string) {
  return renderHook(
    (props: { draft: string }) =>
      useComposerComplete({ draft: props.draft, cwd: '/work', slashCommands: COMMANDS }),
    { initialProps: { draft } },
  );
}

describe('useComposerComplete', () => {
  it('opens the command menu on a leading slash', async () => {
    const { result } = mount('/rev');
    act(() => result.current.sync('/rev', 4));
    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.items[0].value).toBe('/review');
    expect(result.current.title).toBe('COMMANDS');
  });

  it('opens the file menu on @ and lists what the search returns', async () => {
    const { result } = mount('@src');
    act(() => result.current.sync('@src', 4));
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(searchSpy).toHaveBeenCalledWith('/work', 'src', expect.any(Number));
    expect(result.current.open).toBe(true);
    expect(result.current.title).toBe('FILES');
  });

  it('lists everything on a bare @, before anything is typed', async () => {
    const { result } = mount('@');
    act(() => result.current.sync('@', 1));
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(searchSpy).toHaveBeenCalledWith('/work', '', expect.any(Number));
  });

  it('accepts a file, replacing the token and leaving a trailing space', async () => {
    const { result } = mount('read @src');
    act(() => result.current.sync('read @src', 9));
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.accept(result.current.items[0])).toEqual({
      text: 'read @src/main.ts ',
      cursor: 18,
    });
  });

  it('keeps the caret inside a directory so the next segment can be typed', async () => {
    const { result } = mount('@src');
    act(() => result.current.sync('@src', 4));
    await waitFor(() => expect(result.current.items.length).toBe(2));
    const directory = result.current.items.find((item) => item.isDirectory);
    expect(result.current.accept(directory!)).toEqual({
      text: '@src/renderer/',
      cursor: 14,
    });
  });

  it('stays closed in ordinary prose', async () => {
    const { result } = mount('fix the bug');
    act(() => result.current.sync('fix the bug', 11));
    await waitFor(() => expect(result.current.open).toBe(false));
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('reopens after Escape once the query changes', async () => {
    const { result, rerender } = mount('@src');
    act(() => result.current.sync('@src', 4));
    await waitFor(() => expect(result.current.open).toBe(true));

    act(() => result.current.dismiss());
    await waitFor(() => expect(result.current.open).toBe(false));

    rerender({ draft: '@srcx' });
    act(() => result.current.sync('@srcx', 5));
    await waitFor(() => expect(result.current.open).toBe(true));
  });
});
