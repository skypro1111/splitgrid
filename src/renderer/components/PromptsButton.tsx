import React, { useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { v4 as uuidv4 } from 'uuid';
import type { SavedPrompt } from '../../shared/types';

// Reusable prompts popover, pinned in the sidebar's bottom bar next to the
// Commands button. Unlike commands, a prompt's body is free-form multi-line
// text (e.g. an agent instruction) and can be edited in place. Scoped to the
// whole environment (workspace set) and persisted with it. Clicking a prompt
// pastes it into the focused terminal (no auto-run); the hover ▶ runs it
// (paste + Enter). Mirrors <CommandsButton> / <EnvTodoButton>.

const POPOVER_W = 360;
const POPOVER_EST_H = 440;

function anchor(el: HTMLElement): { left: number; top: number } {
  const r = el.getBoundingClientRect();
  const top = Math.max(8, Math.min(r.top, window.innerHeight - POPOVER_EST_H - 8));
  return { left: r.right + 8, top };
}

const PromptIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 2.5V11.5h-.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M5 6.5h6M5 8.7h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const PlayIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden>
    <path d="M3 2.2v7.6a.5.5 0 0 0 .77.42l6-3.8a.5.5 0 0 0 0-.84l-6-3.8A.5.5 0 0 0 3 2.2Z" />
  </svg>
);

const EditIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M11.5 2.5 13.5 4.5 6 12l-2.5.5L4 10l7.5-7.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

interface Props {
  prompts: SavedPrompt[];
  collapsed: boolean;
  buttonStyle: React.CSSProperties;
  /** Paste (execute=false) or paste+Enter (execute=true) into the focused terminal. */
  onRun: (text: string, execute: boolean) => void;
  onUpdate: (updater: (p: SavedPrompt[]) => SavedPrompt[]) => void;
}

const iconBtn: React.CSSProperties = {
  flexShrink: 0, width: 22, height: 20, padding: 0, display: 'flex',
  alignItems: 'center', justifyContent: 'center', borderRadius: 4,
  border: '1px solid transparent', background: 'transparent',
  color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, lineHeight: 1,
};

const sectionLabel: React.CSSProperties = {
  padding: '8px 12px 4px', fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
  textTransform: 'uppercase', color: 'var(--text-muted)',
};

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 12,
  background: 'var(--bg-input, var(--bg-base))', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 6, outline: 'none',
};

// First non-empty line of the body, used as a fallback label.
const firstLine = (body: string) => body.split('\n').find((l) => l.trim()) ?? '';

