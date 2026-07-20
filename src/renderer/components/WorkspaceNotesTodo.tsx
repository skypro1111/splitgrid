import React, { useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { NotesIcon, ChecklistIcon } from './Icons';
import { TodoListPanel, statusOf } from './TodoListPanel';
import type { Workspace, WorkspaceTodo } from '../../shared/types';

// Inline Notes + Todos icons rendered directly ON a workspace sidebar item. Each
// opens a click-anchored popover scoped to THAT workspace. Both pieces of data
// live on the Workspace object and are persisted by App's debounced
// workspace-state save; this component just edits them. The todo list body is
// shared with the environment-wide list via <TodoListPanel>.

const POPOVER_W = 300;
const POPOVER_EST_H = 420; // used only to keep the popover on-screen

// Anchor a popover to the RIGHT of the clicked icon (the sidebar is on the left
// edge), top-aligned but clamped so it never runs off the bottom of the window.
function anchor(el: HTMLElement): { left: number; top: number } {
  const r = el.getBoundingClientRect();
  const top = Math.max(8, Math.min(r.top, window.innerHeight - POPOVER_EST_H - 8));
  return { left: r.right + 8, top };
}

const iconBtnStyle = (active: boolean): React.CSSProperties => ({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  position: 'relative',
  width: 20,
  height: 20,
  padding: 0,
  borderRadius: 4,
  border: 'none',
  background: active ? 'var(--bg-hover)' : 'transparent',
  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
  cursor: 'pointer',
});

const popoverShell = (
  pos: { left: number; top: number },
  children: React.ReactNode,
): React.ReactNode =>
  ReactDOM.createPortal(
    <div
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', left: pos.left, top: pos.top, zIndex: 9100,
        width: POPOVER_W,
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );

interface Props {
  workspace: Workspace;
  onSetNotes: (id: string, notes: string) => void;
  onUpdateTodos: (id: string, updater: (todos: WorkspaceTodo[]) => WorkspaceTodo[]) => void;
  /** Paste a todo's text into the focused terminal (no auto-run). */
  onRun?: (text: string) => void;
}

type Panel = 'notes' | 'todos';

export const WorkspaceItemNotesTodo: React.FC<Props> = ({ workspace, onSetNotes, onUpdateTodos, onRun }) => {
  const [open, setOpen] = useState<Panel | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  const wsId = workspace.id;
  const todos = workspace.todos ?? [];
  const openCount = useMemo(() => todos.filter((t) => statusOf(t) !== 'done').length, [todos]);
  const inProgressCount = useMemo(() => todos.filter((t) => statusOf(t) === 'in_progress').length, [todos]);
  const hasNotes = (workspace.notes ?? '').trim().length > 0;

  // Stop the click/drag from bubbling to the row (which switches workspace /
  // starts a drag) and toggle the panel anchored to the clicked icon.
  const onIconClick = useCallback((panel: Panel) => (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const el = e.currentTarget;
    setOpen((cur) => {
      if (cur === panel) return null;
      setPos(anchor(el));
      return panel;
    });
  }, []);

  const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  const updateTodos = useCallback(
    (updater: (todos: WorkspaceTodo[]) => WorkspaceTodo[]) => onUpdateTodos(wsId, updater),
    [wsId, onUpdateTodos],
  );

  const headerStyle: React.CSSProperties = {
    padding: '8px 12px', fontSize: '11px', fontWeight: 600,
    color: 'var(--text-primary)', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  };
  const wsLabelStyle: React.CSSProperties = {
    color: 'var(--text-muted)', fontWeight: 400, maxWidth: 150,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };

  const notesPanel = open === 'notes' && popoverShell(pos, (
    <>
      <div style={headerStyle}>
        <span>Notes</span>
        <span style={wsLabelStyle}>{workspace.name}</span>
      </div>
      <textarea
        autoFocus
        value={workspace.notes ?? ''}
        onChange={(e) => onSetNotes(wsId, e.target.value)}
        placeholder="Next steps, reminders, anything…"
        style={{
          width: '100%', height: 220, resize: 'vertical', boxSizing: 'border-box',
          padding: '10px 12px', border: 'none', outline: 'none',
          background: 'transparent', color: 'var(--text-primary)',
          fontSize: '12px', lineHeight: 1.5, fontFamily: 'inherit',
        }}
      />
    </>
  ));

  const todosPanel = open === 'todos' && popoverShell(pos, (
    <>
      <div style={headerStyle}>
        <span>
          Todos{openCount > 0 ? ` · ${openCount}` : ''}
          {inProgressCount > 0 && (
            <span style={{ color: 'var(--accent-amber, #e0a23a)', fontWeight: 400 }}>
              {` · ${inProgressCount} in progress`}
            </span>
          )}
        </span>
        <span style={wsLabelStyle}>{workspace.name}</span>
      </div>
      <TodoListPanel todos={todos} onUpdate={updateTodos} onRun={onRun} />
    </>
  ));

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }} onMouseDown={stop}>
      <button
        onClick={onIconClick('notes')}
        onMouseDown={stop}
        title={hasNotes ? 'Notes (has content)' : 'Notes'}
        style={iconBtnStyle(open === 'notes')}
        onMouseEnter={(e) => { if (open !== 'notes') e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={(e) => { if (open !== 'notes') e.currentTarget.style.color = hasNotes ? 'var(--text-secondary)' : 'var(--text-muted)'; }}
      >
        <NotesIcon size={13} color={hasNotes && open !== 'notes' ? 'var(--text-secondary)' : 'currentColor'} />
        {hasNotes && (
          <span style={{
            position: 'absolute', top: 2, right: 2, width: 5, height: 5, borderRadius: '50%',
            background: 'var(--accent-green, #15ac91)',
          }} />
        )}
      </button>
      <button
        onClick={onIconClick('todos')}
        onMouseDown={stop}
        title={openCount > 0 ? `Todos (${openCount} open)` : 'Todos'}
        style={iconBtnStyle(open === 'todos')}
        onMouseEnter={(e) => { if (open !== 'todos') e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={(e) => { if (open !== 'todos') e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        <ChecklistIcon size={13} />
        {openCount > 0 && (
          <span style={{
            position: 'absolute', top: -3, right: -3,
            fontSize: 9, fontWeight: 700, lineHeight: '13px', minWidth: 13, height: 13,
            padding: '0 3px', borderRadius: 7, textAlign: 'center', boxSizing: 'border-box',
            background: inProgressCount > 0 ? 'var(--accent-amber, #e0a23a)' : 'var(--accent-green, #15ac91)',
            color: '#0b1f1a',
          }}>{openCount}</span>
        )}
      </button>

      {open && ReactDOM.createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 9050 }} onClick={() => setOpen(null)} onMouseDown={() => setOpen(null)} />,
        document.body,
      )}
      {notesPanel}
      {todosPanel}
    </span>
  );
};
