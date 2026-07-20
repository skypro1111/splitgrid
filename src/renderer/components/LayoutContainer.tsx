import React from 'react';
import { SqlWorkbench } from './sql/SqlWorkbench';
import { SFTPPanel } from './SFTPPanel';
import { SSHConnectPanel } from './SSHConnectPanel';
import { SplitHorizontalIcon, SplitVerticalIcon } from './Icons';
import type { Container as ContainerType, TerminalSessionInfo, SavedConnection, SSHConnectionConfig } from '../../shared/types';

interface LayoutContainerProps {
  container: ContainerType;
  sessions: Map<string, TerminalSessionInfo>;
  workspaceId: string;
  /** Connection ids used in this workspace, most-recent-first (for the SFTP / SSH pane choosers). */
  recentConnectionIds?: string[];
  onRecordConnectionUse?: (connectionId: string) => void;
  /** Workspace root folder — default starting dir for the SFTP local pane. */
  workspaceRootPath?: string | null;
  /** Saved SSH connections + handlers for the embedded 'ssh-connect' picker pane. */
  savedConnections?: SavedConnection[];
  onSSHConnect?: (containerId: string, savedId: string) => Promise<void>;
  onCreateConnection?: (config: Omit<SSHConnectionConfig, 'id'>) => Promise<SavedConnection>;
  onDeleteSavedConnection?: (id: string) => Promise<void>;
  onClose: (containerId: string) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onContentChange?: (containerId: string, content: ContainerType['content']) => void;
  zoomLevel: number;
}

export const LayoutContainer: React.FC<LayoutContainerProps> = ({
  container,
  sessions,
  workspaceId,
  recentConnectionIds,
  onRecordConnectionUse,
  workspaceRootPath,
  savedConnections,
  onSSHConnect,
  onCreateConnection,
  onDeleteSavedConnection,
  onClose,
  onSplitRight,
  onSplitDown,
  onContentChange,
  zoomLevel,
}) => {
  const notifyPortalTargetMounted = React.useCallback((kind: 'terminal' | 'ide' | 'browser', containerId: string) => {
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent('splitgrid:portal-target-mounted', {
        detail: { kind, containerId },
      }));
    });
  }, []);

  // Terminal renderer lives in <TerminalPortal> at the App root.
  if (container.content.type === 'terminal') {
    const session = container.content.terminalId
      ? sessions.get(container.content.terminalId)
      : undefined;

    if (!session) {
      const label = container.content.customName?.trim() || container.content.label || (container.content.terminalType === 'ssh' ? 'SSH' : 'Terminal');
      const statusText = container.content.connectionError ? 'Connection failed' : 'Connecting...';
      const statusColor = container.content.connectionError ? '#f14c4c' : '#e5b95c';
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--bg-primary)', overflow: 'hidden' }}>
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
              onClick={() => onClose(container.id)}
              title="Close"
              style={{ width: '12px', height: '12px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px', color: 'transparent', background: 'var(--accent-red)', border: 'none', cursor: 'pointer', flexShrink: 0, lineHeight: 1, opacity: 0.7 }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--bg-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.color = 'transparent'; }}
            >x</button>
            <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
            <span style={{ fontSize: '10px', fontWeight: 600, padding: '1px 5px', borderRadius: '3px', background: container.content.terminalType === 'ssh' ? 'rgba(76,157,243,0.15)' : 'rgba(21,172,145,0.15)', color: container.content.terminalType === 'ssh' ? 'var(--accent-blue)' : 'var(--accent-green)', flexShrink: 0 }}>
              {container.content.terminalType === 'ssh' ? 'SSH' : 'LOCAL'}
            </span>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {label}
            </span>
            <button onMouseDown={(e) => e.stopPropagation()} onClick={onSplitRight} title="Split right" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            ><SplitHorizontalIcon size={14} /></button>
            <button onMouseDown={(e) => e.stopPropagation()} onClick={onSplitDown} title="Split down" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            ><SplitVerticalIcon size={14} /></button>
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '6px' }}>
            <div style={{ color: statusColor, fontSize: '12px' }}>{statusText}</div>
            {container.content.connectionError && (
              <div style={{ color: 'var(--text-muted)', fontSize: '11px', maxWidth: '300px', textAlign: 'center', lineHeight: 1.4 }}>
                {container.content.connectionError}
              </div>
            )}
          </div>
        </div>
      );
    }

    // The actual terminal renderer lives in <TerminalPortal> mounted at the App
    // root and is reparented into this placeholder when the workspace is
    // active. This keeps the terminal mounted across workspace switches.
    return (
      <div
        ref={(el) => {
          if (el) notifyPortalTargetMounted('terminal', container.id);
        }}
        data-terminal-target={container.id}
        style={{ height: '100%', width: '100%', overflow: 'hidden' }}
      />
    );
  }

  // Browser — the <webview> renderer lives in <BrowserPortal> floated on <body>
  // (a webview reloads when reparented, so it can't be torn down/moved on
  // workspace switch). This is just the geometry anchor it tracks.
  if (container.content.type === 'browser') {
    return (
      <div
        ref={(el) => {
          if (el) notifyPortalTargetMounted('browser', container.id);
        }}
        data-browser-target={container.id}
        style={{ height: '100%', width: '100%', overflow: 'hidden' }}
      />
    );
  }

  // IDE — header is rendered inside IDETabBar via portal
  if (container.content.type === 'ide' && container.content.rootPath) {
    return (
      <div
        ref={(el) => {
          if (el) notifyPortalTargetMounted('ide', container.id);
        }}
        data-ide-target={container.id}
        style={{ height: '100%', width: '100%', overflow: 'hidden' }}
      />
    );
  }

  // SQL
  if (container.content.type === 'sql') {
    return (
      <SqlWorkbench
        containerId={container.id}
        initialState={container.content.sqlState}
        zoomLevel={zoomLevel}
        onStateChange={(sqlState) => {
          onContentChange?.(container.id, {
            ...container.content,
            type: 'sql',
            label: sqlState.connectionName || 'SQL Client',
            sqlState,
          });
        }}
        onClose={() => onClose(container.id)}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
      />
    );
  }

  // SSH connection picker (embedded — replaces the old modal)
  if (container.content.type === 'ssh-connect') {
    return (
      <SSHConnectPanel
        savedConnections={savedConnections ?? []}
        recentConnectionIds={recentConnectionIds ?? []}
        onConnect={(savedId) => onSSHConnect?.(container.id, savedId) ?? Promise.resolve()}
        onCreateConnection={onCreateConnection ?? (() => Promise.reject(new Error('Cannot create connection')))}
        onDeleteSaved={(id) => onDeleteSavedConnection?.(id) ?? Promise.resolve()}
        onClose={() => onClose(container.id)}
        onBackToEmpty={() => onContentChange?.(container.id, { type: 'empty' })}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
      />
    );
  }

  // SFTP
  if (container.content.type === 'sftp') {
    return (
      <SFTPPanel
        containerId={container.id}
        workspaceId={workspaceId}
        content={container.content}
        recentConnectionIds={recentConnectionIds ?? []}
        onRecordConnectionUse={onRecordConnectionUse}
        workspaceRootPath={workspaceRootPath}
        zoomLevel={zoomLevel}
        onContentChange={(content) => {
          onContentChange?.(container.id, content);
        }}
        onClose={() => onClose(container.id)}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
      />
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
      Empty container
    </div>
  );
};
