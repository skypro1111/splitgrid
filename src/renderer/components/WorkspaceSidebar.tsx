import React, { useState, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { SidebarIcon, PlusSquareIcon, GearIcon } from './Icons';
import { WorkspaceItemNotesTodo } from './WorkspaceNotesTodo';
import { EnvTodoButton } from './EnvTodoButton';
import { CommandsButton } from './CommandsButton';
import { PromptsButton } from './PromptsButton';
import { TerminalPortsButton, openPort } from './TerminalPorts';
import type { Workspace, WorkspaceSyncConfig, WorkspaceTodo, SavedCommand, RecentCommand, SavedPrompt, ClaudeActivityState } from '../../shared/types';
import { useTerminalProcesses } from '../hooks/useTerminalProcesses';
import { useTerminalViewState, type ActivityKind } from '../hooks/useTerminalViewState';

const EMPTY_CLAUDE_ACTIVITY = new Map<string, ClaudeActivityState>();
const EMPTY_NOTIFY = new Map<string, number>();

type SyncStatus = 'disabled' | 'synced' | 'error' | 'syncing';

function deriveSyncStatus(sync?: WorkspaceSyncConfig): SyncStatus {
  if (!sync || !sync.enabled) return 'disabled';
  const enabledTargets = sync.targets.filter((t) => t.enabled);
  if (enabledTargets.length === 0) return 'disabled';
  if (enabledTargets.some((t) => t.lastSyncStatus === 'error')) return 'error';
  if (enabledTargets.some((t) => t.lastSyncAt)) return 'synced';
  return 'disabled';
}

const syncStatusColor: Record<SyncStatus, string> = {
  disabled: '#555',
  synced: '#15ac91',
  error: '#f14c4c',
  syncing: '#e5b95c',
};

const SyncIndicator: React.FC<{ sync?: WorkspaceSyncConfig }> = ({ sync }) => {
  const [show, setShow] = useState(false);
  const dotRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const status = deriveSyncStatus(sync);

  const enabledTargets = sync?.targets.filter((t) => t.enabled) ?? [];
  const recentLogs = (sync?.logs ?? []).slice(-8).reverse();

  const handleEnter = () => {
    if (dotRef.current) {
      const rect = dotRef.current.getBoundingClientRect();
      setPos({ x: rect.right + 8, y: rect.top - 4 });
    }
    setShow(true);
  };

  const popover = show ? ReactDOM.createPortal(
    <div
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 9000,
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        padding: '10px 12px', width: '480px',
        fontSize: '11px', color: 'var(--text-secondary)',
      }}
    >
      <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px', fontSize: '11px' }}>
        Sync: {status === 'disabled' ? 'Off' : status === 'synced' ? 'OK' : status === 'error' ? 'Error' : 'Running'}
      </div>

      {enabledTargets.length > 0 && (
        <div style={{ marginBottom: '6px' }}>
          {enabledTargets.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '2px 0' }}>
              <div style={{
                width: '5px', height: '5px', borderRadius: '50%', flexShrink: 0,
                background: t.lastSyncStatus === 'error' ? '#f14c4c' : t.lastSyncAt ? '#15ac91' : '#555',
              }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {t.name}
              </span>
              {t.lastSyncAt && (
                <span style={{ color: 'var(--text-muted)', fontSize: '10px', flexShrink: 0 }}>
                  {new Date(t.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
          ))}
          {enabledTargets.some((t) => t.lastSyncStatus === 'error' && t.lastSyncError) && (
            <div style={{ color: '#f14c4c', fontSize: '10px', marginTop: '4px', lineHeight: 1.3 }}>
              {enabledTargets.find((t) => t.lastSyncStatus === 'error')?.lastSyncError}
            </div>
          )}
        </div>
      )}

      {recentLogs.length > 0 && (
        <>
          <div style={{ height: '1px', background: 'var(--border)', margin: '4px 0 6px' }} />
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '3px' }}>Recent</div>
          {recentLogs.map((log) => (
            <div key={log.id} style={{
              display: 'flex', gap: '4px', padding: '1px 0', fontSize: '10px',
              color: log.ok ? 'var(--text-muted)' : '#f14c4c',
            }}>
              <span style={{ flexShrink: 0, opacity: 0.6 }}>
                {new Date(log.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {log.filePath.split('/').pop()} — {log.message}
              </span>
            </div>
          ))}
        </>
      )}

      {status === 'disabled' && enabledTargets.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
          No active sync targets
        </div>
      )}
    </div>,
    document.body
  ) : null;

  return (
    <div
      ref={dotRef}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
      onClick={(e) => e.stopPropagation()}
      style={{ flexShrink: 0, cursor: 'default' }}
    >
      <div style={{
        width: '7px', height: '7px', borderRadius: '50%',
        background: syncStatusColor[status],
        transition: 'background 0.2s',
      }} />
      {popover}
    </div>
  );
};

const COLLAPSED_WIDTH = 48;
const DEFAULT_WIDTH = 200;
const MIN_WIDTH = 140;
const MAX_WIDTH = 400;

