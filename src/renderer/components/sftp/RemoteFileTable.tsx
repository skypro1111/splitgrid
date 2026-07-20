import React, { useMemo } from 'react';
import type { RemoteDirEntry, SftpTarget } from '../../../shared/types';
import { joinRemote, parentRemote } from '../../../shared/sftp-format';
import { pathCrumbs } from '../../../shared/local-path';
import { FileTable, type FileProvider } from './FileTable';

interface RemoteFileTableProps {
  target: SftpTarget;
  path: string; // current remote dir (controlled by parent)
  onPathChange: (path: string) => void; // navigate (parent persists it)
  refreshNonce?: number; // bump to reload (e.g. after an upload landed here)
  onSelectionChange?: (entries: RemoteDirEntry[]) => void;
  onExternalDrop?: (localPaths: string[]) => void; // OS files dropped → upload here
  onOpenFile?: (entry: RemoteDirEntry) => void; // open a remote file in the editor
  zoomLevel?: number;
}

// Thin wrapper: the shared FileTable driven by a remote (SFTP) provider.
// Remote paths are always POSIX, so crumbs reuse pathCrumbs with '/'.
export const RemoteFileTable: React.FC<RemoteFileTableProps> = ({
  target,
  path,
  onPathChange,
  refreshNonce,
  onSelectionChange,
  onExternalDrop,
  onOpenFile,
  zoomLevel,
}) => {
  const provider = useMemo<FileProvider>(
    () => ({
      kind: 'remote',
      list: (p) => window.electronAPI.sftpStatDir(target, p),
      mkdir: (p) => window.electronAPI.sftpMkdir(target, p),
      rename: (oldPath, newPath) => window.electronAPI.sftpRename(target, oldPath, newPath),
      delete: (p) => window.electronAPI.sftpDeletePath(target, p),
      join: joinRemote,
      parent: parentRemote,
      isRoot: (p) => p === '/',
      crumbs: (p) => pathCrumbs(p, '/'),
    }),
    [target],
  );

  return (
    <FileTable
      provider={provider}
      path={path}
      onPathChange={onPathChange}
      refreshNonce={refreshNonce}
      onSelectionChange={onSelectionChange}
      onExternalDrop={onExternalDrop}
      onOpenFile={onOpenFile}
      zoomLevel={zoomLevel}
    />
  );
};
