import { describe, it, expect, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WorkspaceItemNotesTodo } from './WorkspaceNotesTodo';
import type { Workspace, WorkspaceTodo } from '../../shared/types';

afterEach(() => cleanup());

const makeWs = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'w1', name: 'My WS', workingDirectory: null, layoutTree: null, containers: [],
  containerZooms: {}, focusedContainerId: null, createdAt: 0, updatedAt: 0, ...over,
});

// A stateful harness so updater-style callbacks actually mutate the workspace and
// re-render the popover — mirroring how App wires this through useWorkspace.
const Harness: React.FC<{ initial?: Workspace; onNotes?: (n: string) => void }> = ({ initial, onNotes }) => {
  const [ws, setWs] = useState<Workspace>(initial ?? makeWs());
  return (
    <WorkspaceItemNotesTodo
      workspace={ws}
      onSetNotes={(_id, notes) => { onNotes?.(notes); setWs((w) => ({ ...w, notes })); }}
      onUpdateTodos={(_id, updater) => setWs((w) => ({ ...w, todos: updater(w.todos ?? []) }))}
    />
  );
};

// Query by title — when the todos badge is shown, its text becomes the button's
// accessible name, so a role+name query is unreliable; the title is stable.
const notesBtn = () => screen.getByTitle(/^Notes/);
const todosBtn = () => screen.getByTitle(/^Todos/);

describe('WorkspaceItemNotesTodo', () => {
  it('renders the two inline icon buttons', () => {
    render(<Harness />);
    expect(notesBtn()).toBeInTheDocument();
    expect(todosBtn()).toBeInTheDocument();
  });

  it('opens the notes popover on click and writes through onSetNotes', () => {
    const onNotes = vi.fn();
    render(<Harness onNotes={onNotes} />);
    fireEvent.click(notesBtn());
    const ta = screen.getByPlaceholderText(/Next steps/);
    fireEvent.change(ta, { target: { value: 'deploy then verify' } });
    expect(onNotes).toHaveBeenCalledWith('deploy then verify');
    expect((screen.getByPlaceholderText(/Next steps/) as HTMLTextAreaElement).value).toBe('deploy then verify');
  });

  it('adds a todo via the input and shows it in the list', () => {
    render(<Harness />);
    fireEvent.click(todosBtn());
    const input = screen.getByPlaceholderText(/Add a task/);
    fireEvent.change(input, { target: { value: 'write tests' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('write tests')).toBeInTheDocument();
    expect((screen.getByPlaceholderText(/Add a task/) as HTMLInputElement).value).toBe('');
  });

  it('cycles a todo through to do → in progress → done, then clears completed', () => {
    const todos: WorkspaceTodo[] = [{ id: 't1', text: 'ship it', status: 'todo', createdAt: 0 }];
    render(<Harness initial={makeWs({ todos })} />);
    fireEvent.click(todosBtn());
    const statusBtn = () => screen.getByTitle(/click to change status/);
    // todo → in progress: amber label appears, no strike-through yet.
    fireEvent.click(statusBtn());
    expect(screen.getByText('in progress')).toBeInTheDocument();
    expect(screen.getByText('ship it')).not.toHaveStyle({ textDecoration: 'line-through' });
    // in progress → done: strike-through, label gone.
    fireEvent.click(statusBtn());
    expect(screen.getByText('ship it')).toHaveStyle({ textDecoration: 'line-through' });
    expect(screen.queryByText('in progress')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Clear completed/ }));
    expect(screen.queryByText('ship it')).toBeNull();
  });

  it('migrates a legacy `done` todo to the done status (strike-through)', () => {
    const todos: WorkspaceTodo[] = [{ id: 't1', text: 'legacy', done: true, createdAt: 0 } as WorkspaceTodo];
    render(<Harness initial={makeWs({ todos })} />);
    fireEvent.click(todosBtn());
    expect(screen.getByText('legacy')).toHaveStyle({ textDecoration: 'line-through' });
  });

  it('shows the open-count badge on the todos icon for unfinished todos', () => {
    const todos: WorkspaceTodo[] = [
      { id: 'a', text: 'one', status: 'todo', createdAt: 0 },
      { id: 'b', text: 'two', status: 'done', createdAt: 0 },
    ];
    render(<Harness initial={makeWs({ todos })} />);
    // 1 open of 2 → badge "1" on the todos button; title reflects the count.
    expect(within(todosBtn()).getByText('1')).toBeInTheDocument();
    expect(todosBtn()).toHaveAttribute('title', 'Todos (1 open)');
  });
});
