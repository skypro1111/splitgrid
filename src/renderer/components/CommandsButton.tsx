import React, { useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { v4 as uuidv4 } from 'uuid';
import type { SavedCommand, RecentCommand } from '../../shared/types';

// Terminal commands popover, pinned in the sidebar's bottom bar next to the
// env-todos button. Surfaces a heuristically-captured "recent" feed plus
// favorites at two binding levels — the active workspace and the whole
// environment (workspace set). Clicking a command pastes it into the focused
// terminal (no auto-run); the hover ▶ runs it. Mirrors <EnvTodoButton>.

const POPOVER_W = 340;
const POPOVER_EST_H = 420;

type Level = 'workspace' | 'env';

function anchor(el: HTMLElement): { left: number; top: number } {
  const r = el.getBoundingClientRect();
  const top = Math.max(8, Math.min(r.top, window.innerHeight - POPOVER_EST_H - 8));
  return { left: r.right + 8, top };
}

const PromptIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M4.5 6.5 7 8.5 4.5 10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.5 10.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const PlayIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden>
    <path d="M3 2.2v7.6a.5.5 0 0 0 .77.42l6-3.8a.5.5 0 0 0 0-.84l-6-3.8A.5.5 0 0 0 3 2.2Z" />
  </svg>
);

interface Props {
  recent: RecentCommand[];
  envFavorites: SavedCommand[];
  workspaceFavorites: SavedCommand[];
  workspaceName: string;
  collapsed: boolean;
  buttonStyle: React.CSSProperties;
  /** Paste (execute=false) or paste+Enter (execute=true) into the focused terminal. */
  onRun: (command: string, execute: boolean) => void;
  onUpdateEnvFavorites: (updater: (f: SavedCommand[]) => SavedCommand[]) => void;
  onUpdateWorkspaceFavorites: (updater: (f: SavedCommand[]) => SavedCommand[]) => void;
  onRemoveRecent: (command: string) => void;
  onClearRecent: () => void;
}

const iconBtn: React.CSSProperties = {
  flexShrink: 0, width: 22, height: 20, padding: 0, display: 'flex',
  alignItems: 'center', justifyContent: 'center', borderRadius: 4,
  border: '1px solid transparent', background: 'transparent',
  color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, lineHeight: 1,
};

const cmdText: React.CSSProperties = {
  flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.4, cursor: 'pointer',
  fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  color: 'var(--text-primary)',
};

const sectionLabel: React.CSSProperties = {
  padding: '8px 12px 4px', fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
  textTransform: 'uppercase', color: 'var(--text-muted)',
};

