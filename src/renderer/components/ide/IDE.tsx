import React, { useState, useCallback, useRef, useEffect, Component, type ErrorInfo, type ReactNode } from 'react';
import { IDEFileExplorer } from './IDEFileExplorer';
import { IDETabBar } from './IDETabBar';
import { IDEEditor, disposeModel, markModelSaved, getModelContent, reloadModelFromDisk } from './IDEEditor';
import { useTabs } from './useTabs';
import type {
  IDEContainerState,
  IDEExplorerState,
  WorkspaceSyncFileState,
  WorkspaceSyncConfig,
} from '../../../shared/types';
import { TEMP_DISABLE_INPUT_INTERCEPTS } from '../../../shared/runtime-flags';
import { latinKey } from '../../../shared/keyboard';
import { ToastContainer } from '../Toast';

class IDEErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('IDE crash:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: 'var(--accent-red)', fontSize: 13, fontFamily: 'monospace', overflow: 'auto', height: '100%', background: 'var(--bg-primary)' }}>
          <strong>IDE Error</strong>
          <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{this.state.error.message}{'\n'}{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

interface Props {
  workspaceId: string;
  rootPath: string;
  zoomLevel: number;
  onClose?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  workspaceSync?: WorkspaceSyncConfig;
  onSyncEvent?: (event: {
    action: 'save' | 'create-file' | 'create-directory' | 'rename' | 'delete';
    filePath: string;
    oldPath?: string;
    isDirectory?: boolean;
    skippedByGitIgnore?: boolean;
    targetResults: Array<{ targetId: string; ok: boolean; error?: string }>;
    at: number;
  }) => void;
  syncedFileStates?: Record<string, WorkspaceSyncFileState>;
  initialState?: IDEContainerState;
  onStateChange?: (state: IDEContainerState) => void;
}

const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 240;
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 28;

function clampFont(size: number) {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

export const IDE: React.FC<Props> = ({
  workspaceId,
  rootPath,
  zoomLevel,
  onClose,
  onSplitRight,
  onSplitDown,
  workspaceSync,
  onSyncEvent,
  syncedFileStates,
  initialState,
  onStateChange,
}) => {
  const tabs = useTabs(initialState);
  const [sidebarWidth, setSidebarWidth] = useState(initialState?.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialState?.sidebarCollapsed ?? false);
  const [editorFontSize, setEditorFontSize] = useState(
    clampFont(zoomLevel ?? initialState?.editorFontSize ?? DEFAULT_FONT_SIZE)
  );
  const [explorerState, setExplorerState] = useState<IDEExplorerState>(
    initialState?.explorer ?? { expandedItems: [], selectedItems: [], focusedItem: null }
  );
  const isResizing = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  // File open (single click = preview)
  const handleFileOpen = useCallback(
    (filePath: string, preview = true) => {
      tabs.openFile(filePath, preview);
    },
    [tabs.openFile]
  );

  // File double-click (pin the tab)
  const handleFileDoubleClick = useCallback(
    (filePath: string) => {
      tabs.openFile(filePath, false);
    },
    [tabs.openFile]
  );

  // Save file
  const handleSave = useCallback(async (filePath: string, content: string) => {
    try {
      const result = await window.electronAPI.writeFileWithSync(filePath, content, {
        workspaceId,
        localRootPath: rootPath,
        sync: workspaceSync ?? null,
      });
      onSyncEvent?.({
        action: 'save',
        filePath,
        skippedByGitIgnore: result.skippedByGitIgnore,
        targetResults: result.targetResults,
        at: Date.now(),
      });
      markModelSaved(filePath);
      tabs.setDirty(filePath, false);
    } catch (err) {
      console.error('Failed to save file:', filePath, err);
    }
  }, [tabs.setDirty, workspaceId, rootPath, workspaceSync, onSyncEvent]);

  // Close tab — save prompt for dirty files
  const handleCloseTab = useCallback(async (tabId: string) => {
    const tab = tabs.tabs.find(t => t.id === tabId);
    if (tab?.isDirty) {
      // Auto-save on close
      const content = getModelContent(tabId);
      if (content !== null) {
        await handleSave(tabId, content);
      }
    }
    disposeModel(tabId);
    tabs.closeTab(tabId);
  }, [tabs.tabs, tabs.closeTab, handleSave]);

  // Dirty state change from editor
  const handleDirtyChange = useCallback(
    (filePath: string, dirty: boolean) => {
      tabs.setDirty(filePath, dirty);
    },
    [tabs.setDirty]
  );

  // Sidebar resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = ev.clientX - startX;
      const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const onUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  // Keyboard shortcuts
  useEffect(() => {
    if (TEMP_DISABLE_INPUT_INTERCEPTS) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Physical-position match so the chords still fire under a non-latin
      // keyboard layout (where e.key would be a Cyrillic character).
      const key = latinKey(e);

      // Cmd+B = toggle sidebar
      if (mod && key === 'b') {
        e.preventDefault();
        setSidebarCollapsed(v => !v);
      }

      // Cmd+W = close active tab
      if (mod && key === 'w') {
        const root = rootRef.current;
        const active = document.activeElement as HTMLElement | null;
        const isIdeDomFocused = !!(root && active && root.contains(active));
        const isIdeHovered = !!root?.matches(':hover');
        const isIdeContainerFocused = !!root?.closest('[data-container-id]')?.classList.contains('container-focused');
        if (!isIdeContainerFocused && !isIdeDomFocused && !isIdeHovered) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (tabs.activeTabId) handleCloseTab(tabs.activeTabId);
      }

    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [tabs.activeTabId, handleCloseTab]);

  // Watch all open tab files for external changes (background processes, SFTP pull, etc.)
  // Uses the recursive directory watcher — reloads Monaco models when files change on disk.
  const tabFilePathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    tabFilePathsRef.current = new Set(tabs.tabs.map(t => t.filePath));
  }, [tabs.tabs]);

  useEffect(() => {
    const unsub = window.electronAPI.onFilesChanged((files) => {
      for (const filePath of files) {
        if (!tabFilePathsRef.current.has(filePath)) continue;
        reloadModelFromDisk(filePath).then((updated) => {
          if (updated) {
            tabs.setDirty(filePath, false);
          }
        });
      }
    });
    return () => unsub();
  }, [tabs.setDirty]);

  useEffect(() => {
    setEditorFontSize(clampFont(zoomLevel));
  }, [zoomLevel]);

  const effectiveSidebarWidth = sidebarCollapsed ? 0 : sidebarWidth;

  useEffect(() => {
    if (!onStateChangeRef.current) return;
    const timer = setTimeout(() => {
      onStateChangeRef.current?.({
        tabs: tabs.tabs.map((tab) => ({
          filePath: tab.filePath,
          isPreview: tab.isPreview,
        })),
        activeTabId: tabs.activeTabId,
        sidebarWidth,
        sidebarCollapsed,
        editorFontSize,
        explorer: explorerState,
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [
    tabs.tabs,
    tabs.activeTabId,
    sidebarWidth,
    sidebarCollapsed,
    editorFontSize,
    explorerState,
  ]);

  return (
    <IDEErrorBoundary>
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        overflow: 'hidden',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        position: 'relative',
      }}
    >
      {/* Main content area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Sidebar */}
        {!sidebarCollapsed && (
          <>
            <div
              onMouseDownCapture={(e) => {
                (e.currentTarget as HTMLElement).closest('[data-container-id]')?.setAttribute('data-ide-active-panel', 'sidebar');
              }}
              style={{
                width: effectiveSidebarWidth,
                minWidth: effectiveSidebarWidth,
                maxWidth: effectiveSidebarWidth,
                height: '100%',
                overflow: 'hidden',
                background: 'var(--bg-primary)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <IDEFileExplorer
                workspaceId={workspaceId}
                rootPath={rootPath}
                onFileOpen={handleFileOpen}
                onFileDoubleClick={handleFileDoubleClick}
                onContainerClose={onClose}
                workspaceSync={workspaceSync}
                onSyncEvent={onSyncEvent}
                syncedFileStates={syncedFileStates}
                initialState={initialState?.explorer}
                onStateChange={setExplorerState}
              />
            </div>

            {/* Resize handle */}
            <div
              onMouseDown={(e) => {
                const handle = e.currentTarget;
                handle.style.background = 'linear-gradient(to right, transparent calc(50% - 1px), var(--text-muted) calc(50% - 1px), var(--text-muted) calc(50% + 1px), transparent calc(50% + 1px))';
                const cleanup = () => {
                  handle.style.background = 'linear-gradient(to right, transparent calc(50% - 0.5px), var(--border-subtle) calc(50% - 0.5px), var(--border-subtle) calc(50% + 0.5px), transparent calc(50% + 0.5px))';
                  window.removeEventListener('mouseup', cleanup);
                };
                window.addEventListener('mouseup', cleanup);
                handleResizeStart(e);
              }}
              style={{
                width: 6,
                cursor: 'col-resize',
                background: 'linear-gradient(to right, transparent calc(50% - 0.5px), var(--border-subtle) calc(50% - 0.5px), var(--border-subtle) calc(50% + 0.5px), transparent calc(50% + 0.5px))',
                flexShrink: 0,
                zIndex: 10,
              }}
            />
          </>
        )}

        {/* Editor area */}
        <div
          ref={editorAreaRef}
          onMouseDownCapture={(e) => {
            (e.currentTarget as HTMLElement).closest('[data-container-id]')?.setAttribute('data-ide-active-panel', 'editor');
          }}
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minWidth: 0,
          }}
        >
          {/* Tab bar (also serves as the container header / drag handle) */}
          <IDETabBar
            tabs={tabs.tabs}
            activeTabId={tabs.activeTabId}
            onActivate={tabs.setActiveTabId}
            onClose={handleCloseTab}
            onCloseOthers={tabs.closeOtherTabs}
            onCloseAll={tabs.closeAllTabs}
            onCloseToRight={tabs.closeTabsToRight}
            onPin={tabs.pinTab}
            onReorder={tabs.reorderTab}
            onContainerSplitRight={onSplitRight}
            onContainerSplitDown={onSplitDown}
          />

          {/* Editor */}
          <IDEEditor
            filePath={tabs.activeTab?.filePath ?? null}
            onDirtyChange={handleDirtyChange}
            onSave={handleSave}
            fontSize={editorFontSize}
          />
        </div>
      </div>

      <ToastContainer />
    </div>
    </IDEErrorBoundary>
  );
};
