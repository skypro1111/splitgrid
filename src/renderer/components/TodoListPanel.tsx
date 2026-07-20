import React, { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { WorkspaceTodo, WorkspaceTodoStatus } from '../../shared/types';

// Shared todo-list body used by both the per-workspace popover
// (WorkspaceItemNotesTodo) and the environment-wide popover (EnvTodoButton).
// Renders the list + add input + clear-completed; the header/shell is the
// caller's responsibility.

// A todo cycles through these states on click; legacy items carry only the old
// `done` boolean, so derive the status from it until the next edit rewrites it.
const STATUS_ORDER: WorkspaceTodoStatus[] = ['todo', 'in_progress', 'done'];
export const STATUS_LABEL: Record<WorkspaceTodoStatus, string> = {
  todo: 'To do', in_progress: 'In progress', done: 'Done',
};

export const statusOf = (t: WorkspaceTodo): WorkspaceTodoStatus => t.status ?? (t.done ? 'done' : 'todo');
const nextStatus = (s: WorkspaceTodoStatus): WorkspaceTodoStatus =>
  STATUS_ORDER[(STATUS_ORDER.indexOf(s) + 1) % STATUS_ORDER.length];

// Small clickable status indicator: empty box (todo), amber dot (in progress),
// filled green check (done).
const statusBoxStyle = (status: WorkspaceTodoStatus): React.CSSProperties => {
  const accent =
    status === 'done' ? 'var(--accent-green, #15ac91)'
    : status === 'in_progress' ? 'var(--accent-amber, #e0a23a)'
    : 'var(--border)';
  return {
    flexShrink: 0, marginTop: 1, width: 16, height: 16, padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 4, cursor: 'pointer', fontSize: 10, lineHeight: 1,
    border: `1.5px solid ${accent}`,
    background: status === 'done' ? accent : 'transparent',
    color: status === 'done' ? '#0b1f1a' : accent,
  };
};

type TodoUpdater = (todos: WorkspaceTodo[]) => WorkspaceTodo[];

interface Props {
  todos: WorkspaceTodo[];
  onUpdate: (updater: TodoUpdater) => void;
  /** When provided, each item shows a Run button: it flips the item to
   * "in progress" and hands the item's text to the caller (e.g. to paste into
   * the focused terminal). */
  onRun?: (text: string) => void;
}

export const TodoListPanel: React.FC<Props> = ({ todos, onUpdate, onRun }) => {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  // Grow a textarea to fit its content (so the editor matches the item's size
  // and wraps like the text, instead of a single-line input).
  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  const startEdit = useCallback((id: string, text: string) => {
    setEditingId(id);
    setEditDraft(text);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditDraft('');
  }, []);

  // Save the edited text (no-op/cancel when blank), then leave edit mode.
  const commitEdit = useCallback((id: string) => {
    const text = editDraft.trim();
    if (text) onUpdate((list) => list.map((t) => (t.id === id ? { ...t, text } : t)));
    setEditingId(null);
    setEditDraft('');
  }, [editDraft, onUpdate]);

  const addTodo = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    onUpdate((list) => [...list, { id: uuidv4(), text, status: 'todo', createdAt: Date.now() }]);
    setDraft('');
  }, [draft, onUpdate]);

  // Advance todo → in progress → done → todo; also drops the legacy `done` flag.
  const cycleTodo = useCallback((id: string) => {
    onUpdate((list) => list.map((t) => {
      if (t.id !== id) return t;
      const { done: _done, ...rest } = t;
      return { ...rest, status: nextStatus(statusOf(t)) };
    }));
  }, [onUpdate]);

  const deleteTodo = useCallback((id: string) => {
    onUpdate((list) => list.filter((t) => t.id !== id));
  }, [onUpdate]);

  // Mark the item in-progress and hand its text to the caller (paste into
  // the focused terminal). Also drops the legacy `done` flag.
  const runTodo = useCallback((id: string, text: string) => {
    onUpdate((list) => list.map((t) => {
      if (t.id !== id) return t;
      const { done: _done, ...rest } = t;
      return { ...rest, status: 'in_progress' };
    }));
    onRun?.(text);
  }, [onUpdate, onRun]);

  const clearDone = useCallback(() => {
    onUpdate((list) => list.filter((t) => statusOf(t) !== 'done'));
  }, [onUpdate]);

  return (
    <>
      <div style={{ minHeight: 180, maxHeight: 390, overflowY: 'auto' }}>
        {todos.length === 0 && (
          <div style={{ padding: '14px 12px', fontSize: '11px', color: 'var(--text-muted)' }}>
            No tasks yet. Add one below.
          </div>
        )}
        {todos.map((t) => {
          const status = statusOf(t);
          const done = status === 'done';
          return (
          <div key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '6px 12px' }}>
            <button
              onClick={() => cycleTodo(t.id)}
              title={`${STATUS_LABEL[status]} — click to change status`}
              style={statusBoxStyle(status)}
            >
              {status === 'done' ? '✓' : status === 'in_progress' ? '●' : ''}
            </button>
            {editingId === t.id ? (
              <textarea
                autoFocus
                ref={autoGrow}
                value={editDraft}
                rows={1}
                onChange={(e) => { setEditDraft(e.target.value); autoGrow(e.target); }}
                onFocus={(e) => { autoGrow(e.target); e.target.select(); }}
                onBlur={() => commitEdit(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(t.id); }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                }}
                style={{
                  flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '2px 6px', fontSize: '12px',
                  lineHeight: 1.4, background: 'var(--bg-input, var(--bg-base))', color: 'var(--text-primary)',
                  border: '1px solid var(--accent)', borderRadius: 4, outline: 'none', fontFamily: 'inherit',
                  resize: 'none', overflow: 'hidden', wordBreak: 'break-word',
                }}
              />
            ) : (
              <span
                onClick={() => startEdit(t.id, t.text)}
                title="Click to edit"
                style={{
                  flex: 1, fontSize: '12px', lineHeight: 1.4, cursor: 'text', wordBreak: 'break-word',
                  color: done ? 'var(--text-muted)' : 'var(--text-primary)',
                  textDecoration: done ? 'line-through' : 'none',
                }}
              >
                {t.text}
                {status === 'in_progress' && (
                  <span style={{
                    marginLeft: 6, fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                    textTransform: 'uppercase', color: 'var(--accent-amber, #e0a23a)',
                  }}>in progress</span>
                )}
              </span>
            )}
            {editingId !== t.id && onRun && (
              <button
                onClick={() => runTodo(t.id, t.text)}
                title="Run in focused terminal"
                style={{
                  flexShrink: 0, height: 18, padding: '0 7px', lineHeight: '16px',
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10, fontWeight: 600,
                  borderRadius: 4, display: 'flex', alignItems: 'center', gap: 3,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-green, #15ac91)'; e.currentTarget.style.borderColor = 'var(--accent-green, #15ac91)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
              >
                <span style={{ fontSize: 8 }}>▶</span> Run
              </button>
            )}
            {editingId !== t.id && (
              <button
                onClick={() => deleteTodo(t.id)}
                title="Delete"
                style={{
                  flexShrink: 0, width: 18, height: 18, lineHeight: '16px', padding: 0,
                  border: 'none', background: 'transparent', color: 'var(--text-muted)',
                  cursor: 'pointer', fontSize: '14px', borderRadius: 4,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-red, #f14c4c)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
              >
                ×
              </button>
            )}
          </div>
          );
        })}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px', display: 'flex', gap: '6px' }}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTodo(); } }}
          placeholder="Add a task…  (Enter)"
          style={{
            flex: 1, boxSizing: 'border-box', padding: '6px 8px', fontSize: '12px',
            background: 'var(--bg-input, var(--bg-base))', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 6, outline: 'none',
          }}
        />
        <button
          onClick={addTodo}
          disabled={!draft.trim()}
          style={{
            flexShrink: 0, padding: '0 10px', fontSize: '12px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--bg-hover)',
            color: 'var(--text-primary)', cursor: 'pointer',
          }}
        >
          Add
        </button>
      </div>
      {todos.some((t) => statusOf(t) === 'done') && (
        <button
          onClick={clearDone}
          style={{
            border: 'none', borderTop: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted)', fontSize: '11px', padding: '6px 12px',
            cursor: 'pointer', textAlign: 'left',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          Clear completed
        </button>
      )}
    </>
  );
};
