import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TodoListPanel } from './TodoListPanel';
import type { TodoImage, WorkspaceTodo } from '../../shared/types';

afterEach(() => cleanup());

const IMAGE_DIR = '/userData/todo-images';
const storedImage = (n: number): TodoImage => ({
  id: `img-${n}`, path: `${IMAGE_DIR}/img-${n}.png`, width: 20, height: 10, addedAt: n,
});

// The bits of electronAPI the panel touches: images are stored/read/deleted by
// the main process, so every one of them is a round-trip we stub here.
function stubAPI() {
  let saved = 0;
  const api = {
    todoSaveImage: vi.fn(async () => storedImage(++saved)),
    todoSaveClipboardImage: vi.fn(async () => storedImage(++saved)),
    todoImageData: vi.fn(async (p: string) => `data:image/png;base64,${p}`),
    todoDeleteImages: vi.fn(async () => undefined),
    todoImagePaths: vi.fn(async (paths: string[]) => paths),
  };
  Object.assign(window, { electronAPI: api });
  return api;
}

// A paste carrying image files, shaped like the DataTransfer the panel reads.
// getAsFile must answer synchronously — only arrayBuffer() is awaited.
function imagePaste(count = 1) {
  const items = Array.from({ length: count }, () => ({
    kind: 'file',
    type: 'image/png',
    getAsFile: () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
  }));
  return { clipboardData: { items, getData: () => '' } };
}

// A paste the way a platform that hides the bitmap from the event delivers it:
// no image item, no text — the panel has to go ask the OS clipboard.
const emptyPaste = { clipboardData: { items: [], getData: () => '' } };
const textPaste = (text: string) => ({
  clipboardData: { items: [{ kind: 'string', type: 'text/plain' }], getData: () => text },
});

// Stateful harness so the updater callbacks actually mutate the list, mirroring
// how App wires this through useWorkspace.
const Harness: React.FC<{
  initial?: WorkspaceTodo[];
  onRun?: (text: string, imagePaths: string[]) => void;
}> = ({ initial, onRun }) => {
  const [todos, setTodos] = useState<WorkspaceTodo[]>(initial ?? []);
  return <TodoListPanel todos={todos} onUpdate={(u) => setTodos((cur) => u(cur))} onRun={onRun} />;
};

const addInput = () => screen.getByPlaceholderText(/Add a task/);

