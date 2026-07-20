import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SplitHorizontalIcon, SplitVerticalIcon } from './Icons';
import { RemoteFileTable } from './sftp/RemoteFileTable';
import { LocalFileTable } from './sftp/LocalFileTable';
import { RemoteFileEditor } from './sftp/RemoteFileEditor';
import { ConnectionSelector } from './ConnectionSelector';
import { joinRemote } from '../../shared/sftp-format';
import { joinLocal, type LocalSep } from '../../shared/local-path';
import type {
  SavedConnection,
  ContainerContent,
  SftpTarget,
  RemoteDirEntry,
  SftpTransferProgress,
} from '../../shared/types';

interface SFTPPanelProps {
  containerId: string;
  workspaceId: string;
  content: ContainerContent;
  /** Connection ids used in this workspace, most-recent-first. */
  recentConnectionIds: string[];
  /** Record that a connection was used here (floats it to the top of recents). */
  onRecordConnectionUse?: (connectionId: string) => void;
  /** Workspace root folder — the default starting dir for the local pane. */
  workspaceRootPath?: string | null;
  /** Per-container zoom level (Cmd/Ctrl +/-); scales the file tables. */
  zoomLevel?: number;
  onContentChange: (content: ContainerContent) => void;
  onClose: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
}

type ConnStatus = 'connecting' | 'ready' | 'error';