type WorkspaceSidebarSubrow = {
  id: string;
  label: string; // container type: terminal | ssh | ide | sql | browser
  customName?: string; // user-set name; overrides the auto label/process
  sessionId?: string; // terminal session id (terminal/ssh rows)
  streamable: boolean; // terminal/ssh
  status?: string;
  streaming?: boolean; // currently casting to the web relay
};

const TERMINAL_STATUS_COLORS: Record<string, string> = {
  connecting: '#e5b95c',
  connected: '#15ac91',
  disconnected: 'var(--text-muted)',
  error: '#f14c4c',
};

interface WorkspaceSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  onSwitchWorkspace: (id: string) => void;
  onCreateWorkspace: (name: string) => Workspace | void;
  onDeleteWorkspace: (id: string) => void;
  onListRecentWorkspaces: () => Promise<Workspace[]>;
  onOpenRecentWorkspace: (ws: Workspace) => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onSetWorkingDirectory: (id: string, directory: string | null) => void;
  onReorderWorkspaces: (fromIndex: number, toIndex: number) => void;
  onOpenAppSettings: () => void;
  onOpenSettings: (id: string) => void;
  envTodos: WorkspaceTodo[];
  onUpdateEnvTodos: (updater: (todos: WorkspaceTodo[]) => WorkspaceTodo[]) => void;
  recentCommands: RecentCommand[];
  envCommandFavorites: SavedCommand[];
  workspaceCommandFavorites: SavedCommand[];
  onRunCommand: (command: string, execute: boolean) => void;
  onUpdateEnvCommandFavorites: (updater: (f: SavedCommand[]) => SavedCommand[]) => void;
  onUpdateWorkspaceCommandFavorites: (updater: (f: SavedCommand[]) => SavedCommand[]) => void;
  onRemoveRecentCommand: (command: string) => void;
  onClearRecentCommands: () => void;
  envPrompts: SavedPrompt[];
  onUpdateEnvPrompts: (updater: (p: SavedPrompt[]) => SavedPrompt[]) => void;
  onFreezeWorkspace: (id: string) => void;
  onUnfreezeWorkspace: (id: string) => void;
  terminalRowsByWorkspaceId?: Map<string, WorkspaceSidebarSubrow[]>;
  claudeActivity?: Map<string, ClaudeActivityState>;
  sessionActivity?: Map<string, 'working' | 'stopped'>;
  agentNotify?: Map<string, number>;
  onUnviewedDone?: (sessionId: string, workspaceId: string) => void;
  muteAll?: boolean;
  onToggleWorkspaceMute?: (id: string, muted: boolean) => void;
  onToggleMuteAll?: (muted: boolean) => void;
  onSetWorkspaceNotes: (id: string, notes: string) => void;
  onUpdateWorkspaceTodos: (id: string, updater: (todos: WorkspaceTodo[]) => WorkspaceTodo[]) => void;
}

const ACTIVITY_LABEL: Record<ActivityKind, { text: string; animated: boolean }> = {
  working: { text: 'Working', animated: true },
  waiting: { text: 'Waiting', animated: false },
  done: { text: 'Done!', animated: false },
};
const WORKING_COLOR = '#8a8a8a'; // grey
const WAITING_COLOR = '#e5b95c'; // amber
const DONE_UNVIEWED_COLOR = '#15ac91'; // bright green — needs attention
const DONE_VIEWED_COLOR = '#5e7a73'; // muted green — already seen
// Background highlight for a workspace with unviewed-done terminals (used on the
// workspace row instead of recolouring its title).
const DONE_UNVIEWED_BG = 'rgba(21, 172, 145, 0.16)';

