import React, { useState, useEffect } from 'react';
import type { SSHConnectionConfig, SavedConnection } from '../../shared/types';
import { TEMP_DISABLE_INPUT_INTERCEPTS } from '../../shared/runtime-flags';
import { ConnectionEditorModal } from './ConnectionEditorModal';

// Settings → SSH. A MANAGEMENT surface only: add, edit, test and delete saved
// connections. It does NOT launch sessions — connecting happens from a terminal
// container's SSH picker, never from Settings. Create/edit reuse the shared
// premium ConnectionEditorModal so the form is identical everywhere.

interface SSHConnectionManagerProps {
  savedConnections: SavedConnection[];
  onSave: (config: Omit<SSHConnectionConfig, 'id'>) => Promise<SavedConnection>;
  onUpdate: (id: string, config: Omit<SSHConnectionConfig, 'id'>) => Promise<SavedConnection>;
  onDelete: (id: string) => Promise<void>;
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
  onTest,
  onClose,
  embedded = false,
}) => {
  const [editor, setEditor] = useState<{ connection: SavedConnection | null } | null>(null);
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
          {savedConnections.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>No saved connections</div>
              <button onClick={() => setEditor({ connection: null })} style={{ ...btnBase, background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                Add your first connection
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {savedConnections.map((conn) => (
                <ConnectionRow
                  key={conn.id}
                  conn={conn}
                  testing={testingId === conn.id}
                  testResult={testResult[conn.id]}
                  onEdit={() => setEditor({ connection: conn })}
                  onTest={() => handleTest(conn.id)}
                  onDelete={() => handleDelete(conn.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {editor && (
        <ConnectionEditorModal
          connection={editor.connection}
          onSave={onSave}
          onUpdate={onUpdate}
          onDone={() => setEditor(null)}
          onCancel={() => setEditor(null)}
        />
      )}
    </div>
  );
};

// --- Connection row in list ---
const ConnectionRow: React.FC<{
  conn: SavedConnection;
  testing: boolean;
  testResult?: { ok: boolean; error?: string };
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}> = ({ conn, testing, testResult, onEdit, onTest, onDelete }) => {
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
