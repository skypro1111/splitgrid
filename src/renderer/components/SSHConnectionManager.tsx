import React, { useState, useEffect, useRef } from 'react';
import type { SSHConnectionConfig, SavedConnection } from '../../shared/types';
import { TEMP_DISABLE_INPUT_INTERCEPTS } from '../../shared/runtime-flags';
import { ConnectionEditorModal } from './ConnectionEditorModal';
import { groupConnections, useConnectionGroups } from '../hooks/useConnectionGroups';

// Settings → SSH. A MANAGEMENT surface only: add, edit, test and delete saved
// connections. It does NOT launch sessions — connecting happens from a terminal
// container's SSH picker, never from Settings. Create/edit reuse the shared
// premium ConnectionEditorModal so the form is identical everywhere.
// Connections can be filed into named groups: collapsible sections whose fold
// state is remembered (shared with the SSH/SFTP pickers). A connection is moved
// by dragging it onto a group header, or via the Group field in the editor.

// Drag payload type for moving a connection row between groups.
const DRAG_TYPE = 'application/x-splitgrid-connection';

interface SSHConnectionManagerProps {
  savedConnections: SavedConnection[];
  onSave: (config: Omit<SSHConnectionConfig, 'id'>) => Promise<SavedConnection>;
  onUpdate: (id: string, config: Omit<SSHConnectionConfig, 'id'>) => Promise<SavedConnection>;
  onDelete: (id: string) => Promise<void>;
  onDuplicate: (id: string) => Promise<SavedConnection>;
  onTest: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
  /** Render as inline panel content (no overlay / close button) for the Settings tab. */
  embedded?: boolean;
}

const btnBase: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: '5px',
  fontSize: '12px',
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
};

