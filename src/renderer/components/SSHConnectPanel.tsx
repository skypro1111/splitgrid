import React, { useState } from 'react';
import { SplitHorizontalIcon, SplitVerticalIcon } from './Icons';
import { ConnectionSelector } from './ConnectionSelector';
import { ConnectionEditorModal } from './ConnectionEditorModal';
import type { SSHConnectionConfig, SavedConnection } from '../../shared/types';
import { parseHostKeyChange, type HostKeyChange } from '../../shared/host-key';

// Embedded (in-container) SSH connection picker — the same surface as the SFTP
// pane's chooser, replacing the old full-screen NewSessionDialog modal. Lives
// as the 'ssh-connect' container content type: choosing a saved connection
// connects a terminal and swaps the container to it. Creating a connection is
// still delegated to the shared ConnectionEditorModal (a form, like Settings).

interface SSHConnectPanelProps {
  savedConnections: SavedConnection[];
  /** Connection ids used in this workspace, most-recent-first. */
  recentConnectionIds: string[];
  onConnect: (savedId: string) => Promise<void>;
  onCreateConnection: (config: Omit<SSHConnectionConfig, 'id'>) => Promise<SavedConnection>;
  onDeleteSaved: (id: string) => Promise<void>;
  /** Close the container entirely (red dot). */
  onClose: () => void;
  /** Go back to the empty content-type picker (Cancel). */
  onBackToEmpty: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
}

export const SSHConnectPanel: React.FC<SSHConnectPanelProps> = ({
  savedConnections,
  recentConnectionIds,
  onConnect,
  onCreateConnection,
  onDeleteSaved,
  onClose,
  onBackToEmpty,
  onSplitRight,
  onSplitDown,
}) => {
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showEditor, setShowEditor] = useState(false);
  const [createdIds, setCreatedIds] = useState<string[]>([]);
  // When the server's host key differs from the pinned one, we don't fail with a
  // bare error — we surface both fingerprints and let the user accept the change.
  const [hostKeyPrompt, setHostKeyPrompt] = useState<{ change: HostKeyChange; savedId: string } | null>(null);

  const handleConnect = async (savedId: string) => {
    setError('');
    setHostKeyPrompt(null);
    setConnectingId(savedId);
    try {
      await onConnect(savedId);
    } catch (err) {
      const msg = (err as Error).message || 'Connection failed';
      const change = parseHostKeyChange(msg);
      // A changed host key gets the review-and-accept prompt; anything else is a
      // plain error banner.
      if (change) setHostKeyPrompt({ change, savedId });
      else setError(msg);
      setConnectingId(null);
    }
  };

  // User reviewed the new fingerprint and chose to trust it: drop the stale
  // pinned key (so the next connect re-pins the current one) and retry.
  const acceptNewHostKey = async () => {
    if (!hostKeyPrompt) return;
    const { change, savedId } = hostKeyPrompt;
    try {
      await window.electronAPI.forgetHostKey(change.host, change.port);
    } catch (err) {
      setHostKeyPrompt(null);
      setError((err as Error).message || 'Could not update the stored host key.');
      return;
    }
    setHostKeyPrompt(null);
    await handleConnect(savedId);
  };

  const empty = savedConnections.length === 0;

  const iconBtnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '20px', height: '20px', borderRadius: '4px', background: 'transparent',
    border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border)', overflow: 'hidden' }}>
      {/* Title bar */}
      <div
        className="container-drag-handle"
        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 10px', height: '32px', minHeight: '32px', background: 'var(--bg-titlebar)', borderBottom: '1px solid var(--border)', userSelect: 'none', cursor: 'grab' }}
      >
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
          title="Close"
          style={{ width: '12px', height: '12px', borderRadius: '50%', background: 'var(--accent-red)', border: 'none', cursor: 'pointer', flexShrink: 0, opacity: 0.7 }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
        />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, flex: 1 }}>Connect over SSH</span>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={onSplitRight} title="Split right" style={iconBtnStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <SplitHorizontalIcon size={14} />
        </button>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={onSplitDown} title="Split down" style={iconBtnStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <SplitVerticalIcon size={14} />
        </button>
      </div>

      {/* Header */}
      <div style={{ padding: '16px 16px 10px', textAlign: 'center', flexShrink: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 700 }}>Connect over SSH</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Pick a saved connection to open in this container</div>
      </div>

      {error && (
        <div style={{ margin: '0 16px 10px', padding: '8px 11px', borderRadius: 8, background: 'rgba(241,76,76,0.10)', color: 'var(--accent-red)', fontSize: 12, flexShrink: 0 }}>
          {error}
        </div>
      )}

      {hostKeyPrompt && (
        <div style={{ margin: '0 16px 10px', padding: '12px 14px', borderRadius: 8, background: 'rgba(241,76,76,0.08)', border: '1px solid rgba(241,76,76,0.35)', flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-red)', marginBottom: 6 }}>
            ⚠ Host key changed for {hostKeyPrompt.change.host}:{hostKeyPrompt.change.port}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>
            The server is presenting a different key than the one pinned when you first connected.
            This is normal if the server was reinstalled or its SSH keys were rotated — but it can
            also mean the connection is being intercepted. Only continue if you trust this change.
          </div>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10.5, wordBreak: 'break-all',
          }}>
            <div style={{ color: 'var(--text-muted)' }}>
              Pinned <span style={{ color: 'var(--text-secondary)' }}>{hostKeyPrompt.change.expected}</span>
            </div>
            <div style={{ color: 'var(--text-muted)' }}>
              New <span style={{ color: 'var(--text-primary)' }}>{hostKeyPrompt.change.actual}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={acceptNewHostKey} disabled={!!connectingId} style={dangerBtnStyle}>
              Accept new key &amp; reconnect
            </button>
            <button onClick={() => setHostKeyPrompt(null)} style={ghostBtnStyle}>Cancel</button>
          </div>
        </div>
      )}

      {/* Body */}
      {empty ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No saved connections yet.</div>
          <button onClick={() => setShowEditor(true)} style={primaryBtnStyle}>+ New connection</button>
        </div>
      ) : (
        <ConnectionSelector
          savedConnections={savedConnections}
          recentConnectionIds={recentConnectionIds}
          onSelect={(c) => handleConnect(c.id)}
          connectingId={connectingId}
          pinnedIds={createdIds}
          onDelete={(c) => { void onDeleteSaved(c.id); }}
        />
      )}

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 16px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button onClick={() => setShowEditor(true)} style={ghostBtnStyle}>+ New connection</button>
        <button onClick={onBackToEmpty} style={ghostBtnStyle}>Cancel</button>
      </div>

      {showEditor && (
        <ConnectionEditorModal
          onSave={onCreateConnection}
          onDone={(saved) => {
            setCreatedIds((prev) => [saved.id, ...prev.filter((id) => id !== saved.id)]);
            setShowEditor(false);
          }}
          onCancel={() => setShowEditor(false)}
        />
      )}
    </div>
  );
};

const ghostBtnStyle: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 9, border: '1px solid var(--border)',
  background: 'var(--bg-primary)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '9px 18px', borderRadius: 9, border: 'none',
  background: 'var(--accent)', color: 'var(--bg-primary)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
};

const dangerBtnStyle: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 9, border: 'none',
  background: 'var(--accent-red)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer',
};
