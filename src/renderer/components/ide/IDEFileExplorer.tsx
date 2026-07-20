import React, { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react';
import {
  ControlledTreeEnvironment,
  Tree,
  TreeItem,
  TreeItemIndex,
  InteractionMode,
} from 'react-complex-tree';
import 'react-complex-tree/lib/style-modern.css';
import './ide-tree.css';
import { useFileTree, type FileTreeItem } from './useFileTree';
import { IDEContextMenu, type ContextMenuEntry } from './IDEContextMenu';
import { FileTypeIcon } from './IDEFileIcons';
import { basename, dirname, joinPath } from './utils';
import type {
  IDEExplorerState,
  WorkspaceSyncConfig,
  WorkspaceSyncFileState,
} from '../../../shared/types';
import { TEMP_DISABLE_INPUT_INTERCEPTS } from '../../../shared/runtime-flags';
import { toast } from '../Toast';
import { SPLITGRID_PATH_MIME, shellQuote } from '../terminalDrop';

// How long the one-shot "just synced" highlight plays. Keep in sync with the
// .ide-sync-flash animation duration in ide-tree.css.
const SYNC_FLASH_MS = 1000;

interface Props {
  workspaceId: string;
  rootPath: string;
  onFileOpen: (filePath: string, preview?: boolean) => void;
  onFileDoubleClick: (filePath: string) => void;
  onContainerClose?: () => void;
  workspaceSync?: WorkspaceSyncConfig;
  onSyncEvent?: (event: {
    action: 'create-file' | 'create-directory' | 'rename' | 'delete';
    filePath: string;
    oldPath?: string;
    isDirectory?: boolean;
    targetResults: Array<{ targetId: string; ok: boolean; error?: string }>;
    at: number;
  }) => void;
  syncedFileStates?: Record<string, WorkspaceSyncFileState>;
  initialState?: IDEExplorerState;
  onStateChange?: (state: IDEExplorerState) => void;
}

interface InlineInput {
  parentDir: string;
  kind: 'file' | 'folder';
  renameFrom?: string;
}

export const IDEFileExplorer: React.FC<Props> = memo(({
  workspaceId,
  rootPath,
  onFileOpen,
  onFileDoubleClick,
  onContainerClose,
  workspaceSync,
  onSyncEvent,
  syncedFileStates,
  initialState,
  onStateChange,
}) => {
  const { items, loadDirectory, refreshDirectory, refreshAll } =
    useFileTree(rootPath);

  const [focusedItem, setFocusedItem] = useState<TreeItemIndex | undefined>(
    initialState?.focusedItem ?? undefined
  );
  const [expandedItems, setExpandedItems] = useState<TreeItemIndex[]>(
    initialState?.expandedItems ?? []
  );
  const [selectedItems, setSelectedItems] = useState<TreeItemIndex[]>(
    initialState?.selectedItems ?? []
  );

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: TreeItem<FileTreeItem>;
  } | null>(null);

  const [inlineInput, setInlineInput] = useState<InlineInput | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const inputHandledRef = useRef(false);
  const restoredExpandedRef = useRef(false);

  useEffect(() => {
    if (!onStateChange) return;
    onStateChange({
      expandedItems: expandedItems.map((x) => String(x)),
      selectedItems: selectedItems.map((x) => String(x)),
      focusedItem: focusedItem ? String(focusedItem) : null,
    });
  }, [expandedItems, selectedItems, focusedItem, onStateChange]);

  useEffect(() => {
    if (restoredExpandedRef.current) return;
    if (expandedItems.length === 0) return;
    restoredExpandedRef.current = true;
    // loadDirectory resolves each dir's full ancestor chain and de-dupes
    // in-flight loads, so the contents of restored expanded folders populate
    // reliably regardless of which load finishes first — no manual ordering.
    for (const id of expandedItems) {
      const path = String(id);
      void loadDirectory(path === 'root' ? rootPath : path);
    }
  }, [expandedItems, loadDirectory, rootPath]);

  useEffect(() => {
    if (inlineInput) {
      inputHandledRef.current = false;
      if (!inlineInput.renameFrom && newInputRef.current) {
        newInputRef.current.focus();
      }
    }
  }, [inlineInput]);

  useEffect(() => {
    if (inlineInput?.renameFrom && renameInputRef.current) {
      const name = basename(inlineInput.renameFrom);
      renameInputRef.current.value = name;
      const dotIdx = name.lastIndexOf('.');
      renameInputRef.current.setSelectionRange(0, dotIdx > 0 ? dotIdx : name.length);
      renameInputRef.current.focus();
    }
  }, [inlineInput]);

  const restoreTreeFocus = useCallback(() => {
    requestAnimationFrame(() => {
      const el = containerRef.current;
      if (!el) return;
      const focused = el.querySelector<HTMLElement>(
        '.rct-tree-item-title-container-focused .rct-tree-item-button',
      );
      if (focused) { focused.focus(); return; }
      const tree = el.querySelector<HTMLElement>('[role="tree"]');
      tree?.focus();
    });
  }, []);

  const commitInput = useCallback(
    async (value: string) => {
      if (!inlineInput || inputHandledRef.current) return;
      inputHandledRef.current = true;

      const name = value.trim();
      if (!name) {
        setInlineInput(null);
        restoreTreeFocus();
        return;
      }

      const fullPath = joinPath(inlineInput.parentDir, name);
      try {
        if (inlineInput.renameFrom) {
          const syncResult = await window.electronAPI.moveFileWithSync(
            inlineInput.renameFrom,
            fullPath,
            {
              workspaceId,
              localRootPath: rootPath,
              sync: workspaceSync ?? null,
            }
          );
          onSyncEvent?.({
            action: 'rename',
            filePath: fullPath,
            oldPath: inlineInput.renameFrom,
            isDirectory: inlineInput.kind === 'folder',
            targetResults: syncResult.targetResults,
            at: Date.now(),
          });
          await refreshDirectory(inlineInput.parentDir);
          setFocusedItem(fullPath);
          setSelectedItems([fullPath]);
        } else if (inlineInput.kind === 'folder') {
          const syncResult = await window.electronAPI.createDirectoryWithSync(fullPath, {
            workspaceId,
            localRootPath: rootPath,
            sync: workspaceSync ?? null,
          });
          onSyncEvent?.({
            action: 'create-directory',
            filePath: fullPath,
            isDirectory: true,
            targetResults: syncResult.targetResults,
            at: Date.now(),
          });
          await refreshDirectory(inlineInput.parentDir);
          setFocusedItem(fullPath);
          setSelectedItems([fullPath]);
        } else {
          const syncResult = await window.electronAPI.createFileWithSync(fullPath, {
            workspaceId,
            localRootPath: rootPath,
            sync: workspaceSync ?? null,
          });
          onSyncEvent?.({
            action: 'create-file',
            filePath: fullPath,
            isDirectory: false,
            targetResults: syncResult.targetResults,
            at: Date.now(),
          });
          await refreshDirectory(inlineInput.parentDir);
          onFileOpen(fullPath, false);
          setFocusedItem(fullPath);
          setSelectedItems([fullPath]);
        }
      } catch (err) {
        console.error('File operation failed:', err);
      }
      setInlineInput(null);
      restoreTreeFocus();
    },
    [inlineInput, refreshDirectory, onFileOpen, restoreTreeFocus, workspaceId, rootPath, workspaceSync, onSyncEvent],
  );

  const handleDelete = useCallback(
    async (filePath: string, isDirectory: boolean) => {
      try {
        const syncResult = await window.electronAPI.trashItemWithSync(filePath, {
          workspaceId,
          localRootPath: rootPath,
          sync: workspaceSync ?? null,
        });
        onSyncEvent?.({
          action: 'delete',
          filePath,
          isDirectory,
          targetResults: syncResult.targetResults,
          at: Date.now(),
        });
        await refreshDirectory(dirname(filePath));
      } catch (err) {
        console.error('Delete failed:', err);
      }
    },
    [refreshDirectory, workspaceId, rootPath, workspaceSync, onSyncEvent],
  );

  const startRename = useCallback(
    (itemIndex: TreeItemIndex) => {
      if (itemIndex === 'root') return;
      const path = String(itemIndex);
      const treeItem = items[path];
      if (!treeItem) return;
      setInlineInput({
        parentDir: dirname(path),
        kind: treeItem.isFolder ? 'folder' : 'file',
        renameFrom: path,
      });
    },
    [items],
  );

  // Inline SVG icons for context menu (14x14, currentColor)
  const ctxIcon = (d: string) => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
  const iconNewFile = ctxIcon('M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1zM9 1v4h4M8 9v4M6 11h4');
  const iconNewFolder = ctxIcon('M1.5 3.5h4l1.5 1.5h6.5v9h-12zM8 8.5v4M6 10.5h4');
  const iconRename = ctxIcon('M12.5 3.5l-9 9H2v-1.5l9-9zM10 6l1.5 1.5');
  const iconCopyPath = ctxIcon('M5 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1M7 4h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2');
  const iconDelete = ctxIcon('M2 4h12M5 4V2.5h6V4M6 7v5M10 7v5M3.5 4l.5 10h8l.5-10');
  const iconRefresh = ctxIcon('M1.5 8a6.5 6.5 0 0 1 11-4.7M14.5 8a6.5 6.5 0 0 1-11 4.7M1.5 1.5v4h4M14.5 14.5v-4h-4');
  const iconUpload = ctxIcon('M8 10V2M4.5 5.5L8 2l3.5 3.5M3 10v3h10v-3');
  const iconDownload = ctxIcon('M8 2v8M4.5 6.5L8 10l3.5-3.5M3 12v2h10v-2');

  const buildContextMenu = useCallback(
    (item: TreeItem<FileTreeItem>): ContextMenuEntry[] => {
      const clickedPath = item.data.path;
      const isDir = !!item.isFolder;
      const parent = dirname(clickedPath);

      // Resolve effective selection: if clicked item is in selection, use all selected; otherwise just clicked
      const clickedInSelection = selectedItems.includes(item.index);
      const effectivePaths: string[] = clickedInSelection
        ? selectedItems.map(idx => {
            const ti = items[String(idx)];
            return ti ? ti.data.path : String(idx);
          }).filter(Boolean)
        : [clickedPath];
      const sftpPaths = effectivePaths;
      const multi = effectivePaths.length > 1;

      const entries: ContextMenuEntry[] = [];

      // New File/Folder — unary, only on clicked dir
      if (isDir) {
        entries.push(
          { label: 'New File', icon: iconNewFile, action: () => setInlineInput({ parentDir: clickedPath, kind: 'file' }) },
          { label: 'New Folder', icon: iconNewFolder, action: () => setInlineInput({ parentDir: clickedPath, kind: 'folder' }) },
          { separator: true },
        );
      }

      // Rename — unary only
      if (!multi) {
        entries.push(
          { label: 'Rename', icon: iconRename, shortcut: 'F2', action: () => startRename(item.index) },
        );
      }

      // Copy Path — multi: copy all paths separated by newlines
      entries.push(
        { label: multi ? `Copy ${effectivePaths.length} Paths` : 'Copy Path', icon: iconCopyPath, action: () => {
          navigator.clipboard.writeText(effectivePaths.join('\n'));
        }},
        { separator: true },
      );

      // Delete — multi
      entries.push(
        {
          label: multi ? `Delete ${effectivePaths.length} Items` : 'Delete',
          icon: iconDelete,
          danger: true,
          action: () => {
            for (const p of effectivePaths) {
              const ti = items[p];
              handleDelete(p, !!ti?.isFolder);
            }
          },
        },
      );

      // SFTP push/pull — multi, with per-file progress
      const hasSyncTargets = workspaceSync?.enabled && workspaceSync.targets.some(t => t.enabled);
      if (hasSyncTargets) {
        const sftpAction = (direction: 'push' | 'pull') => async () => {
          const dirLabel = direction === 'push' ? 'Push' : 'Pull';
          // Client-generated id so we can cancel this run mid-flight.
          const syncId = crypto.randomUUID();
          const tid = toast.loading(`${dirLabel}ing...`, undefined, {
            label: 'Cancel',
            onClick: () => { void window.electronAPI.cancelSftpSync(syncId); },
          });
          const unsub = window.electronAPI.onSftpProgress((info) => {
            if (info.direction !== direction) return;
            const shortFile = info.file.length > 40
              ? '...' + info.file.slice(-37)
              : info.file;
            const progress = info.total > 0 ? `${info.current}/${info.total}` : `${info.current}`;
            toast.update(tid, { message: `${dirLabel}ing [${progress}]`, detail: shortFile });
          });
          try {
            const apiFn = direction === 'push'
              ? window.electronAPI.sftpPushPaths
              : window.electronAPI.sftpPullPaths;
            const result = await apiFn(
              sftpPaths,
              { workspaceId, localRootPath: rootPath, sync: workspaceSync!, syncId },
            );
            unsub();
            const count = (result as any).pushed ?? (result as any).pulled ?? 0;
            const ok = result.targetResults.every(r => r.ok);
            if (result.cancelled) {
              toast.update(tid, { type: 'info', message: `${dirLabel} cancelled`, detail: `${count} file${count !== 1 ? 's' : ''} done`, duration: 2000, action: null });
            } else if (ok) {
              toast.update(tid, { type: 'success', message: `${dirLabel}ed`, detail: `${count} file${count !== 1 ? 's' : ''}`, duration: 1000, action: null });
            } else {
              const errs = result.targetResults.filter(r => !r.ok).map(r => r.error).join(', ');
              toast.update(tid, { type: 'error', message: `${dirLabel} failed`, detail: errs, duration: 3000, action: null });
            }
            if (direction === 'push') {
              onSyncEvent?.({
                action: 'create-file', filePath: clickedPath, isDirectory: isDir,
                targetResults: result.targetResults.map(r => ({ targetId: r.targetId, ok: r.ok, error: r.error })),
                at: Date.now(),
              });
            } else {
              // Refresh affected parents after pull
              const parents = new Set(sftpPaths.map(p => {
                const ti = items[p];
                return ti?.isFolder ? p : dirname(p);
              }));
              for (const p of parents) refreshDirectory(p);
            }
          } catch (e: any) {
            unsub();
            toast.update(tid, { type: 'error', message: `${dirLabel} failed`, detail: e?.message, duration: 3000, action: null });
          }
        };

        entries.push(
          { separator: true },
          {
            label: multi ? `SFTP Push (${effectivePaths.length})` : 'SFTP Push',
            icon: iconUpload,
            action: sftpAction('push'),
          },
          {
            label: multi ? `SFTP Pull (${effectivePaths.length})` : 'SFTP Pull',
            icon: iconDownload,
            action: sftpAction('pull'),
          },
        );
      }

      entries.push(
        { separator: true },
        { label: 'Refresh', icon: iconRefresh, action: () => (isDir ? refreshDirectory(clickedPath) : refreshDirectory(parent)) },
      );

      return entries;
    },
    [handleDelete, startRename, refreshDirectory, workspaceSync, workspaceId, rootPath, onSyncEvent, selectedItems, items],
  );

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        commitInput(e.currentTarget.value);
      }
      if (e.key === 'Escape') {
        inputHandledRef.current = true;
        setInlineInput(null);
        restoreTreeFocus();
      }
      e.stopPropagation();
      e.nativeEvent.stopPropagation();
    },
    [commitInput, restoreTreeFocus],
  );

  useEffect(() => {
    if (TEMP_DISABLE_INPUT_INTERCEPTS) return;
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (inlineInput) return;

      if (e.key === 'Enter' || e.key === 'F2') {
        if (focusedItem && focusedItem !== 'root') {
          e.preventDefault();
          e.stopPropagation();
          startRename(focusedItem);
        }
      }

      if (e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (focusedItem && focusedItem !== 'root') {
          const path = String(focusedItem);
          const treeItem = items[path];
          if (treeItem && !treeItem.isFolder) {
            onFileOpen(path, true);
          }
        }
      }
    };
    el.addEventListener('keydown', handler, true);
    return () => el.removeEventListener('keydown', handler, true);
  }, [focusedItem, inlineInput, startRename, items, onFileOpen]);

  const handleFocusItem = useCallback(
    (item: TreeItem<FileTreeItem>, treeId: string) => {
      // Only move focus. Selection is owned by onSelectItems so that
      // Ctrl/Cmd+click and Shift+click multi-selection isn't reset by the
      // focus event react-complex-tree fires during navigation.
      setFocusedItem(item.index);
    },
    [],
  );

  const handleExpandItem = useCallback(
    (item: TreeItem<FileTreeItem>, treeId: string) => {
      setExpandedItems((prev) => (prev.includes(item.index) ? prev : [...prev, item.index]));
      const path = String(item.index);
      const dirPath = path === 'root' ? rootPath : path;
      loadDirectory(dirPath);
    },
    [rootPath, loadDirectory],
  );

  const handleCollapseItem = useCallback(
    (item: TreeItem<FileTreeItem>, treeId: string) => {
      setExpandedItems((prev) => prev.filter((id) => id !== item.index));
    },
    [],
  );

  const handleSelectItems = useCallback(
    (itemIds: TreeItemIndex[], treeId: string) => {
      setSelectedItems(itemIds);
      if (itemIds.length === 1) {
        const id = String(itemIds[0]);
        if (id !== 'root') {
          const treeItem = items[id];
          if (treeItem && !treeItem.isFolder) {
            onFileOpen(id, true);
          }
        }
      }
    },
    [items, onFileOpen],
  );

  const handlePrimaryAction = useCallback(
    (item: TreeItem<FileTreeItem>, treeId: string) => {
      if (!item.isFolder) {
        onFileDoubleClick(String(item.index));
      }
    },
    [onFileDoubleClick],
  );

  const resolveItemPath = useCallback(
    (itemIndex: string) => (itemIndex === 'root' ? rootPath : itemIndex),
    [rootPath],
  );

  const handleDrop = useCallback(
    async (droppedItems: TreeItem<FileTreeItem>[], target: any) => {
      for (const item of droppedItems) {
        const srcPath = String(item.index);
        let destDir: string;
        if (target.targetType === 'item') {
          destDir = resolveItemPath(String(target.targetItem));
        } else if (target.targetType === 'between-items') {
          destDir = resolveItemPath(String(target.parentItem));
        } else {
          destDir = rootPath;
        }
        const destPath = joinPath(destDir, basename(srcPath));
        if (srcPath !== destPath) {
          try {
            const syncResult = await window.electronAPI.moveFileWithSync(srcPath, destPath, {
              workspaceId,
              localRootPath: rootPath,
              sync: workspaceSync ?? null,
            });
            onSyncEvent?.({
              action: 'rename',
              filePath: destPath,
              oldPath: srcPath,
              isDirectory: item.isFolder,
              targetResults: syncResult.targetResults,
              at: Date.now(),
            });
            await refreshDirectory(dirname(srcPath));
            await refreshDirectory(destDir);
          } catch (err) {
            console.error('Move failed:', err);
          }
        }
      }
    },
    [rootPath, resolveItemPath, refreshDirectory, workspaceId, workspaceSync, onSyncEvent],
  );

  const handleMissingItems = useCallback(
    (itemIds: TreeItemIndex[]) => {
      for (const id of itemIds) {
        const path = String(id);
        if (path === 'root') {
          loadDirectory(rootPath);
        } else {
          loadDirectory(dirname(path));
        }
      }
    },
    [rootPath, loadDirectory],
  );

  const getItemTitle = useCallback(
    (item: TreeItem<FileTreeItem>) => item.data.name,
    [],
  );

  const resolveContextTargetItem = useCallback((): TreeItem<FileTreeItem> => {
    const candidate = selectedItems[0] ?? focusedItem;
    if (candidate != null) {
      const key = String(candidate);
      const fromMap = items[key];
      if (fromMap) return fromMap;
    }
    return {
      index: 'root',
      data: { name: basename(rootPath), path: rootPath, isDirectory: true },
      isFolder: true,
      children: [],
      canMove: false,
      canRename: false,
    };
  }, [selectedItems, focusedItem, items, rootPath]);

  const viewState = useMemo(
    () => ({ 'ide-tree': { focusedItem, expandedItems, selectedItems } }),
    [focusedItem, expandedItems, selectedItems],
  );

  // Brief one-shot highlight on a file/folder name the moment it's synced to a
  // remote. syncedFileStates is persisted (it loads with PAST timestamps), so we
  // seed the seen-map on first observation and only flash entries whose updatedAt
  // advances afterwards — never the whole tree on mount or workspace switch.
  // Maps a path → the token (timestamp) of its current flash; the token also
  // keys the title node so a re-sync restarts the animation.
  const [flashSynced, setFlashSynced] = useState<Map<string, number>>(new Map());
  const syncSeenRef = useRef<Map<string, number>>(new Map());
  const syncSeededRef = useRef(false);
  const flashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clear any pending flash timers on unmount.
  useEffect(() => () => {
    for (const t of flashTimersRef.current.values()) clearTimeout(t);
    flashTimersRef.current.clear();
  }, []);

  useEffect(() => {
    const states = syncedFileStates;
    const seen = syncSeenRef.current;
    if (!states) return;
    // First observation just records the baseline — persisted states are old.
    if (!syncSeededRef.current) {
      for (const [p, s] of Object.entries(states)) seen.set(p, s.updatedAt);
      syncSeededRef.current = true;
      return;
    }
    const now = Date.now();
    const fresh: string[] = [];
    for (const [p, s] of Object.entries(states)) {
      const prev = seen.get(p);
      seen.set(p, s.updatedAt);
      // Only a freshly-advanced 'synced' timestamp counts (the recency guard
      // avoids animating a stale state that resurfaces via an unrelated render).
      if (s.status === 'synced' && (prev === undefined || s.updatedAt > prev) && now - s.updatedAt < 10_000) {
        fresh.push(p);
      }
    }
    if (fresh.length === 0) return;

    // Flash the synced file AND its ancestor folders up to the root, so the
    // containing folder visibly reacts too. Ancestors de-dupe across a batch.
    const token = now;
    const toFlash = new Set<string>();
    for (const p of fresh) {
      toFlash.add(p);
      let dir = dirname(p);
      while (dir && dir.length >= rootPath.length) {
        toFlash.add(dir);
        if (dir === rootPath) break;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    setFlashSynced((prev) => {
      const next = new Map(prev);
      for (const p of toFlash) next.set(p, token);
      return next;
    });
    for (const p of toFlash) {
      const existing = flashTimersRef.current.get(p);
      if (existing) clearTimeout(existing);
      flashTimersRef.current.set(p, setTimeout(() => {
        flashTimersRef.current.delete(p);
        setFlashSynced((prev) => {
          if (prev.get(p) !== token) return prev; // re-flashed since — leave it
          const next = new Map(prev);
          next.delete(p);
          return next;
        });
      }, SYNC_FLASH_MS));
    }
  }, [syncedFileStates, rootPath]);

  const renderItemTitle = useCallback(
    ({ title, item, context }: { title: string; item: TreeItem<FileTreeItem>; context: any }) => {
      const isRenaming = inlineInput?.renameFrom === String(item.index);
      const syncState = syncedFileStates?.[item.data.path];
      const isSyncedFile = !item.isFolder && syncState?.status === 'synced';
      const flashToken = flashSynced.get(item.data.path);

      return (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            flex: 1,
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setFocusedItem(item.index);
            // Keep an existing multi-selection if the right-clicked item is
            // part of it; otherwise fall back to selecting just this item.
            setSelectedItems((prev) =>
              prev.includes(item.index) ? prev : [item.index]
            );
            setContextMenu({ x: e.clientX, y: e.clientY, item });
          }}
        >
          <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <FileTypeIcon
              filename={item.data.name}
              isDirectory={!!item.isFolder}
              isExpanded={context.isExpanded}
              size={16}
            />
          </span>

          {isRenaming ? (
            <input
              ref={renameInputRef}
              style={inlineInputStyle}
              onKeyDown={onInputKeyDown}
              onBlur={(e) => {
                if (!inputHandledRef.current) commitInput(e.target.value);
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onFocus={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              // Re-key on the flash token so a fresh sync restarts the animation
              // even while a previous highlight is still fading.
              key={flashToken ? `flash-${flashToken}` : 'name'}
              className={flashToken ? 'ide-sync-flash' : undefined}
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: isSyncedFile ? 'rgba(142, 214, 168, 0.95)' : undefined,
              }}
            >
              {title}
            </span>
          )}
        </span>
      );
    },
    [inlineInput, onInputKeyDown, commitInput, syncedFileStates, flashSynced],
  );

  const rootTreeItem = items['root'];
  const isReady = !!rootTreeItem && Array.isArray(rootTreeItem.children);

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', overflow: 'auto', userSelect: 'none' }}
      className="ide-file-explorer"
      onDragStart={(e) => {
        // react-complex-tree owns the drag for internal reordering; we piggyback
        // on the same dragstart (it doesn't set dataTransfer data) to carry the
        // file path(s) so the drag can also be dropped into a terminal.
        const el = (e.target as HTMLElement).closest('[data-rct-item-id]');
        const id = el?.getAttribute('data-rct-item-id');
        if (!id || id === 'root') return;
        const selected = selectedItems.map(String);
        const paths = selected.includes(id) && selected.length > 1
          ? selected.filter((p) => p !== 'root')
          : [id];
        const payload = paths.map(shellQuote).join(' ');
        try {
          e.dataTransfer.setData('text/plain', payload);
          e.dataTransfer.setData(SPLITGRID_PATH_MIME, payload);
          e.dataTransfer.effectAllowed = 'copyMove';
        } catch {
          // Some platforms restrict dataTransfer during certain drags.
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const targetItem = resolveContextTargetItem();
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          item: targetItem,
        });
      }}
    >
      {/* Header — also a drag handle for the container */}
      <div
        className="container-drag-handle"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px 4px',
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: 'var(--text-muted)',
          cursor: 'grab',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onContainerClose && (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={onContainerClose}
              title="Close"
              style={{ width: 12, height: 12, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: 'transparent', background: 'var(--accent-red)', border: 'none', cursor: 'pointer', lineHeight: 1, opacity: 0.7, flexShrink: 0 }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--bg-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.color = 'transparent'; }}
            >
              x
            </button>
          )}
          <span>Explorer</span>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          <HeaderBtn title="New File" onClick={() => setInlineInput({ parentDir: rootPath, kind: 'file' })}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 1h7l3 3v11H3V1z" stroke="currentColor" strokeWidth="1.2" fill="none"/><line x1="6" y1="9" x2="10" y2="9" stroke="currentColor" strokeWidth="1.2"/><line x1="8" y1="7" x2="8" y2="11" stroke="currentColor" strokeWidth="1.2"/></svg>
          </HeaderBtn>
          <HeaderBtn title="New Folder" onClick={() => setInlineInput({ parentDir: rootPath, kind: 'folder' })}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 3h5l1.5 1.5H14v9H1V3z" stroke="currentColor" strokeWidth="1.2" fill="none"/><line x1="5" y1="9" x2="10" y2="9" stroke="currentColor" strokeWidth="1.2"/><line x1="7.5" y1="7" x2="7.5" y2="11" stroke="currentColor" strokeWidth="1.2"/></svg>
          </HeaderBtn>
          <HeaderBtn title="Refresh" onClick={refreshAll}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13 3a6 6 0 10.5 5" stroke="currentColor" strokeWidth="1.3" fill="none"/><path d="M13 0v4h-4" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
          </HeaderBtn>
        </div>
      </div>

      {/* Inline input for NEW file/folder */}
      {inlineInput && !inlineInput.renameFrom && (
        <div style={{ padding: '2px 12px' }}>
          <input
            ref={newInputRef}
            placeholder={inlineInput.kind === 'folder' ? 'Folder name...' : 'File name...'}
            style={inlineInputStyle}
            onKeyDown={onInputKeyDown}
            onBlur={(e) => {
              if (!inputHandledRef.current) commitInput(e.target.value);
            }}
          />
        </div>
      )}

      {isReady ? (
        <ControlledTreeEnvironment<FileTreeItem>
          items={items}
          getItemTitle={getItemTitle}
          viewState={viewState}
          defaultInteractionMode={InteractionMode.ClickItemToExpand}
          canDragAndDrop
          canReorderItems
          canDropOnFolder
          canSearch={false}
          canRename={false}
          onFocusItem={handleFocusItem}
          onExpandItem={handleExpandItem}
          onCollapseItem={handleCollapseItem}
          onSelectItems={handleSelectItems}
          onPrimaryAction={handlePrimaryAction}
          onDrop={handleDrop}
          onMissingItems={handleMissingItems}
          renderItemTitle={renderItemTitle}
        >
          <Tree treeId="ide-tree" rootItem="root" treeLabel="File Explorer" />
        </ControlledTreeEnvironment>
      ) : (
        <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          Loading...
        </div>
      )}

      {contextMenu && (
        <IDEContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenu(contextMenu.item)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
});

const HeaderBtn: React.FC<{
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ title, onClick, children }) => (
  <button
    onMouseDown={(e) => e.stopPropagation()}
    onClick={onClick}
    title={title}
    style={{
      background: 'transparent',
      border: 'none',
      color: 'var(--text-muted)',
      cursor: 'pointer',
      padding: '2px 4px',
      borderRadius: 4,
      display: 'flex',
      alignItems: 'center',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.color = 'var(--text-primary)';
      e.currentTarget.style.background = 'var(--bg-hover)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.color = 'var(--text-muted)';
      e.currentTarget.style.background = 'transparent';
    }}
  >
    {children}
  </button>
);

const inlineInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0 2px',
  fontSize: 'inherit',
  lineHeight: 'inherit',
  height: '100%',
  background: 'var(--bg-input, var(--bg-primary))',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 2,
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};