export const SSHConnectionManager: React.FC<SSHConnectionManagerProps> = ({
  savedConnections,
  onSave,
  onUpdate,
  onDelete,
  onDuplicate,
  onTest,
  onClose,
  embedded = false,
}) => {
  const [editor, setEditor] = useState<{ connection: SavedConnection | null; group?: string } | null>(null);
  const { groups, collapsed, setCollapsed, createGroup, renameGroup, deleteGroup, moveToGroup } = useConnectionGroups();
  // Inline "new group" input at the top of the list (null = hidden).
  const [newGroup, setNewGroup] = useState<string | null>(null);
  // Group header currently under a dragged row ('' = the Ungrouped section).
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    if (TEMP_DISABLE_INPUT_INTERCEPTS) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editor) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor, onClose]);

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const result = await onTest(id);
      setTestResult((prev) => ({ ...prev, [id]: result }));
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [id]: { ok: false, error: (err as Error).message } }));
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await onDelete(id);
    } catch (err) {
      setError((err as Error).message || 'Failed to delete');
    }
  };

  // Copy, then open the copy in the editor — a duplicate usually differs in a
  // field or two (host, user), and the copy keeps the original's secrets.
  const handleDuplicate = async (id: string) => {
    setError('');
    try {
      const copy = await onDuplicate(id);
      setEditor({ connection: copy });
    } catch (err) {
      setError((err as Error).message || 'Failed to duplicate');
    }
  };

  // Run a group mutation, surfacing a failure in the error banner.
  const runGroupOp = async (op: () => Promise<void>) => {
    setError('');
    try {
      await op();
    } catch (err) {
      setError((err as Error).message || 'Failed to update groups');
    }
  };

  const submitNewGroup = async () => {
    const name = (newGroup ?? '').trim();
    setNewGroup(null);
    if (name) await runGroupOp(() => createGroup(name));
  };

  const sections = groupConnections(savedConnections, groups, true);
  const hasGroups = groups.length > 0;

  // Drop-target props for a group header (null = Ungrouped).
  const dropProps = (group: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(group ?? '');
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
    },
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(null);
      if (!id) return;
      e.preventDefault();
      void runGroupOp(() => moveToGroup([id], group));
    },
  });

  const renderRow = (conn: SavedConnection) => (
    <ConnectionRow
      key={conn.id}
      conn={conn}
      testing={testingId === conn.id}
      testResult={testResult[conn.id]}
      onEdit={() => setEditor({ connection: conn })}
      onTest={() => handleTest(conn.id)}
      onDuplicate={() => handleDuplicate(conn.id)}
      onDelete={() => handleDelete(conn.id)}
    />
  );

  return (
    <div
      onClick={embedded ? undefined : (e) => { if (e.target === e.currentTarget) onClose(); }}
      style={embedded
        ? { width: '100%', height: '100%', display: 'flex' }
        : {
            position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', zIndex: 1000,
          }}
    >
      <div style={embedded
        ? { background: 'var(--bg-surface)', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
        : {
            background: 'var(--bg-surface)', borderRadius: '12px',
            width: '520px', maxHeight: '85vh', display: 'flex', flexDirection: 'column',
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)', overflow: 'hidden',
          }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px 12px', borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            SSH Connections
          </h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setNewGroup('')}
              title="Create a group to organize connections"
              style={{ ...btnBase, background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
            >+ Group</button>
            <button
              onClick={() => setEditor({ connection: null })}
              style={{ ...btnBase, background: 'var(--accent)', color: 'var(--bg-primary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
            >+ Add</button>
            {!embedded && (
              <button
                onClick={onClose}
                style={{ ...btnBase, padding: '4px 10px', background: 'transparent', color: 'var(--text-muted)', fontSize: '18px' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
              >&times;</button>
            )}
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div style={{ padding: '8px 20px', background: 'rgba(241,76,76,0.08)', color: 'var(--accent-red)', fontSize: '12px', borderBottom: '1px solid var(--border)' }}>
            {error}
          </div>
        )}

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {newGroup !== null && (
            <div style={{ padding: '4px 4px 10px' }}>
              <InlineNameInput
                value={newGroup}
                placeholder="New group name"
                onChange={setNewGroup}
                onSubmit={() => { void submitNewGroup(); }}
                onCancel={() => setNewGroup(null)}
              />
            </div>
          )}
          {savedConnections.length === 0 && !hasGroups ? (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>No saved connections</div>
              <button onClick={() => setEditor({ connection: null })} style={{ ...btnBase, background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                Add your first connection
              </button>
            </div>
          ) : !hasGroups ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {savedConnections.map(renderRow)}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {sections.map((sec) => sec.name !== null && (
                <div key={sec.name}>
                  <GroupHeader
                    name={sec.name}
                    count={sec.connections.length}
                    collapsed={collapsed.has(sec.name)}
                    dropActive={dropTarget === sec.name}
                    dropProps={dropProps(sec.name)}
                    onToggle={() => setCollapsed(sec.name!, !collapsed.has(sec.name!))}
                    onAdd={() => setEditor({ connection: null, group: sec.name! })}
                    onRename={(to) => runGroupOp(() => renameGroup(sec.name!, to))}
                    onDelete={() => runGroupOp(() => deleteGroup(sec.name!))}
                  />
                  {!collapsed.has(sec.name) && (
                    sec.connections.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '14px' }}>
                        {sec.connections.map(renderRow)}
                      </div>
                    ) : (
                      <div style={{ padding: '6px 12px 6px 34px', fontSize: '11px', color: 'var(--text-muted)' }}>
                        Empty — drag connections here
                      </div>
                    )
                  )}
                </div>
              ))}
              <div>
                <div
                  {...dropProps(null)}
                  style={{
                    ...groupHeaderStyle,
                    cursor: 'default',
                    background: dropTarget === '' ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                    outline: dropTarget === '' ? '1px dashed var(--accent)' : 'none',
                  }}
                >
                  <span style={{ width: '12px' }} />
                  <span style={{ flex: 1 }}>Ungrouped</span>
                  <span style={{ opacity: 0.6, fontWeight: 500 }}>{sections.find((x) => x.name === null)?.connections.length ?? 0}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '14px' }}>
                  {(sections.find((x) => x.name === null)?.connections ?? []).map(renderRow)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {editor && (
        <ConnectionEditorModal
          connection={editor.connection}
          groups={groups}
          defaultGroup={editor.group}
          onSave={onSave}
          onUpdate={onUpdate}
          onDone={() => setEditor(null)}
          onCancel={() => setEditor(null)}
        />
      )}
    </div>
  );
};

// --- Group header ---
const groupHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderRadius: '6px',
  fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.5px', userSelect: 'none', cursor: 'pointer',
};

const GroupHeader: React.FC<{
  name: string;
  count: number;
  collapsed: boolean;
  dropActive: boolean;
  dropProps: Pick<React.HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  onToggle: () => void;
  onAdd: () => void;
  onRename: (to: string) => Promise<void>;
  onDelete: () => Promise<void>;
}> = ({ name, count, collapsed, dropActive, dropProps, onToggle, onAdd, onRename, onDelete }) => {
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const smallBtn: React.CSSProperties = {
    padding: '2px 7px', borderRadius: '4px', fontSize: '11px', fontWeight: 500, textTransform: 'none',
    letterSpacing: 0, border: 'none', cursor: 'pointer', background: 'var(--bg-hover)', color: 'var(--text-secondary)',
  };

  if (renaming !== null) {
    const submit = () => {
      const to = renaming.trim();
      setRenaming(null);
      if (to && to !== name) void onRename(to);
    };
    return (
      <div style={{ padding: '2px 4px' }}>
        <InlineNameInput value={renaming} placeholder="Group name" onChange={setRenaming} onSubmit={submit} onCancel={() => setRenaming(null)} />
      </div>
    );
  }

  return (
    <div
      {...dropProps}
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setConfirmDelete(false); }}
      role="button"
      aria-expanded={!collapsed}
      style={{
        ...groupHeaderStyle,
        background: dropActive
          ? 'color-mix(in srgb, var(--accent) 14%, transparent)'
          : hovered ? 'var(--bg-hover)' : 'transparent',
        outline: dropActive ? '1px dashed var(--accent)' : 'none',
      }}
    >
      <span style={{ display: 'inline-block', width: '12px', transition: 'transform 0.12s', transform: collapsed ? 'rotate(-90deg)' : 'none' }}>▾</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{name}</span>
      {hovered ? (
        <div style={{ display: 'flex', gap: '4px' }} onClick={(e) => e.stopPropagation()}>
          <button onClick={onAdd} title="Add a connection to this group" style={smallBtn}>+ Add</button>
          <button onClick={() => setRenaming(name)} style={smallBtn}>Rename</button>
          {confirmDelete ? (
            <button
              onClick={() => { setConfirmDelete(false); void onDelete(); }}
              title="Connections in this group become ungrouped"
              style={{ ...smallBtn, background: 'var(--accent-red)', color: 'var(--bg-primary)' }}
            >Ungroup all</button>
          ) : (
            <button onClick={() => setConfirmDelete(true)} style={{ ...smallBtn, color: 'var(--accent-red)' }}>Delete</button>
          )}
        </div>
      ) : (
        <span style={{ opacity: 0.6, fontWeight: 500 }}>{count}</span>
      )}
    </div>
  );
};