export const WorkspaceSidebar: React.FC<WorkspaceSidebarProps> = ({
  collapsed,
  onToggleCollapse,
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace,
  onListRecentWorkspaces,
  onOpenRecentWorkspace,
  onRenameWorkspace,
  onSetWorkingDirectory,
  onReorderWorkspaces,
  onOpenAppSettings,
  onOpenSettings,
  envTodos,
  onUpdateEnvTodos,
  recentCommands,
  envCommandFavorites,
  workspaceCommandFavorites,
  onRunCommand,
  onUpdateEnvCommandFavorites,
  onUpdateWorkspaceCommandFavorites,
  onRemoveRecentCommand,
  onClearRecentCommands,
  envPrompts,
  onUpdateEnvPrompts,
  onFreezeWorkspace,
  onUnfreezeWorkspace,
  terminalRowsByWorkspaceId,
  claudeActivity,
  sessionActivity,
  agentNotify,
  onUnviewedDone,
  muteAll,
  onToggleWorkspaceMute,
  onToggleMuteAll,
  onSetWorkspaceNotes,
  onUpdateWorkspaceTodos,
}) => {
  const terminalProcesses = useTerminalProcesses();
  const viewState = useTerminalViewState({
    workspaces,
    activeWorkspaceId,
    claudeActivity: claudeActivity ?? EMPTY_CLAUDE_ACTIVITY,
    sessionActivity,
    notifyAt: agentNotify ?? EMPTY_NOTIFY,
    getProcCommand: (sid) => terminalProcesses.get(sid)?.processCommand,
    onNewUnviewed: onUnviewedDone,
  });
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number; confirmClose?: boolean } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [recentWorkspaces, setRecentWorkspaces] = useState<Workspace[]>([]);
  const [showRecentSub, setShowRecentSub] = useState(false);
  // Flyout preview of a workspace's full item (name + terminal rows) shown when
  // hovering its icon in the collapsed sidebar.
  const [hoverPreview, setHoverPreview] = useState<{ wsId: string; top: number; left: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  const [dragState, setDragState] = useState<{
    fromIndex: number;
    dropIndex: number;
  } | null>(null);
  const dragStartY = useRef(0);
  const didDrag = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const [resizing, setResizing] = useState(false);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    setResizing(true);

    const onMove = (ev: MouseEvent) => {
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + ev.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setAddMenu(null);
    setContextMenu({ id, x: e.clientX, y: e.clientY });
  };

  const handleStartRename = (id: string, currentName: string) => {
    setEditingId(id);
    setEditName(currentName);
    setContextMenu(null);
  };

  const handleFinishRename = () => {
    if (editingId && editName.trim()) {
      onRenameWorkspace(editingId, editName.trim());
    }
    setEditingId(null);
  };

  const handleDragStart = useCallback((index: number, e: React.MouseEvent) => {
    if (editingId) return;
    e.preventDefault();
    dragStartY.current = e.clientY;
    didDrag.current = false;

    const sourceEl = (e.currentTarget as HTMLElement);
    const sourceRect = sourceEl.getBoundingClientRect();
    // Offset from cursor to top of element, so ghost feels attached
    const offsetY = e.clientY - sourceRect.top;

    let currentDropIndex = index;

    const createGhost = () => {
      const ghost = document.createElement('div');
      // Clone inner HTML and computed styles
      ghost.innerHTML = sourceEl.innerHTML;
      const cs = getComputedStyle(sourceEl);
      ghost.style.cssText = `
        position: fixed;
        left: ${sourceRect.left}px;
        top: ${e.clientY - offsetY}px;
        width: ${sourceRect.width}px;
        height: ${sourceRect.height}px;
        background: var(--bg-surface, ${cs.backgroundColor});
        color: ${cs.color};
        font-size: ${cs.fontSize};
        font-weight: ${cs.fontWeight};
        border-radius: 8px;
        padding: ${cs.padding};
        box-shadow: 0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06);
        pointer-events: none;
        z-index: 9999;
        opacity: 0.95;
        transform: scale(1.03);
        transition: opacity 0.15s ease, transform 0.15s ease;
        overflow: hidden;
      `;
      document.body.appendChild(ghost);
      ghostRef.current = ghost;
    };

    const onMove = (ev: MouseEvent) => {
      if (!didDrag.current && Math.abs(ev.clientY - dragStartY.current) < 5) return;

      if (!didDrag.current) {
        didDrag.current = true;
        createGhost();
        setDragState({ fromIndex: index, dropIndex: index });
      }

      // Move ghost
      if (ghostRef.current) {
        ghostRef.current.style.top = `${ev.clientY - offsetY}px`;
      }

      // Find drop target — temporarily hide ghost to see through
      if (ghostRef.current) ghostRef.current.style.display = 'none';
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (ghostRef.current) ghostRef.current.style.display = '';

      if (target) {
        const item = (target as HTMLElement).closest('[data-ws-index]');
        if (item) {
          const ti = parseInt(item.getAttribute('data-ws-index')!, 10);
          if (ti !== currentDropIndex) {
            currentDropIndex = ti;
            setDragState({ fromIndex: index, dropIndex: ti });
          }
        }
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Animate ghost to final position before removing
      if (ghostRef.current && didDrag.current) {
        const dropTarget = document.querySelector(`[data-ws-index="${currentDropIndex}"]`);
        if (dropTarget && currentDropIndex !== index) {
          const dropRect = dropTarget.getBoundingClientRect();
          ghostRef.current.style.transition = 'all 0.18s ease';
          ghostRef.current.style.top = `${dropRect.top}px`;
          ghostRef.current.style.opacity = '0';
          ghostRef.current.style.transform = 'scale(1)';
          setTimeout(() => {
            ghostRef.current?.remove();
            ghostRef.current = null;
          }, 180);
        } else {
          ghostRef.current.style.transition = 'all 0.15s ease';
          ghostRef.current.style.opacity = '0';
          ghostRef.current.style.transform = 'scale(0.95)';
          setTimeout(() => {
            ghostRef.current?.remove();
            ghostRef.current = null;
          }, 150);
        }
      }

      if (didDrag.current && currentDropIndex !== index) {
        onReorderWorkspaces(index, currentDropIndex);
      }
      setDragState(null);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }, [editingId, onReorderWorkspaces]);

  const currentWidth = collapsed ? COLLAPSED_WIDTH : width;

  // Recent workspaces for the "+ → Open Recent" submenu: last 10 closed ones in
  // this env, excluding only those literally still open (matched by id). We do
  // NOT exclude by working directory — distinct workspaces often share a project
  // dir, and hiding all of them made Open Recent look empty whenever one such
  // workspace stayed open.
  const filteredRecent = (() => {
    const openIds = new Set(workspaces.map((w) => w.id));
    return recentWorkspaces
      .filter((r) => !openIds.has(r.id))
      .slice(0, 10);
  })();

  const renderSubrow = (
    row: WorkspaceSidebarSubrow,
    isActive: boolean,
    options?: { showStatus?: boolean },
  ) => {
    // Show the terminal's real foreground process (claude/zsh/vim/…) when known,
    // falling back to the container type (terminal/ssh).
    const procInfo = row.sessionId ? terminalProcesses.get(row.sessionId) : undefined;
    const procCommand = procInfo?.processCommand;
    const ports = procInfo?.ports ?? [];
    // A user-set custom name wins over the live process / container type.
    const customName = row.customName?.trim();
    const autoLabel = procCommand || row.label;
    const displayLabel = customName || autoLabel;
    const sid = row.sessionId;
    const kind = sid ? viewState.kinds.get(sid) : undefined;
    const unviewed = !!sid && viewState.unviewedSessions.has(sid);
    const activity = kind ? ACTIVITY_LABEL[kind] : null;
    const activityColor =
      kind === 'working' ? WORKING_COLOR
      : kind === 'waiting' ? WAITING_COLOR
      : kind === 'done' ? (unviewed ? DONE_UNVIEWED_COLOR : DONE_VIEWED_COLOR)
      : undefined;
    return (
      <div
        key={row.id}
        title={displayLabel}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          fontSize: '10px',
          color: isActive ? 'var(--text-secondary)' : 'var(--text-muted)',
          marginTop: '3px',
          minWidth: 0,
        }}
      >
        {options?.showStatus && row.status && (
          <span
            className={row.streaming ? 'splitgrid-stream-pulse' : undefined}
            title={row.streaming ? 'Streaming to web' : undefined}
            style={{
              width: '5px',
              height: '5px',
              borderRadius: '50%',
              // While casting, force the bright relay-green and pulse so it's
              // obvious at a glance which terminals are live on the web.
              background: row.streaming ? '#15ac91' : (TERMINAL_STATUS_COLORS[row.status] ?? 'var(--text-muted)'),
              flexShrink: 0,
            }}
          />
        )}
        <span style={{
          flexShrink: 1,
          minWidth: 0,
          letterSpacing: '0.3px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{displayLabel}</span>
        {row.sessionId && (
          <TerminalPortsButton sessionId={row.sessionId} ports={ports} label={displayLabel} />
        )}
        {activity && (
          <span
            className={activity.animated ? 'splitgrid-working' : undefined}
            style={{
              color: activityColor,
              flexShrink: 0,
              fontWeight: kind === 'done' && unviewed ? 700 : 500,
            }}
          >
            {activity.text}
          </span>
        )}
      </div>
    );
  };

  // A stable, consolidated strip of every port the workspace's terminals are
  // hosting — rendered below all terminal rows so it never jumps as activity
  // labels change width. Click a chip to open it in the browser.
  const renderWorkspacePorts = (rows: WorkspaceSidebarSubrow[]) => {
    const seen = new Set<number>();
    for (const row of rows) {
      const info = row.sessionId ? terminalProcesses.get(row.sessionId) : undefined;
      for (const p of info?.ports ?? []) seen.add(p.port);
    }
    if (seen.size === 0) return null;
    const ports = [...seen].sort((a, b) => a - b);
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', marginTop: '5px' }}>
        <span style={{ fontSize: '9px', color: 'var(--text-muted)', letterSpacing: '0.3px', flexShrink: 0 }}>ports</span>
        {ports.map((port) => (
          <span
            key={port}
            title={`Open http://localhost:${port}`}
            onClick={(e) => { e.stopPropagation(); openPort(port); }}
            style={{
              flexShrink: 0,
              fontSize: '9px',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
              padding: '1px 4px',
              borderRadius: '4px',
              color: 'var(--accent, #4ea1ff)',
              background: 'color-mix(in srgb, var(--accent, #4ea1ff) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent, #4ea1ff) 35%, transparent)',
              cursor: 'pointer',
            }}
          >
            :{port}
          </span>
        ))}
      </div>
    );
  };

  return (
    <>
      <div
        style={{
          width: `${currentWidth}px`,
          minWidth: `${currentWidth}px`,
          background: 'var(--bg-sidebar)',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
          transition: resizing ? 'none' : 'width 0.15s ease, min-width 0.15s ease',
        }}
      >
        {/* Header — app name + collapse toggle */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          padding: collapsed ? '10px 0 8px' : '10px 12px 8px',
        }}>
          {!collapsed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <img
                src="logo.svg"
                alt="SplitGrid"
                style={{
                  width: 28,
                  height: 28,
                  objectFit: 'contain',
                  opacity: 0.9,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: '15px',
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  letterSpacing: '-0.2px',
                  whiteSpace: 'nowrap',
                }}
              >
                SplitGrid
              </span>
            </div>
          )}
          <button
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              width: '22px',
              height: '22px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <SidebarIcon size={16} />
          </button>
        </div>

        {/* Workspace list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: collapsed ? '0 4px 8px' : '0 8px 8px' }}>
          {workspaces.map((ws, idx) => {
            const isActive = ws.id === activeWorkspaceId;
            // Background workspace with a finished-but-unseen terminal.
            const wsUnviewed = viewState.unviewedWorkspaces.has(ws.id);
            const isFrozen = !!ws.frozen;
            const initial = ws.name.charAt(0).toUpperCase();
            const isDragging = dragState?.fromIndex === idx;
            const isDropTarget = dragState !== null && dragState.dropIndex === idx && dragState.fromIndex !== idx;
            const terminalRows = terminalRowsByWorkspaceId?.get(ws.id) ?? [];

            if (collapsed) {
              return (
                <div
                  key={ws.id}
                  data-ws-index={idx}
                  onClick={() => { if (!didDrag.current && !isFrozen) onSwitchWorkspace(ws.id); }}
                  onMouseDown={(e) => { if (e.button === 0) handleDragStart(idx, e); }}
                  onContextMenu={(e) => handleContextMenu(e, ws.id)}
                  title={isFrozen ? `${ws.name} (frozen — right-click to Unfreeze)` : ws.name}
                  style={{
                    width: '36px',
                    position: 'relative',
                    height: '36px',
                    margin: '0 auto 4px',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '14px',
                    fontWeight: 700,
                    cursor: dragState ? 'grabbing' : isFrozen ? 'not-allowed' : 'pointer',
                    background: isDropTarget ? 'var(--bg-hover)' : isActive ? 'var(--bg-hover)' : wsUnviewed ? DONE_UNVIEWED_COLOR : 'transparent',
                    color: wsUnviewed && !isActive && !isDropTarget ? '#ffffff' : isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                    border: isActive ? '1px solid var(--border)' : '1px solid transparent',
                    opacity: isDragging ? 0.25 : isFrozen ? 0.45 : 1,
                    boxShadow: 'none',
                    transition: 'opacity 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease',
                    transform: isDropTarget ? 'scale(1.04)' : 'scale(1)',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive && !dragState && !isFrozen && !wsUnviewed) e.currentTarget.style.background = 'var(--bg-hover)';
                    const r = e.currentTarget.getBoundingClientRect();
                    setHoverPreview({ wsId: ws.id, top: r.top, left: r.right + 8 });
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive && !dragState && !isFrozen) e.currentTarget.style.background = wsUnviewed ? DONE_UNVIEWED_COLOR : 'transparent';
                    setHoverPreview((p) => (p?.wsId === ws.id ? null : p));
                  }}
                >
                  {initial}
                  {isFrozen && (
                    <div style={{
                      position: 'absolute', top: '1px', right: '3px',
                      fontSize: '9px', lineHeight: 1, color: '#7cc4ff',
                    }}>❄</div>
                  )}
                  {ws.sync?.enabled && (
                    <div style={{
                      position: 'absolute', bottom: '2px', right: '2px',
                      width: '6px', height: '6px', borderRadius: '50%',
                      background: syncStatusColor[deriveSyncStatus(ws.sync)],
                    }} />
                  )}
                  {(ws.todos?.some((t) => !t.done) ?? false) && (
                    <div
                      title="Has open todos"
                      style={{
                        position: 'absolute', bottom: '2px', left: '2px',
                        width: '6px', height: '6px', borderRadius: '50%',
                        background: 'var(--accent-green, #15ac91)',
                      }}
                    />
                  )}
                </div>
              );
            }

            return (
              <div
                key={ws.id}
                data-ws-index={idx}
                onClick={() => { if (!didDrag.current && !isFrozen) onSwitchWorkspace(ws.id); }}
                onMouseDown={(e) => { if (e.button === 0 && editingId !== ws.id) handleDragStart(idx, e); }}
                onContextMenu={(e) => handleContextMenu(e, ws.id)}
                title={isFrozen ? `${ws.name} (frozen — right-click to Unfreeze)` : undefined}
                style={{
                  position: 'relative',
                  padding: '8px 10px',
                  marginBottom: '3px',
                  borderRadius: '6px',
                  cursor: dragState ? 'grabbing' : isFrozen ? 'not-allowed' : 'pointer',
                  background: isDropTarget ? 'var(--bg-hover)' : isActive ? 'var(--bg-hover)' : wsUnviewed ? DONE_UNVIEWED_BG : 'transparent',
                  borderLeft: '3px solid transparent',
                  opacity: isDragging ? 0.25 : isFrozen ? 0.5 : 1,
                  transition: 'opacity 0.15s ease, transform 0.15s ease, border-color 0.15s ease, background 0.15s ease',
                  transform: isDropTarget ? 'translateX(4px)' : 'translateX(0)',
                }}
                onMouseEnter={(e) => { if (!isActive && !dragState && !isFrozen) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { if (!isActive && !dragState && !isFrozen) e.currentTarget.style.background = wsUnviewed ? DONE_UNVIEWED_BG : 'transparent'; }}
              >
                {idx > 0 && (
                  <div
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      left: '12px',
                      right: '12px',
                      top: '-2px',
                      height: '1px',
                      background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.055), transparent)',
                      pointerEvents: 'none',
                    }}
                  />
                )}
                {editingId === ws.id ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={handleFinishRename}
                    onKeyDown={(e) => {
                      if (e.metaKey && (e.key === 'Backspace' || e.key === 'Delete')) {
                        // Keep native-like macOS word-line deletion behavior
                        // inside controlled React input.
                        e.preventDefault();
                        e.stopPropagation();
                        const input = e.currentTarget;
                        const value = input.value;
                        const start = input.selectionStart ?? value.length;
                        const end = input.selectionEnd ?? value.length;
                        if (start !== end) {
                          const next = `${value.slice(0, start)}${value.slice(end)}`;
                          setEditName(next);
                          requestAnimationFrame(() => input.setSelectionRange(start, start));
                          return;
                        }
                        if (e.key === 'Backspace') {
                          const next = value.slice(end);
                          setEditName(next);
                          requestAnimationFrame(() => input.setSelectionRange(0, 0));
                        } else {
                          const next = value.slice(0, start);
                          setEditName(next);
                          requestAnimationFrame(() => input.setSelectionRange(start, start));
                        }
                        return;
                      }
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        handleFinishRename();
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditingId(null);
                      }
                    }}
                    autoFocus
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border)',
                      borderRadius: '3px',
                      color: 'var(--text-primary)',
                      fontSize: '13px',
                      padding: '2px 6px',
                      width: '100%',
                      outline: 'none',
                    }}
                  />
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                      <div style={{
                        fontSize: '13px',
                        fontWeight: isActive ? 600 : wsUnviewed ? 600 : 400,
                        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        flex: 1,
                        minWidth: 0,
                      }}>
                        {ws.name}
                      </div>
                      {isFrozen && (
                        <span title="Frozen" style={{ flexShrink: 0, fontSize: '11px', lineHeight: 1, color: '#7cc4ff' }}>❄</span>
                      )}
                      {ws.sync?.enabled && <SyncIndicator sync={ws.sync} />}
                      <WorkspaceItemNotesTodo
                        workspace={ws}
                        onSetNotes={onSetWorkspaceNotes}
                        onUpdateTodos={onUpdateWorkspaceTodos}
                        onRun={(text) => onRunCommand(text, false)}
                      />
                    </div>
                    {terminalRows.map((row) => renderSubrow(row, isActive, { showStatus: true }))}
                    {renderWorkspacePorts(terminalRows)}
                  </>
                )}
              </div>
            );
          })}

          {/* Add workspace */}
          <div style={{ borderTop: '1px solid var(--border)', margin: collapsed ? '8px 4px 0' : '8px 0 0', padding: collapsed ? '8px 0 0' : '8px 0 0' }} />
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setContextMenu(null);
              setShowRecentSub(false);
              setAddMenu({
                x: rect.left,
                y: rect.bottom + 6,
              });
              onListRecentWorkspaces().then(setRecentWorkspaces).catch(() => setRecentWorkspaces([]));
            }}
            title="worspace"
            style={{
              width: collapsed ? '36px' : '100%',
              height: collapsed ? '36px' : '28px',
              margin: collapsed ? '0 auto' : '0',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              fontSize: '11px',
              color: 'var(--text-muted)',
              background: 'transparent',
              border: '1px dashed var(--border)',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.borderColor = 'var(--text-muted)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <PlusSquareIcon size={14} />{!collapsed && 'workspace'}
          </button>
        </div>

        {/* Bottom bar — settings + resources */}
        <div style={{
          padding: collapsed ? '8px 4px' : '8px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        }}>
          <EnvTodoButton
            todos={envTodos}
            onUpdate={onUpdateEnvTodos}
            collapsed={collapsed}
            buttonStyle={bottomBtnStyle(collapsed)}
          />
          <CommandsButton
            recent={recentCommands}
            envFavorites={envCommandFavorites}
            workspaceFavorites={workspaceCommandFavorites}
            workspaceName={workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? ''}
            collapsed={collapsed}
            buttonStyle={bottomBtnStyle(collapsed)}
            onRun={onRunCommand}
            onUpdateEnvFavorites={onUpdateEnvCommandFavorites}
            onUpdateWorkspaceFavorites={onUpdateWorkspaceCommandFavorites}
            onRemoveRecent={onRemoveRecentCommand}
            onClearRecent={onClearRecentCommands}
          />
          <PromptsButton
            prompts={envPrompts}
            collapsed={collapsed}
            buttonStyle={bottomBtnStyle(collapsed)}
            onRun={onRunCommand}
            onUpdate={onUpdateEnvPrompts}
          />
          <button
            onClick={onOpenAppSettings}
            title="Settings"
            style={bottomBtnStyle(collapsed)}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <GearIcon size={14} />{!collapsed && 'Settings'}
          </button>
        </div>

        {/* Resize handle (only when expanded) */}
        {!collapsed && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: -1,
              bottom: 0,
              width: 5,
              cursor: 'col-resize',
              zIndex: 10,
            }}
            onMouseDown={(e) => {
              const handle = e.currentTarget;
              handle.style.background = 'var(--text-muted)';
              const cleanup = () => {
                handle.style.background = 'transparent';
                window.removeEventListener('mouseup', cleanup);
              };
              window.addEventListener('mouseup', cleanup);
              handleResizeStart(e);
            }}
          />
        )}
      </div>

      {/* Menus */}
      {(contextMenu || addMenu) && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 200 }}
          onClick={() => {
            setContextMenu(null);
            setAddMenu(null);
            setShowRecentSub(false);
          }}
        >
          {contextMenu && (
            <div
              style={{
                position: 'absolute',
                left: contextMenu.x,
                top: contextMenu.y,
                background: 'var(--bg-surface)',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                overflow: 'hidden',
                minWidth: '140px',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {contextMenu.confirmClose ? (
                <>
                  <div style={{ padding: '8px 14px 6px', fontSize: '12px', color: 'var(--text-secondary)', maxWidth: 200 }}>
                    Close{' '}
                    <strong style={{ color: 'var(--text-primary)' }}>
                      {workspaces.find((w) => w.id === contextMenu.id)?.name ?? 'workspace'}
                    </strong>
                    ?
                  </div>
                  <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />
                  <button
                    style={menuItemStyle('var(--text-primary)')}
                    onClick={() => setContextMenu(null)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {menuIcon('M4 4l8 8M12 4l-8 8')}
                    Cancel
                  </button>
                  <button
                    style={menuItemStyle('var(--accent-red)')}
                    onClick={() => { onDeleteWorkspace(contextMenu.id); setContextMenu(null); }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {menuIcon('M2 4h12M5 4V2.5h6V4M6 7v5M10 7v5M3.5 4l.5 10h8l.5-10')}
                    Close workspace
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      const ws = workspaces.find((w) => w.id === contextMenu.id);
                      if (ws) handleStartRename(ws.id, ws.name);
                    }}
                    style={menuItemStyle('var(--text-primary)')}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {menuIcon('M11.5 2.5l2 2-7.5 7.5H4v-2z')}
                    Rename
                  </button>
                  <button
                    onClick={() => { onOpenSettings(contextMenu.id); setContextMenu(null); }}
                    style={menuItemStyle('var(--text-primary)')}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <GearIcon size={14} />
                    Settings
                  </button>
                  {(() => {
                    const ws = workspaces.find((w) => w.id === contextMenu.id);
                    const wsMuted = !!ws?.notifyMuted;
                    return (
                      <button
                        onClick={() => { onToggleWorkspaceMute?.(contextMenu.id, !wsMuted); setContextMenu(null); }}
                        style={menuItemStyle('var(--text-primary)')}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        {wsMuted
                          ? menuIcon('M3 6h2l3-2.5v9L5 10H3z M10.5 6.5l3 3M13.5 6.5l-3 3')
                          : menuIcon('M3 6h2l3-2.5v9L5 10H3z M10.5 5.5a3.5 3.5 0 010 5')}
                        {wsMuted ? 'Unmute notifications' : 'Mute notifications'}
                      </button>
                    );
                  })()}
                  <button
                    onClick={() => { onToggleMuteAll?.(!muteAll); setContextMenu(null); }}
                    style={menuItemStyle(muteAll ? 'var(--accent-red)' : 'var(--text-secondary)')}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {muteAll
                      ? menuIcon('M3 6h2l3-2.5v9L5 10H3z M10.5 6.5l3 3M13.5 6.5l-3 3')
                      : menuIcon('M3 6h2l3-2.5v9L5 10H3z M10.5 5.5a3.5 3.5 0 010 5M12 4a6 6 0 010 8')}
                    {muteAll ? 'Unmute all (global)' : 'Mute all (global)'}
                  </button>
                  {workspaces.find((w) => w.id === contextMenu.id)?.frozen ? (
                    <button
                      onClick={() => { onUnfreezeWorkspace(contextMenu.id); setContextMenu(null); }}
                      style={menuItemStyle('var(--text-primary)')}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {menuIcon('M5 3.5v9l7-4.5z')}
                      Unfreeze
                    </button>
                  ) : contextMenu.id !== activeWorkspaceId ? (
                    <button
                      onClick={() => { onFreezeWorkspace(contextMenu.id); setContextMenu(null); }}
                      style={menuItemStyle('var(--text-primary)')}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {menuIcon('M8 1.5v13M2.2 4.7l11.6 6.6M13.8 4.7L2.2 11.3')}
                      Freeze
                    </button>
                  ) : null}
                  <button
                    onClick={() => setContextMenu({ ...contextMenu, confirmClose: true })}
                    style={menuItemStyle('var(--accent-red)')}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {menuIcon('M2 4h12M5 4V2.5h6V4M6 7v5M10 7v5M3.5 4l.5 10h8l.5-10')}
                    Close
                  </button>
                </>
              )}
            </div>
          )}

          {addMenu && (
            <div
              style={{
                position: 'absolute',
                left: addMenu.x,
                top: addMenu.y,
                background: 'var(--bg-surface)',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                // Must stay visible so the "Open Recent" flyout (positioned at
                // left:100%) isn't clipped away. The flyout itself clips its own
                // rounded corners; this container only rounds via border-radius.
                overflow: 'visible',
                minWidth: '120px',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  onCreateWorkspace(`Workspace ${workspaces.length + 1}`);
                  setAddMenu(null);
                }}
                style={{ ...menuItemStyle('var(--text-primary)'), borderTopLeftRadius: 5, borderTopRightRadius: 5 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {menuIcon('M8 3.5v9M3.5 8h9')}
                New
              </button>
              <button
                onClick={async () => {
                  const dir = await window.electronAPI.selectDirectory();
                  if (dir) {
                    const parts = dir.split('/').filter(Boolean);
                    const name = parts[parts.length - 1] || `Workspace ${workspaces.length + 1}`;
                    const created = onCreateWorkspace(name);
                    if (created && 'id' in created) {
                      onSetWorkingDirectory(created.id, dir);
                    }
                  }
                  setAddMenu(null);
                }}
                style={menuItemStyle('var(--text-primary)')}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {menuIcon('M1.5 4.5h4l1.5 1.5h7.5v7h-13zM1.5 6.5h13')}
                Open
              </button>

              {/* Open Recent — flyout submenu of recently-closed workspaces */}
              <div
                style={{ position: 'relative' }}
                onMouseEnter={() => setShowRecentSub(true)}
                onMouseLeave={() => setShowRecentSub(false)}
              >
                <div
                  style={{
                    ...menuItemStyle('var(--text-primary)'),
                    justifyContent: 'space-between',
                    cursor: 'default', userSelect: 'none',
                    background: showRecentSub ? 'var(--bg-hover)' : 'transparent',
                    borderBottomLeftRadius: 5, borderBottomRightRadius: 5,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {menuIcon('M8 4.5v3.5l2.5 1.5M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13')}
                    Open Recent
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>›</span>
                </div>
                {showRecentSub && (
                  <div
                    style={{
                      position: 'absolute', left: '100%', top: -5,
                      background: 'var(--bg-surface)', borderRadius: '6px',
                      border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                      overflow: 'hidden', minWidth: 210, maxWidth: 340,
                    }}
                  >
                    {filteredRecent.length === 0 ? (
                      <div style={{ padding: '8px 14px', fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        No recent workspaces
                      </div>
                    ) : (
                      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                        {filteredRecent.map((ws) => (
                          <button
                            key={ws.id}
                            onClick={() => { onOpenRecentWorkspace(ws); setAddMenu(null); setShowRecentSub(false); }}
                            title={ws.workingDirectory ?? ws.name}
                            style={{ display: 'block', width: '100%', padding: '7px 14px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            <div style={{ fontSize: '12px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {ws.name}
                            </div>
                            {ws.workingDirectory && (
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {ws.workingDirectory}
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {collapsed && hoverPreview && (() => {
        const ws = workspaces.find((w) => w.id === hoverPreview.wsId);
        if (!ws) return null;
        const rows = terminalRowsByWorkspaceId?.get(ws.id) ?? [];
        const active = ws.id === activeWorkspaceId;
        const top = Math.min(hoverPreview.top, window.innerHeight - 40 - rows.length * 18);
        return (
          <div
            style={{
              position: 'fixed',
              top: Math.max(8, top),
              left: hoverPreview.left,
              zIndex: 9000,
              minWidth: '170px',
              maxWidth: '300px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '8px 10px',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
              pointerEvents: 'none',
            }}
          >
            <div style={{
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--text-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {ws.name}
            </div>
            {rows.map((row) => renderSubrow(row, active, { showStatus: true }))}
          </div>
        );
      })()}
    </>
  );
};

const menuItemStyle = (color: string): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  width: '100%',
  padding: '7px 14px',
  textAlign: 'left',
  fontSize: '12px',
  color,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
});

const menuIcon = (d: string) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d={d} />
  </svg>
);

const bottomBtnStyle = (collapsed: boolean): React.CSSProperties => ({
  width: collapsed ? '36px' : '100%',
  height: collapsed ? '36px' : '28px',
  margin: collapsed ? '0 auto' : '0',
  borderRadius: '6px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: collapsed ? 'center' : 'flex-start',
  gap: '8px',
  padding: collapsed ? '0' : '0 10px',
  fontSize: '11px',
  color: 'var(--text-muted)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
});
