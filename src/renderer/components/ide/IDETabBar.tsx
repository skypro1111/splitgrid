import React, { useState, useCallback, useRef } from 'react';
import type { IDETab } from './useTabs';
import { IDEContextMenu, type ContextMenuEntry } from './IDEContextMenu';
import { FileTypeIcon } from './IDEFileIcons';
import { SplitHorizontalIcon, SplitVerticalIcon } from '../Icons';

interface Props {
  tabs: IDETab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseAll: () => void;
  onCloseToRight: (tabId: string) => void;
  onPin: (tabId: string) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onContainerSplitRight?: () => void;
  onContainerSplitDown?: () => void;
}

export const IDETabBar: React.FC<Props> = ({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCloseToRight,
  onPin,
  onReorder,
  onContainerSplitRight,
  onContainerSplitDown,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const dragIdx = useRef<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIdx(idx);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIdx: number) => {
    e.preventDefault();
    if (dragIdx.current !== null && dragIdx.current !== toIdx) {
      onReorder(dragIdx.current, toIdx);
    }
    dragIdx.current = null;
    setDropIdx(null);
  }, [onReorder]);

  const handleDragEnd = useCallback(() => {
    dragIdx.current = null;
    setDropIdx(null);
  }, []);

  const contextMenuItems = (tabId: string): ContextMenuEntry[] => [
    { label: 'Close', shortcut: '⌘W', action: () => onClose(tabId) },
    { label: 'Close Others', action: () => onCloseOthers(tabId) },
    { label: 'Close All', action: () => onCloseAll() },
    { label: 'Close to the Right', action: () => onCloseToRight(tabId) },
    { separator: true },
    { label: 'Copy Path', action: () => navigator.clipboard.writeText(tabId) },
  ];

  const hasContainerControls = !!(onContainerSplitRight || onContainerSplitDown);

  return (
    <div
      className={hasContainerControls ? 'container-drag-handle' : undefined}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height: 30,
        minHeight: 30,
        background: 'var(--bg-titlebar)',
        position: 'relative' as const,
        userSelect: hasContainerControls ? 'none' : undefined,
        cursor: hasContainerControls ? 'grab' : undefined,
      }}
    >
      {/* Tabs area */}
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          flex: 1,
          overflowX: 'auto',
          overflowY: 'visible',
          scrollbarWidth: 'none',
          minWidth: 0,
        }}
      >
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={e => handleDragStart(e, idx)}
              onDragOver={e => handleDragOver(e, idx)}
              onDrop={e => handleDrop(e, idx)}
              onDragEnd={handleDragEnd}
              onClick={() => onActivate(tab.id)}
              onDoubleClick={() => onPin(tab.id)}
              onMouseDown={e => {
                e.stopPropagation();
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              onContextMenu={e => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 12px',
                minWidth: 0,
                maxWidth: 200,
                cursor: 'pointer',
                fontSize: 12,
                fontStyle: tab.isPreview ? 'italic' : 'normal',
                color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                background: isActive ? 'var(--bg-editor)' : 'transparent',
                borderRight: '1px solid var(--border)',
                borderBottom: 'none',
                borderLeft: dropIdx === idx ? '2px solid var(--text-muted)' : '2px solid transparent',
                whiteSpace: 'nowrap',
                userSelect: 'none',
                flexShrink: 0,
                transition: 'background 0.1s',
                position: 'relative' as const,
                zIndex: isActive ? 1 : 0,
                marginBottom: isActive ? -1 : 0,
                paddingBottom: isActive ? 1 : 0,
              }}
              onMouseEnter={e => {
                if (!isActive) (e.currentTarget).style.background = 'var(--bg-hover)';
              }}
              onMouseLeave={e => {
                if (!isActive) (e.currentTarget).style.background = 'transparent';
              }}
            >
              <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                <FileTypeIcon filename={tab.fileName} isDirectory={false} size={14} />
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                {tab.isDirty && (
                  <span style={{ color: 'var(--text-muted)', marginRight: 2 }}>&bull;</span>
                )}
                {tab.fileName}
              </span>
              <span
                onClick={e => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  fontSize: 14,
                  lineHeight: 1,
                  color: 'var(--text-muted)',
                  flexShrink: 0,
                  opacity: isActive ? 1 : 0,
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => {
                  (e.currentTarget).style.background = 'var(--bg-hover)';
                  (e.currentTarget).style.opacity = '1';
                }}
                onMouseLeave={e => {
                  (e.currentTarget).style.background = 'transparent';
                  (e.currentTarget).style.opacity = isActive ? '1' : '0';
                }}
              >
                ×
              </span>
            </div>
          );
        })}
      </div>

      {/* Container split buttons */}
      {hasContainerControls && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingRight: 6, paddingLeft: 4, flexShrink: 0 }}>
          {onContainerSplitRight && (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={onContainerSplitRight}
              title="Split right"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              <SplitHorizontalIcon size={14} />
            </button>
          )}
          {onContainerSplitDown && (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={onContainerSplitDown}
              title="Split down"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              <SplitVerticalIcon size={14} />
            </button>
          )}
        </div>
      )}

      {/* Bottom border — absolute so active tab (zIndex:1) can overlap it */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 1,
        background: 'var(--border)',
        zIndex: 0,
      }} />

      {contextMenu && (
        <IDEContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems(contextMenu.tabId)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