export const SFTPPanel: React.FC<SFTPPanelProps> = ({
  containerId,
  workspaceId,
  content,
  recentConnectionIds,
  onRecordConnectionUse,
  workspaceRootPath,
  zoomLevel,
  onContentChange,
  onClose,
  onSplitRight,
  onSplitDown,
}) => {
  const [conns, setConns] = useState<SavedConnection[]>([]);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [error, setError] = useState<string>('');
  const [remotePath, setRemotePath] = useState<string>(content.sftpRemotePath ?? '');
  const [localPath, setLocalPath] = useState<string>(content.sftpLocalPath ?? '');

  // Cross-pane transfer state.
  const [localSelection, setLocalSelection] = useState<RemoteDirEntry[]>([]);
  const [remoteSelection, setRemoteSelection] = useState<RemoteDirEntry[]>([]);
  const [localNonce, setLocalNonce] = useState(0);
  const [remoteNonce, setRemoteNonce] = useState(0);
  const [transfer, setTransfer] = useState<SftpTransferProgress | null>(null);
  const [transferError, setTransferError] = useState<string>('');
  // Remote file currently open in the full-pane Monaco editor (absolute path).
  const [openFile, setOpenFile] = useState<string | null>(null);

  const localSep: LocalSep = window.electronAPI.platform === 'win32' ? '\\' : '/';

  // basename of a local path, honouring the platform separator.
  const localBasename = useCallback(
    (p: string): string => {
      const trimmed = p.replace(localSep === '\\' ? /\\+$/ : /\/+$/, '');
      const idx = trimmed.lastIndexOf(localSep);
      return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
    },
    [localSep],
  );

  const connectionId = content.sftpConnectionId;

  // Fetch saved connections on mount.
  useEffect(() => {
    void window.electronAPI.getSavedConnections().then(setConns);
  }, []);

  const target = useMemo<SftpTarget | null>(
    () => (connectionId ? { connectionId, workspaceId, containerId } : null),
    [connectionId, workspaceId, containerId],
  );

  const selectedConn = useMemo(
    () => conns.find((c) => c.id === connectionId) ?? null,
    [conns, connectionId],
  );

  // Connect (and verify the session) whenever a connection is chosen.
  const connect = useCallback(async () => {
    if (!target) return;
    setStatus('connecting');
    setError('');
    try {
      const startDir = content.sftpRemotePath ?? (await window.electronAPI.sftpRealpath(target, '.'));
      // Verify the session and that the start dir is listable (the gate); the
      // RemoteFileTable fetches its own listing once it mounts.
      await window.electronAPI.sftpStatDir(target, startDir);
      setRemotePath(startDir);
      setStatus('ready');
      if (content.sftpRemotePath !== startDir) {
        onContentChange({ ...content, type: 'sftp', sftpRemotePath: startDir });
      }
    } catch (err) {
      setStatus('error');
      setError((err as Error).message || 'Failed to connect');
    }
  }, [target, content, onContentChange]);

  // Reconnect only when the chosen connection changes.
  useEffect(() => {
    if (!connectionId) return;
    void connect();
  }, [connectionId]); // eslint-disable-line

  // Resolve the initial local dir once the pane is ready, and persist it. Prefer
  // the workspace root folder; fall back to the user's home dir if it has none.
  useEffect(() => {
    if (status !== 'ready' || localPath) return;
    let cancelled = false;
    const resolveStart = async () => {
      const root = workspaceRootPath?.trim();
      if (root) return root;
      return window.electronAPI.homeDir();
    };
    void resolveStart().then((start) => {
      if (cancelled || !start) return;
      setLocalPath(start);
      onContentChange({ ...content, type: 'sftp', sftpLocalPath: start });
    });
    return () => { cancelled = true; };
  }, [status, localPath]); // eslint-disable-line

  // Track progress events for the transfer this pane started.
  useEffect(() => {
    return window.electronAPI.onSftpFmProgress((info) => {
      setTransfer((prev) => (prev && prev.transferId === info.transferId ? info : prev));
    });
  }, []);

  const handleUpload = useCallback(async () => {
    if (!target || !remotePath || !localPath || localSelection.length === 0 || transfer) return;
    const id = crypto.randomUUID();
    setTransferError('');
    setTransfer({ transferId: id, direction: 'upload', file: '', current: 0, total: 0 });
    try {
      const result = await window.electronAPI.sftpUpload(
        target,
        localSelection.map((e) => joinLocal(localPath, e.filename, localSep)),
        remotePath,
        id,
      );
      if (result.errors.length > 0) {
        setTransferError(`Upload finished with ${result.errors.length} error(s): ${result.errors[0]}`);
      } else if (!result.ok) {
        setTransferError(`Upload cancelled after ${result.transferred}/${result.total} files.`);
      }
    } catch (err) {
      setTransferError((err as Error).message || 'Upload failed');
    } finally {
      setTransfer(null);
      setRemoteNonce((n) => n + 1);
    }
  }, [target, remotePath, localPath, localSelection, localSep, transfer]);

  const handleDownload = useCallback(async () => {
    if (!target || !remotePath || !localPath || remoteSelection.length === 0 || transfer) return;
    const id = crypto.randomUUID();
    setTransferError('');
    setTransfer({ transferId: id, direction: 'download', file: '', current: 0, total: 0 });
    try {
      const result = await window.electronAPI.sftpDownload(
        target,
        remoteSelection.map((e) => ({ path: joinRemote(remotePath, e.filename), isDirectory: e.isDirectory })),
        localPath,
        id,
      );
      if (result.errors.length > 0) {
        setTransferError(`Download finished with ${result.errors.length} error(s): ${result.errors[0]}`);
      } else if (!result.ok) {
        setTransferError(`Download cancelled after ${result.transferred}/${result.total} files.`);
      }
    } catch (err) {
      setTransferError((err as Error).message || 'Download failed');
    } finally {
      setTransfer(null);
      setLocalNonce((n) => n + 1);
    }
  }, [target, remotePath, localPath, remoteSelection, transfer]);

  const handleCancelTransfer = useCallback(() => {
    if (transfer) void window.electronAPI.cancelSftpTransfer(transfer.transferId);
  }, [transfer]);

  // OS files dropped onto the remote pane → upload into the current remote dir.
  // Reuses the existing progress bar (onSftpFmProgress) + error banner.
  const handleRemoteDrop = useCallback(
    async (paths: string[]) => {
      if (!target || !remotePath || paths.length === 0 || transfer) return;
      const id = crypto.randomUUID();
      setTransferError('');
      setTransfer({ transferId: id, direction: 'upload', file: '', current: 0, total: 0 });
      try {
        const result = await window.electronAPI.sftpUpload(target, paths, remotePath, id);
        if (result.errors.length > 0) {
          setTransferError(`Upload finished with ${result.errors.length} error(s): ${result.errors[0]}`);
        } else if (!result.ok) {
          setTransferError(`Upload cancelled after ${result.transferred}/${result.total} files.`);
        }
      } catch (err) {
        setTransferError((err as Error).message || 'Upload failed');
      } finally {
        setTransfer(null);
        setRemoteNonce((n) => n + 1);
      }
    },
    [target, remotePath, transfer],
  );

  // OS files dropped onto the local pane → copy into the current local dir.
  // copyFile (fs:copy) handles files; directories that can't be recursed are
  // surfaced as an inline note rather than failing silently.
  const handleLocalDrop = useCallback(
    async (paths: string[]) => {
      if (!localPath || paths.length === 0) return;
      setTransferError('');
      const failures: string[] = [];
      for (const src of paths) {
        const dest = joinLocal(localPath, localBasename(src), localSep);
        try {
          await window.electronAPI.copyFile(src, dest);
        } catch (err) {
          failures.push(`${localBasename(src)}: ${(err as Error).message || 'copy failed'}`);
        }
      }
      if (failures.length > 0) {
        setTransferError(
          `Could not copy ${failures.length} item(s) (folders may need to be downloaded instead): ${failures[0]}`,
        );
      }
      setLocalNonce((n) => n + 1);
    },
    [localPath, localSep, localBasename],
  );

  const handleChooseConnection = useCallback(
    (conn: SavedConnection) => {
      onRecordConnectionUse?.(conn.id);
      onContentChange({ ...content, type: 'sftp', sftpConnectionId: conn.id, label: conn.label });
    },
    [content, onContentChange, onRecordConnectionUse],
  );

  const handleChangeConnection = useCallback(() => {
    setStatus('connecting');
    setError('');
    onContentChange({ ...content, type: 'sftp', sftpConnectionId: undefined });
  }, [content, onContentChange]);

  const titleText = useMemo(() => {
    if (!connectionId) return 'SFTP';
    const label = selectedConn?.label ?? content.label ?? 'SFTP';
    if (status === 'ready' && remotePath) return `${label} — ${remotePath}`;
    return label;
  }, [connectionId, selectedConn, content.label, status, remotePath]);

  const iconBtnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '20px', height: '20px', borderRadius: '4px', background: 'transparent',
    border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)',
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      {/* Title bar */}
      <div
        className="container-drag-handle"
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', padding: '0 10px',
          height: '32px', minHeight: '32px', background: 'var(--bg-titlebar)',
          borderBottom: '1px solid var(--border)', userSelect: 'none', cursor: 'grab',
        }}
      >
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
          title="Close"
          style={{ width: '12px', height: '12px', borderRadius: '50%', background: 'var(--accent-red)', border: 'none', cursor: 'pointer', flexShrink: 0, opacity: 0.7 }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
        />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {titleText}
        </span>
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

      {/* Body */}
      {!connectionId ? (
        /* ===== STATE 1 — choose a connection ===== */
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Header */}
          <div style={{ padding: '16px 16px 10px', textAlign: 'center', flexShrink: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 700 }}>Choose a connection</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Pick a saved SSH connection to browse over SFTP</div>
          </div>
          {conns.length === 0 ? (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>
              No saved SSH connections. Add one in Settings.
            </div>
          ) : (
            <ConnectionSelector
              savedConnections={conns}
              recentConnectionIds={recentConnectionIds}
              onSelect={handleChooseConnection}
            />
          )}
        </div>
      ) : status === 'connecting' ? (
        /* ===== STATE 2a — connecting ===== */
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Connecting…
        </div>
      ) : status === 'error' ? (
        /* ===== STATE 2b — error ===== */
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
          <div style={{ fontSize: 12, color: 'var(--accent-red)', maxWidth: 360, textAlign: 'center', lineHeight: 1.5 }}>
            {error}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => void connect()}
              style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', background: 'var(--bg-surface)', color: 'var(--accent)', cursor: 'pointer' }}
            >
              Retry
            </button>
            <button
              onClick={handleChangeConnection}
              style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              Change connection
            </button>
          </div>
        </div>
      ) : (
        /* ===== STATE 2c — ready: dual-pane manager ===== */
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {/* Local half */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-titlebar)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: 0.4 }}>
                Local
              </div>
              {localPath ? (
                <LocalFileTable
                  path={localPath}
                  onPathChange={(p) => {
                    setLocalPath(p);
                    onContentChange({ ...content, type: 'sftp', sftpLocalPath: p });
                  }}
                  refreshNonce={localNonce}
                  onSelectionChange={setLocalSelection}
                  onExternalDrop={(paths) => void handleLocalDrop(paths)}
                  zoomLevel={zoomLevel}
                />
              ) : (
                <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                  Resolving home directory…
                </div>
              )}
            </div>

            {/* Transfer control strip */}
            <div
              style={{
                width: 36, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', gap: 10, background: 'var(--bg-titlebar)',
                borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)',
              }}
            >
              <button
                onClick={() => void handleUpload()}
                disabled={localSelection.length === 0 || !!transfer}
                title={`Upload to remote${localSelection.length > 0 ? ` (${localSelection.length} item${localSelection.length === 1 ? '' : 's'})` : ''}`}
                aria-label="Upload selection to remote"
                style={{
                  width: 26, height: 26, borderRadius: 5, border: '1px solid var(--border)',
                  background: 'var(--bg-surface)', fontSize: 13, lineHeight: 1,
                  color: localSelection.length > 0 && !transfer ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: localSelection.length > 0 && !transfer ? 'pointer' : 'default',
                  opacity: localSelection.length > 0 && !transfer ? 1 : 0.5,
                }}
              >
                →
              </button>
              <button
                onClick={() => void handleDownload()}
                disabled={remoteSelection.length === 0 || !!transfer}
                title={`Download to local${remoteSelection.length > 0 ? ` (${remoteSelection.length} item${remoteSelection.length === 1 ? '' : 's'})` : ''}`}
                aria-label="Download selection to local"
                style={{
                  width: 26, height: 26, borderRadius: 5, border: '1px solid var(--border)',
                  background: 'var(--bg-surface)', fontSize: 13, lineHeight: 1,
                  color: remoteSelection.length > 0 && !transfer ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: remoteSelection.length > 0 && !transfer ? 'pointer' : 'default',
                  opacity: remoteSelection.length > 0 && !transfer ? 1 : 0.5,
                }}
              >
                ←
              </button>
            </div>

            {/* Remote half */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-titlebar)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: 0.4 }}>
                Remote
              </div>
              {target && (
                <RemoteFileTable
                  target={target}
                  path={remotePath || '/'}
                  onPathChange={(p) => {
                    setRemotePath(p);
                    onContentChange({ ...content, type: 'sftp', sftpRemotePath: p });
                  }}
                  refreshNonce={remoteNonce}
                  onSelectionChange={setRemoteSelection}
                  onExternalDrop={(paths) => void handleRemoteDrop(paths)}
                  onOpenFile={(entry) => setOpenFile(joinRemote(remotePath, entry.filename))}
                  zoomLevel={zoomLevel}
                />
              )}
            </div>
          </div>

          {/* Transfer error banner */}
          {transferError && (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 11, flexShrink: 0,
                background: 'rgba(241,76,76,0.12)', color: 'var(--accent-red)', borderTop: '1px solid var(--border)',
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{transferError}</span>
              <button
                onClick={() => setTransferError('')}
                title="Dismiss"
                style={{ background: 'transparent', border: 'none', color: 'var(--accent-red)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}
              >
                ✕
              </button>
            </div>
          )}

          {/* Transfer progress bar */}
          {transfer && (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '5px 10px', flexShrink: 0,
                background: 'var(--bg-titlebar)', borderTop: '1px solid var(--border)', fontSize: 11,
              }}
            >
              <span style={{ fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>
                {transfer.direction === 'upload' ? 'Uploading' : 'Downloading'}
              </span>
              <span style={{ flexShrink: 0, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {transfer.total > 0 ? `${transfer.current}/${transfer.total}` : '…'}
              </span>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
                  {transfer.file}
                </span>
                <div style={{ height: 3, borderRadius: 2, background: 'var(--bg-hover)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%', background: 'var(--accent)', transition: 'width 0.15s ease',
                      width: transfer.total > 0 ? `${Math.round((transfer.current / transfer.total) * 100)}%` : '0%',
                    }}
                  />
                </div>
              </div>
              <button
                onClick={handleCancelTransfer}
                style={{ flexShrink: 0, fontSize: 11, padding: '3px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          )}

          {/* Full-pane remote file editor overlay (covers both halves) */}
          {openFile && target && (
            <RemoteFileEditor target={target} path={openFile} onClose={() => setOpenFile(null)} />
          )}
        </div>
      )}
    </div>
  );
};
