import React, { useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { ChecklistIcon } from './Icons';
import { TodoListPanel, statusOf } from './TodoListPanel';
import type { WorkspaceTodo } from '../../shared/types';

// Environment-wide todo list, pinned in the sidebar's bottom bar (above
// Settings). Unlike the per-workspace todos this list is scoped to the whole
// environment / workspace set and persisted with it. Reuses <TodoListPanel>.

const POPOVER_W = 300;
const POPOVER_EST_H = 360; // keeps the popover on-screen when anchored near the bottom

// Anchor to the RIGHT of the button (sidebar is on the left edge), clamped up so
// a button near the window bottom still shows the whole popover.
function anchor(el: HTMLElement): { left: number; top: number } {
  const r = el.getBoundingClientRect();
  const top = Math.max(8, Math.min(r.top, window.innerHeight - POPOVER_EST_H - 8));
  return { left: r.right + 8, top };
}

interface Props {
  todos: WorkspaceTodo[];
  onUpdate: (updater: (todos: WorkspaceTodo[]) => WorkspaceTodo[]) => void;
  collapsed: boolean;
  buttonStyle: React.CSSProperties;
}

export const EnvTodoButton: React.FC<Props> = ({ todos, onUpdate, collapsed, buttonStyle }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  const openCount = useMemo(() => todos.filter((t) => statusOf(t) !== 'done').length, [todos]);
  const inProgressCount = useMemo(() => todos.filter((t) => statusOf(t) === 'in_progress').length, [todos]);

  const toggle = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    setOpen((cur) => {
      if (cur) return false;
      setPos(anchor(el));
      return true;
    });
  }, []);

  const badge = openCount > 0 && (
    <span style={{
      position: 'absolute',
      top: collapsed ? -2 : 4,
      right: collapsed ? -2 : 8,
      fontSize: 9, fontWeight: 700, lineHeight: '13px', minWidth: 13, height: 13,
      padding: '0 3px', borderRadius: 7, textAlign: 'center', boxSizing: 'border-box',
      background: inProgressCount > 0 ? 'var(--accent-amber, #e0a23a)' : 'var(--accent-green, #15ac91)',
      color: '#0b1f1a',
    }}>{openCount}</span>
  );

  return (
    <>
      <button
        onClick={toggle}
        title={openCount > 0 ? `Environment todos (${openCount} open)` : 'Environment todos'}
        style={{ ...buttonStyle, position: 'relative', background: open ? 'var(--bg-hover)' : (buttonStyle.background ?? 'transparent'), color: open ? 'var(--text-primary)' : buttonStyle.color }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={(e) => { if (!open) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; } }}
      >
        <ChecklistIcon size={14} />{!collapsed && 'Todos'}
        {badge}
      </button>

      {open && ReactDOM.createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 9050 }} onClick={() => setOpen(false)} onMouseDown={() => setOpen(false)} />,
        document.body,
      )}
      {open && ReactDOM.createPortal(
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
          <div style={{
            padding: '8px 12px', fontSize: '11px', fontWeight: 600,
            color: 'var(--text-primary)', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>
              Environment todos{openCount > 0 ? ` · ${openCount}` : ''}
              {inProgressCount > 0 && (
                <span style={{ color: 'var(--accent-amber, #e0a23a)', fontWeight: 400 }}>
                  {` · ${inProgressCount} in progress`}
                </span>
              )}
            </span>
          </div>
          <TodoListPanel todos={todos} onUpdate={onUpdate} />
        </div>,
        document.body,
      )}
    </>
  );
};