// Small text field for naming a group: Enter / blur submit, Escape cancels.
const InlineNameInput: React.FC<{
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}> = ({ value, placeholder, onChange, onSubmit, onCancel }) => {
  // The input unmounts on submit/cancel and may still emit a blur: settle once.
  const settled = useRef(false);
  const settle = (fn: () => void) => {
    if (settled.current) return;
    settled.current = true;
    fn();
  };
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); settle(onSubmit); }
        // Keep Escape from also closing Settings (window-level handlers).
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); settle(onCancel); }
      }}
      onBlur={() => settle(onSubmit)}
      style={{
        width: '100%', padding: '6px 10px', borderRadius: '6px', fontSize: '12px', outline: 'none',
        background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--accent)',
      }}
    />
  );
};

// --- Connection row in list ---
const ConnectionRow: React.FC<{
  conn: SavedConnection;
  testing: boolean;
  testResult?: { ok: boolean; error?: string };
  onEdit: () => void;
  onTest: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}> = ({ conn, testing, testResult, onEdit, onTest, onDuplicate, onDelete }) => {
  const [hovered, setHovered] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // "Enable mouse scroll on this host": writes SplitGrid's managed block into the
  // remote ~/.tmux.conf & ~/.screenrc. idle → applying → done | error.
  const [mouse, setMouse] = useState<{ state: 'idle' | 'applying' | 'done' | 'error'; error?: string }>({ state: 'idle' });

  const applyMouseScroll = async () => {
    setMouse({ state: 'applying' });
    try {
      const r = await window.electronAPI.applyMouseScrollToHost(conn.id);
      setMouse(r.ok ? { state: 'done' } : { state: 'error', error: r.error || 'Failed' });
    } catch (err) {
      setMouse({ state: 'error', error: (err as Error).message });
    }
  };

  const rowBtnStyle: React.CSSProperties = {
    padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 500,
    border: 'none', cursor: 'pointer', background: 'var(--bg-hover)', color: 'var(--text-secondary)',
    whiteSpace: 'nowrap',
  };

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, conn.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setConfirmDelete(false); }}
      style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 12px', borderRadius: '6px',
        background: hovered ? 'var(--bg-hover)' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      {/* Status dot */}
      <div style={{
        width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
        background: testResult ? (testResult.ok ? '#15ac91' : '#f14c4c') : 'var(--border)',
        transition: 'background 0.2s',
      }} />

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {conn.label}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>
          {conn.username}@{conn.host}:{conn.port}
          <span style={{ marginLeft: '8px', opacity: 0.6 }}>
            {conn.authMethod === 'privateKey' ? 'key' : 'password'}
          </span>
        </div>
        {testResult && !testResult.ok && (
          <div style={{ fontSize: '10px', color: 'var(--accent-red)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {testResult.error}
          </div>
        )}
        {mouse.state === 'error' && mouse.error && (
          <div style={{ fontSize: '10px', color: 'var(--accent-red)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {mouse.error}
          </div>
        )}
      </div>

      {/* Actions */}
      {hovered && (
        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
          <button
            onClick={applyMouseScroll}
            disabled={mouse.state === 'applying'}
            title="Enable mouse-wheel scrolling for tmux/screen on this host (writes a managed block to the remote ~/.tmux.conf & ~/.screenrc). Reopen tmux/screen to apply."
            style={{ ...rowBtnStyle, opacity: mouse.state === 'applying' ? 0.6 : 1, color: mouse.state === 'done' ? '#15ac91' : rowBtnStyle.color }}
          >
            {mouse.state === 'applying' ? 'Applying…' : mouse.state === 'done' ? 'Mouse ✓' : 'Mouse scroll'}
          </button>
          <button onClick={onTest} disabled={testing} style={{ ...rowBtnStyle, opacity: testing ? 0.6 : 1 }}>
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button onClick={onEdit} style={rowBtnStyle}>Edit</button>
          <button onClick={onDuplicate} title="Copy this connection (password and key included)" style={rowBtnStyle}>Duplicate</button>
          {confirmDelete ? (
            <button
              onClick={() => { onDelete(); setConfirmDelete(false); }}
              style={{ ...rowBtnStyle, background: 'var(--accent-red)', color: 'var(--bg-primary)' }}
            >Confirm</button>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{ ...rowBtnStyle, color: 'var(--accent-red)' }}
            >Delete</button>
          )}
        </div>
      )}
    </div>
  );
};