export const CommandsButton: React.FC<Props> = ({
  recent, envFavorites, workspaceFavorites, workspaceName, collapsed, buttonStyle,
  onRun, onUpdateEnvFavorites, onUpdateWorkspaceFavorites, onRemoveRecent, onClearRecent,
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [draft, setDraft] = useState('');
  const [draftLevel, setDraftLevel] = useState<Level>('workspace');

  const favCount = envFavorites.length + workspaceFavorites.length;
  const favoritedSet = useMemo(
    () => new Set([...envFavorites, ...workspaceFavorites].map((f) => f.command)),
    [envFavorites, workspaceFavorites]
  );

  const toggle = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    setOpen((cur) => {
      if (cur) return false;
      setPos(anchor(el));
      return true;
    });
  }, []);

  const updaterFor = useCallback(
    (level: Level) => (level === 'env' ? onUpdateEnvFavorites : onUpdateWorkspaceFavorites),
    [onUpdateEnvFavorites, onUpdateWorkspaceFavorites]
  );

  const addFavorite = useCallback((level: Level, command: string, label?: string) => {
    const cmd = command.trim();
    if (!cmd) return;
    updaterFor(level)((list) =>
      list.some((f) => f.command === cmd)
        ? list
        : [...list, { id: uuidv4(), command: cmd, label: label?.trim() || undefined, createdAt: Date.now() }]
    );
  }, [updaterFor]);

  const removeFavorite = useCallback((level: Level, id: string) => {
    updaterFor(level)((list) => list.filter((f) => f.id !== id));
  }, [updaterFor]);

  // Paste (and optionally run); then close so the terminal regains focus.
  const run = useCallback((command: string, execute: boolean) => {
    onRun(command, execute);
    setOpen(false);
  }, [onRun]);

  const submitDraft = useCallback(() => {
    const cmd = draft.trim();
    if (!cmd) return;
    addFavorite(draftLevel, cmd);
    setDraft('');
  }, [draft, draftLevel, addFavorite]);

  const renderFavoriteRow = (f: SavedCommand, level: Level) => (
    <div
      key={f.id}
      className="cmd-row"
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px' }}
    >
      <span
        onClick={() => run(f.command, false)}
        title={`${f.command}\n\nClick to paste · ▶ to run`}
        style={cmdText}
      >
        {f.label ? (
          <>
            {f.label}
            <span style={{ marginLeft: 6, color: 'var(--text-muted)', fontSize: 11 }}>{f.command}</span>
          </>
        ) : f.command}
      </span>
      <button
        onClick={() => run(f.command, true)}
        title="Run (paste + Enter)"
        style={iconBtn}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-green, #15ac91)'; e.currentTarget.style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
      >
        <PlayIcon />
      </button>
      <button
        onClick={() => removeFavorite(level, f.id)}
        title="Remove favorite"
        style={{ ...iconBtn, fontSize: 14 }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-red, #f14c4c)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        ×
      </button>
    </div>
  );

  const pillBtn = (active: boolean): React.CSSProperties => ({
    flexShrink: 0, padding: '0 8px', height: 26, fontSize: 11, fontWeight: 600,
    borderRadius: 6, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--accent-green, #15ac91)' : 'var(--border)'}`,
    background: active ? 'var(--accent-green, #15ac91)' : 'transparent',
    color: active ? '#0b1f1a' : 'var(--text-muted)',
  });

  return (
    <>
      <button
        onClick={toggle}
        title={favCount > 0 ? `Commands (${favCount} favorite${favCount === 1 ? '' : 's'})` : 'Commands'}
        style={{ ...buttonStyle, position: 'relative', background: open ? 'var(--bg-hover)' : (buttonStyle.background ?? 'transparent'), color: open ? 'var(--text-primary)' : buttonStyle.color }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={(e) => { if (!open) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; } }}
      >
        <PromptIcon size={14} />{!collapsed && 'Commands'}
        {favCount > 0 && (
          <span style={{
            position: 'absolute', top: collapsed ? -2 : 4, right: collapsed ? -2 : 8,
            fontSize: 9, fontWeight: 700, lineHeight: '13px', minWidth: 13, height: 13,
            padding: '0 3px', borderRadius: 7, textAlign: 'center', boxSizing: 'border-box',
            background: 'var(--bg-hover)', color: 'var(--text-secondary, var(--text-muted))',
            border: '1px solid var(--border)',
          }}>{favCount}</span>
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
          <style>{`.cmd-row:hover{background:var(--bg-hover);}`}</style>
          <div style={{
            padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
            borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>Commands</span>
            <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>click = paste · ▶ = run</span>
          </div>

          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {favCount > 0 && <div style={sectionLabel}>★ Favorites</div>}
            {workspaceFavorites.length > 0 && (
              <>
                <div style={{ ...sectionLabel, padding: '2px 12px', fontSize: 9, opacity: 0.85 }}>
                  {workspaceName || 'This workspace'}
                </div>
                {workspaceFavorites.map((f) => renderFavoriteRow(f, 'workspace'))}
              </>
            )}
            {envFavorites.length > 0 && (
              <>
                <div style={{ ...sectionLabel, padding: '2px 12px', fontSize: 9, opacity: 0.85 }}>Environment</div>
                {envFavorites.map((f) => renderFavoriteRow(f, 'env'))}
              </>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={sectionLabel}>Recent</div>
              {recent.length > 0 && (
                <button
                  onClick={onClearRecent}
                  style={{ ...iconBtn, width: 'auto', padding: '0 8px', fontSize: 10 }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                >
                  Clear
                </button>
              )}
            </div>
            {recent.length === 0 && (
              <div style={{ padding: '6px 12px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
                Commands you run in terminals show up here.
              </div>
            )}
            {recent.map((r) => (
              <div
                key={r.command}
                className="cmd-row"
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px' }}
              >
                <span onClick={() => run(r.command, false)} title={`${r.command}\n\nClick to paste · ▶ to run`} style={cmdText}>
                  {r.command}
                </span>
                <button
                  onClick={() => run(r.command, true)}
                  title="Run (paste + Enter)"
                  style={iconBtn}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-green, #15ac91)'; e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
                >
                  <PlayIcon />
                </button>
                <button
                  onClick={() => addFavorite('workspace', r.command)}
                  title="Save to workspace favorites"
                  style={{ ...iconBtn, fontWeight: 700, color: favoritedSet.has(r.command) ? 'var(--accent-amber, #e0a23a)' : 'var(--text-muted)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-amber, #e0a23a)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = favoritedSet.has(r.command) ? 'var(--accent-amber, #e0a23a)' : 'var(--text-muted)'; }}
                >
                  W
                </button>
                <button
                  onClick={() => addFavorite('env', r.command)}
                  title="Save to environment favorites"
                  style={{ ...iconBtn, fontWeight: 700, color: favoritedSet.has(r.command) ? 'var(--accent-amber, #e0a23a)' : 'var(--text-muted)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-amber, #e0a23a)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = favoritedSet.has(r.command) ? 'var(--accent-amber, #e0a23a)' : 'var(--text-muted)'; }}
                >
                  E
                </button>
                <button
                  onClick={() => onRemoveRecent(r.command)}
                  title="Remove from recent"
                  style={{ ...iconBtn, fontSize: 14 }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-red, #f14c4c)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {/* Manual add — level toggle + input. */}
          <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setDraftLevel('workspace')} style={pillBtn(draftLevel === 'workspace')} title="Save to this workspace">W</button>
              <button onClick={() => setDraftLevel('env')} style={pillBtn(draftLevel === 'env')} title="Save to the whole environment">E</button>
              <span style={{ alignSelf: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
                {draftLevel === 'workspace' ? (workspaceName || 'This workspace') : 'Environment'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitDraft(); } }}
                placeholder="Add a favorite command…  (Enter)"
                style={{
                  flex: 1, boxSizing: 'border-box', padding: '6px 8px', fontSize: 12,
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  background: 'var(--bg-input, var(--bg-base))', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 6, outline: 'none',
                }}
              />
              <button
                onClick={submitDraft}
                disabled={!draft.trim()}
                style={{
                  flexShrink: 0, padding: '0 10px', fontSize: 12, borderRadius: 6,
                  border: '1px solid var(--border)', background: 'var(--bg-hover)',
                  color: 'var(--text-primary)', cursor: draft.trim() ? 'pointer' : 'default',
                  opacity: draft.trim() ? 1 : 0.5,
                }}
              >
                Add
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
