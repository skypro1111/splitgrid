import { useState, useCallback, useRef, useEffect } from 'react';
import type { TreeItem, TreeItemIndex } from 'react-complex-tree';
import { sortEntries, joinPath, basename, dirname } from './utils';

export interface FileTreeItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

export type ItemsMap = Record<TreeItemIndex, TreeItem<FileTreeItem>>;

function makeRootItem(rootPath: string): TreeItem<FileTreeItem> {
  return {
    index: 'root',
    data: { name: basename(rootPath), path: rootPath, isDirectory: true },
    children: [],
    isFolder: true,
    canMove: false,
    canRename: false,
  };
}

export function useFileTree(rootPath: string) {
  const [items, setItems] = useState<ItemsMap>(() => ({
    root: makeRootItem(rootPath),
  }));

  const loadedDirs = useRef<Set<string>>(new Set());
  // In-flight loads keyed by dir path. Lets the concurrent triggers — the mount
  // load, the saved-state restore, and react-complex-tree's onMissingItems —
  // share a single fetch instead of racing, and lets a child's load await its
  // parent's load before merging.
  const inflight = useRef<Map<string, Promise<void>>>(new Map());

  // rootPath in a ref so loadDirectory can stay referentially stable (and be
  // safely self-recursive) without capturing a stale root.
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;

  const loadDirectory = useCallback((dirPath: string): Promise<void> => {
    if (loadedDirs.current.has(dirPath)) return Promise.resolve();
    const pending = inflight.current.get(dirPath);
    if (pending) return pending;

    const run = (async () => {
      try {
        const root = rootPathRef.current;
        // Materialise the parent chain FIRST so this dir's tree node exists
        // before we attach children. Without this, restoring a deep expanded
        // folder could merge before its ancestor loaded and silently drop the
        // contents — the folder would show expanded but empty until re-toggled.
        // React applies functional state updaters in call order, so awaiting the
        // parent's load guarantees its merge lands before ours.
        if (dirPath !== root) {
          const parent = dirname(dirPath);
          if (parent && parent !== dirPath && parent.length >= root.length) {
            await loadDirectory(parent);
          }
          // Parent failed to load → its tree node is absent and we can't attach
          // here. Leave this dir unmarked so a later expand/refresh retries.
          if (!loadedDirs.current.has(dirname(dirPath))) return;
        }

        const entries = await window.electronAPI.readDirectory(dirPath);
        const sorted = sortEntries(entries);
        const parentKey = dirPath === root ? 'root' : dirPath;
        const childIds: TreeItemIndex[] = [];
        setItems((prev) => {
          if (!prev[parentKey]) return prev; // defensive; parent awaited above
          const updated = { ...prev };
          for (const entry of sorted) {
            const childPath = joinPath(dirPath, entry.name);
            childIds.push(childPath);
            const existing = updated[childPath];
            updated[childPath] = {
              index: childPath,
              data: { name: entry.name, path: childPath, isDirectory: entry.isDirectory },
              // Preserve already loaded children when parent refreshes/reloads.
              children: entry.isDirectory ? (existing?.children ?? []) : undefined,
              isFolder: entry.isDirectory,
              canMove: true,
              canRename: true,
            };
          }
          updated[parentKey] = { ...updated[parentKey], children: childIds };
          return updated;
        });
        loadedDirs.current.add(dirPath);
      } catch (err) {
        console.error('Failed to load directory:', dirPath, err);
      } finally {
        inflight.current.delete(dirPath);
      }
    })();

    inflight.current.set(dirPath, run);
    return run;
  }, []);

  const refreshDirectory = useCallback(
    async (dirPath: string) => {
      loadedDirs.current.delete(dirPath);
      // Drop any in-flight load of this dir so its stale result can't land
      // after the fresh listing we're about to fetch.
      inflight.current.delete(dirPath);
      const parentKey = dirPath === rootPath ? 'root' : dirPath;

      // Load new entries FIRST, then atomically swap — avoids empty flash / stuck empty state
      try {
        const entries = await window.electronAPI.readDirectory(dirPath);
        const sorted = sortEntries(entries);
        const childIds: TreeItemIndex[] = [];
        loadedDirs.current.add(dirPath);
        setItems((prev) => {
          const updated = { ...prev };
          const nextItems: ItemsMap = {};
          for (const entry of sorted) {
            const childPath = joinPath(dirPath, entry.name);
            childIds.push(childPath);
            const existing = updated[childPath];
            nextItems[childPath] = {
              index: childPath,
              data: { name: entry.name, path: childPath, isDirectory: entry.isDirectory },
              // Preserve already loaded nested children for directories.
              children: entry.isDirectory ? (existing?.children ?? []) : undefined,
              isFolder: entry.isDirectory,
              canMove: true,
              canRename: true,
            };
          }
          // Remove stale children that no longer exist
          const oldParent = updated[parentKey];
          if (oldParent?.children) {
            for (const childId of oldParent.children) {
              if (!nextItems[childId as string]) {
                delete updated[childId as string];
              }
            }
          }
          // Merge new items and update parent children atomically
          Object.assign(updated, nextItems);
          if (updated[parentKey]) {
            updated[parentKey] = { ...updated[parentKey], children: childIds };
          }
          return updated;
        });
      } catch (err) {
        console.error('Failed to refresh directory:', dirPath, err);
      }
    },
    [rootPath],
  );

  const refreshAll = useCallback(async () => {
    loadedDirs.current.clear();
    inflight.current.clear();
    setItems({ root: makeRootItem(rootPath) });
    setTimeout(() => loadDirectory(rootPath), 0);
  }, [rootPath, loadDirectory]);

  useEffect(() => {
    loadDirectory(rootPath);
  }, [rootPath, loadDirectory]);

  // Auto-refresh directories when files change on disk (recursive watcher)
  useEffect(() => {
    const watchId = `tree:${rootPath}`;
    window.electronAPI.watchDirectory(watchId, rootPath);

    const unsub = window.electronAPI.onDirectoriesChanged((dirs) => {
      for (const dir of dirs) {
        // Only refresh directories we've already loaded (visible in tree)
        if (loadedDirs.current.has(dir)) {
          refreshDirectory(dir);
        }
      }
    });

    return () => {
      unsub();
      window.electronAPI.unwatchDirectory(watchId);
    };
  }, [rootPath, refreshDirectory]);

  return { items, loadDirectory, refreshDirectory, refreshAll };
}