describe('TodoListPanel images', () => {
  let api: ReturnType<typeof stubAPI>;
  beforeEach(() => { api = stubAPI(); });

  it('stores an image pasted into the add input and attaches it to the new task', async () => {
    render(<Harness />);
    fireEvent.paste(addInput(), imagePaste());
    await waitFor(() => expect(api.todoSaveImage).toHaveBeenCalledTimes(1));
    // Thumbnail shows before the task exists — it belongs to the draft.
    expect(await screen.findByAltText('Task screenshot')).toBeInTheDocument();

    fireEvent.change(addInput(), { target: { value: 'fix this layout' } });
    fireEvent.keyDown(addInput(), { key: 'Enter' });

    expect(screen.getByText('fix this layout')).toBeInTheDocument();
    expect(await screen.findByAltText('Task screenshot')).toBeInTheDocument();
    // Adding the task must not delete the file — it now belongs to the item.
    expect(api.todoDeleteImages).not.toHaveBeenCalled();
  });

  it('leaves a plain-text paste to the input', async () => {
    render(<Harness />);
    fireEvent.paste(addInput(), textPaste('just words'));
    await waitFor(() => expect(api.todoSaveImage).not.toHaveBeenCalled());
    expect(api.todoSaveClipboardImage).not.toHaveBeenCalled();
  });

  // Platforms where Chromium doesn't surface the bitmap in the paste event
  // (some Linux desktops, TIFF-only macOS pasteboards) must still work.
  it('falls back to the OS clipboard when the paste event carries no image', async () => {
    render(<Harness />);
    fireEvent.paste(addInput(), emptyPaste);
    await waitFor(() => expect(api.todoSaveClipboardImage).toHaveBeenCalledTimes(1));
    expect(await screen.findByAltText('Task screenshot')).toBeInTheDocument();
  });

  it('attaches a pasted image to an existing task while editing it', async () => {
    render(<Harness initial={[{ id: 't1', text: 'needs a shot', status: 'todo', createdAt: 0 }]} />);
    fireEvent.click(screen.getByText('needs a shot'));
    fireEvent.paste(screen.getByTitle(/attach it to this task/), imagePaste());
    await waitFor(() => expect(api.todoSaveImage).toHaveBeenCalledTimes(1));
    expect(await screen.findByAltText('Task screenshot')).toBeInTheDocument();
  });

  it('adds an image-only task (no text needed)', async () => {
    render(<Harness />);
    fireEvent.paste(addInput(), imagePaste());
    await waitFor(() => expect(api.todoSaveImage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Screenshot')).toBeInTheDocument();
  });

  it('hands the image paths to Run along with the text', () => {
    const onRun = vi.fn();
    const todos: WorkspaceTodo[] = [
      { id: 't1', text: 'compare these', status: 'todo', createdAt: 0, images: [storedImage(1), storedImage(2)] },
    ];
    render(<Harness initial={todos} onRun={onRun} />);
    fireEvent.click(screen.getByTitle(/^Run in focused terminal/));
    expect(onRun).toHaveBeenCalledWith('compare these', [
      `${IMAGE_DIR}/img-1.png`,
      `${IMAGE_DIR}/img-2.png`,
    ]);
  });

  it('deletes the stored files when the task is deleted', () => {
    const todos: WorkspaceTodo[] = [
      { id: 't1', text: 'done with it', status: 'todo', createdAt: 0, images: [storedImage(1)] },
    ];
    render(<Harness initial={todos} />);
    fireEvent.click(screen.getByTitle('Delete'));
    expect(api.todoDeleteImages).toHaveBeenCalledWith([`${IMAGE_DIR}/img-1.png`]);
    expect(screen.queryByText('done with it')).toBeNull();
  });

  it('deletes the files of completed tasks on clear completed', () => {
    const todos: WorkspaceTodo[] = [
      { id: 't1', text: 'shipped', status: 'done', createdAt: 0, images: [storedImage(1)] },
      { id: 't2', text: 'still open', status: 'todo', createdAt: 0, images: [storedImage(2)] },
    ];
    render(<Harness initial={todos} />);
    fireEvent.click(screen.getByRole('button', { name: /Clear completed/ }));
    expect(api.todoDeleteImages).toHaveBeenCalledTimes(1);
    expect(api.todoDeleteImages).toHaveBeenCalledWith([`${IMAGE_DIR}/img-1.png`]);
    expect(screen.getByText('still open')).toBeInTheDocument();
  });

  it('removes a single image from a task and deletes its file', async () => {
    const todos: WorkspaceTodo[] = [
      { id: 't1', text: 'two shots', status: 'todo', createdAt: 0, images: [storedImage(1), storedImage(2)] },
    ];
    render(<Harness initial={todos} />);
    const thumbs = await screen.findAllByAltText('Task screenshot');
    expect(thumbs).toHaveLength(2);
    // The remove button only exists while the thumbnail is hovered.
    fireEvent.mouseEnter(thumbs[0].parentElement as HTMLElement);
    fireEvent.click(screen.getByTitle('Remove image'));
    expect(api.todoDeleteImages).toHaveBeenCalledWith([`${IMAGE_DIR}/img-1.png`]);
    await waitFor(async () => expect(await screen.findAllByAltText('Task screenshot')).toHaveLength(1));
  });

  it('discards draft images when the panel closes before the task is added', async () => {
    const { unmount } = render(<Harness />);
    fireEvent.paste(addInput(), imagePaste());
    await waitFor(() => expect(api.todoSaveImage).toHaveBeenCalled());
    unmount();
    expect(api.todoDeleteImages).toHaveBeenCalledWith([`${IMAGE_DIR}/img-1.png`]);
  });
});