export const PromptsButton: React.FC<Props> = ({ prompts, collapsed, buttonStyle, onRun, onUpdate }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  // null = not editing; '' (empty id) marks the "new prompt" draft, else the id being edited.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');

  const toggle = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    setOpen((cur) => {
      if (cur) return false;
      setPos(anchor(el));
      return true;
    });
  }, []);

  const closeEditor = useCallback(() => {
    setEditingId(null);
    setDraftTitle('');
    setDraftBody('');
  }, []);

  const startNew = useCallback(() => {
    setEditingId('');
    setDraftTitle('');
    setDraftBody('');
  }, []);

  const startEdit = useCallback((p: SavedPrompt) => {
    setEditingId(p.id);
    setDraftTitle(p.title ?? '');
    setDraftBody(p.body);
  }, []);

  const saveDraft = useCallback(() => {
    const body = draftBody.trim();
    if (!body) return;
    const title = draftTitle.trim() || undefined;
    if (editingId) {
      const id = editingId;
      onUpdate((list) =>
        list.map((p) => (p.id === id ? { ...p, title, body, updatedAt: Date.now() } : p))
      );
    } else {
      onUpdate((list) => [...list, { id: uuidv4(), title, body, createdAt: Date.now() }]);
    }
    closeEditor();
  }, [draftBody, draftTitle, editingId, onUpdate, closeEditor]);

  const remove = useCallback((id: string) => {
    onUpdate((list) => list.filter((p) => p.id !== id));
    setEditingId((cur) => (cur === id ? null : cur));
  }, [onUpdate]);

  // Paste (and optionally run); then close so the terminal regains focus.
  const run = useCallback((text: string, execute: boolean) => {
    onRun(text, execute);
    setOpen(false);
  }, [onRun]);

  const renderRow = (p: SavedPrompt) => (
    <div
      key={p.id}
      className="prompt-row"
      style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '6px 12px' }}
    >
      <span
        onClick={() => run(p.body, false)}
        title={`${p.body}\n\nClick to paste · ▶ to run`}
        style={{ flex: 1, minWidth: 0, cursor: 'pointer', lineHeight: 1.4 }}
      >
        <span style={{
          display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {p.title || firstLine(p.body)}
        </span>
        <span style={{
          display: 'block', fontSize: 11, color: 'var(--text-muted)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {p.title ? firstLine(p.body) : (p.body.includes('\n') ? '…' : '')}
        </span>
      </span>
      <button
        onClick={() => run(p.body, true)}
        title="Run (paste + Enter)"
        style={iconBtn}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-green, #15ac91)'; e.currentTarget.style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
      >
        <PlayIcon />
      </button>
      <button
        onClick={() => startEdit(p)}
        title="Edit prompt"
        style={iconBtn}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        <EditIcon />
      </button>
      <button
        onClick={() => remove(p.id)}
        title="Delete prompt"
        style={{ ...iconBtn, fontSize: 14 }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-red, #f14c4c)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        ×
      </button>
    </div>
  );

  return (
    <>
      <button
        onClick={toggle}
        title={prompts.length > 0 ? `Prompts (${prompts.length})` : 'Prompts'}
        style={{ ...buttonStyle, position: 'relative', background: open ? 'var(--bg-hover)' : (buttonStyle.background ?? 'transparent'), color: open ? 'var(--text-primary)' : buttonStyle.color }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={(e) => { if (!open) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; } }}
      >
        <PromptIcon size={14} />{!collapsed && 'Prompts'}
        {prompts.length > 0 && (
          <span style={{
            position: 'absolute', top: collapsed ? -2 : 4, right: collapsed ? -2 : 8,
            fontSize: 9, fontWeight: 700, lineHeight: '13px', minWidth: 13, height: 13,
            padding: '0 3px', borderRadius: 7, textAlign: 'center', boxSizing: 'border-box',
            background: 'var(--bg-hover)', color: 'var(--text-secondary, var(--text-muted))',
            border: '1px solid var(--border)',
          }}>{prompts.length}</span>
        )}
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
            position: 'fixed', left: pos.left, top: pos.top, zIndex: 9100, width: POPOVER_W,
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
        >
          <style>{`.prompt-row:hover{background:var(--bg-hover);}`}</style>
          <div style={{
            padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
            borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>Prompts</span>
            <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>click = paste · ▶ = run</span>
          </div>

          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {prompts.length === 0 && editingId === null && (
              <div style={{ padding: '12px', fontSize: 11, color: 'var(--text-muted)' }}>
                Save reusable prompts here and paste them into any terminal.
              </div>
            )}
            {prompts.map(renderRow)}
          </div>

          {/* Editor — add a new prompt or edit an existing one. */}
          {editingId !== null ? (
            <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={sectionLabel}>{editingId ? 'Edit prompt' : 'New prompt'}</div>
              <input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Title (optional)"
                style={inputStyle}
                autoFocus
              />
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveDraft(); }
                  if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
                }}
                placeholder="Prompt text…  (⌘/Ctrl+Enter to save)"
                rows={4}
                style={{ ...inputStyle, resize: 'vertical', minHeight: 64, lineHeight: 1.45, fontFamily: 'inherit' }}
              />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  onClick={closeEditor}
                  style={{
                    padding: '0 10px', height: 28, fontSize: 12, borderRadius: 6,
                    border: '1px solid var(--border)', background: 'transparent',
                    color: 'var(--text-muted)', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={saveDraft}
                  disabled={!draftBody.trim()}
                  style={{
                    padding: '0 12px', height: 28, fontSize: 12, fontWeight: 600, borderRadius: 6,
                    border: '1px solid var(--border)', background: 'var(--bg-hover)',
                    color: 'var(--text-primary)', cursor: draftBody.trim() ? 'pointer' : 'default',
                    opacity: draftBody.trim() ? 1 : 0.5,
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px' }}>
              <button
                onClick={startNew}
                style={{
                  width: '100%', height: 30, fontSize: 12, fontWeight: 600, borderRadius: 6,
                  border: '1px dashed var(--border)', background: 'transparent',
                  color: 'var(--text-muted)', cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
              >
                + New prompt
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
};
