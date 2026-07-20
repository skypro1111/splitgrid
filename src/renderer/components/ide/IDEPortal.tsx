import React, { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { IDE } from './IDE';
import type {
  IDEContainerState,
  WorkspaceSyncConfig,
  WorkspaceSyncFileState,
} from '../../../shared/types';

interface Props {
  workspaceId: string;
  containerId: string;
  rootPath: string;
  zoomLevel: number;
  onClose: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
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

/**
 * Portal-based renderer that keeps IDE mounted across layout changes.
 *
 * Key insight: when the layout tree restructures (split/swap), the
 * data-ide-target placeholder DOM node gets destroyed and recreated.
 * If we used that node directly as the portal container, React would
 * unmount/remount IDE, losing all internal state.
 *
 * Instead, we create a STABLE wrapper div once (via ref) and manually
 * move it into whichever target node is current. The portal always
 * renders into this stable wrapper, so React never unmounts IDE.
 */
export const IDEPortal: React.FC<Props> = ({
  workspaceId,
  containerId,
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
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  if (!wrapperRef.current) {
    const el = document.createElement('div');
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.overflow = 'hidden';
    wrapperRef.current = el;
  }

  const attachToTarget = useCallback(() => {
    const target = document.querySelector<HTMLElement>(
      `[data-ide-target="${containerId}"]`,
    );
    const wrapper = wrapperRef.current;
    if (target && wrapper && wrapper.parentElement !== target) {
      target.appendChild(wrapper);
    }
  }, [containerId]);

  useLayoutEffect(attachToTarget, [attachToTarget]);

  useEffect(() => {
    const handleTargetMounted = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; containerId?: string }>).detail;
      if (detail?.kind === 'ide' && detail.containerId === containerId) {
        attachToTarget();
      }
    };

    window.addEventListener('splitgrid:portal-target-mounted', handleTargetMounted);
    return () => {
      window.removeEventListener('splitgrid:portal-target-mounted', handleTargetMounted);
      wrapperRef.current?.remove();
    };
  }, [attachToTarget, containerId]);

  return createPortal(
    <IDE
      workspaceId={workspaceId}
      rootPath={rootPath}
      zoomLevel={zoomLevel}
      onClose={onClose}
      onSplitRight={onSplitRight}
      onSplitDown={onSplitDown}
      workspaceSync={workspaceSync}
      onSyncEvent={onSyncEvent}
      syncedFileStates={syncedFileStates}
      initialState={initialState}
      onStateChange={onStateChange}
    />,
    wrapperRef.current,
  );
};
