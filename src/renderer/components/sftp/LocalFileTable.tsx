import React, { useMemo } from 'react';
import type { RemoteDirEntry } from '../../../shared/types';
import { joinLocal, parentLocal, isLocalRoot, pathCrumbs, type LocalSep } from '../../../shared/local-path';
import { FileTable, type FileProvider } from './FileTable';

interface LocalFileTableProps {
  path: string; // current local dir (controlled by parent)
  onPathChange: (path: string) => void; // navigate (parent persists it)
  refreshNonce?: number; // bump to reload (e.g. after a download landed here)
  onSelectionChange?: (entries: RemoteDirEntry[]) => void;
  onExternalDrop?: (localPaths: string[]) => void; // OS files dropped → copy here
  zoomLevel?: number;
}

// Thin wrapper: the shared FileTable driven by the local filesystem.
// Path semantics follow the host platform ('\' on Windows, '/' elsewhere);
// Delete moves to the OS trash (trashItem), so it is recoverable.
export const LocalFileTable: React.FC<LocalFileTableProps> = ({
  path,
  onPathChange,
  refreshNonce,
  onSelectionChange,
  onExternalDrop,
  zoomLevel,
}) => {
  const provider = useMemo<FileProvider>(() => {
    const sep: LocalSep = window.electronAPI.platform === 'win32' ? '\\' : '/';
    return {
      kind: 'local',
      list: (p) => window.electronAPI.statDirectory(p),
      mkdir: (p) => window.electronAPI.createDirectory(p),
      rename: (oldPath, newPath) => window.electronAPI.moveFile(oldPath, newPath),
      delete: (p) => window.electronAPI.trashItem(p),
      join: (dir, name) => joinLocal(dir, name, sep),
      parent: (p) => parentLocal(p, sep),
      isRoot: (p) => isLocalRoot(p, sep),
      crumbs: (p) => pathCrumbs(p, sep),
    };
  }, []);

  return (
    <FileTable
      provider={provider}
      path={path}
      onPathChange={onPathChange}
      refreshNonce={refreshNonce}
      onSelectionChange={onSelectionChange}
      onExternalDrop={onExternalDrop}
      zoomLevel={zoomLevel}
    />
  );
};
