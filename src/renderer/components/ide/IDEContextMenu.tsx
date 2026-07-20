import React, { useEffect, useRef, useState } from 'react';
import { TEMP_DISABLE_INPUT_INTERCEPTS } from '../../../shared/runtime-flags';

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

interface Props {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

function isSeparator(e: ContextMenuEntry): e is ContextMenuSeparator {
  return 'separator' in e;
}

export const IDEContextMenu: React.FC<Props> = ({ x, y, items, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number }>({
    left: x,
    top: y,
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const scrollHandler = () => onClose();
    document.addEventListener('mousedown', handler, true);
    if (!TEMP_DISABLE_INPUT_INTERCEPTS) {
      document.addEventListener('keydown', keyHandler, true);
      document.addEventListener('scroll', scrollHandler, true);
    }
    return () => {
      document.removeEventListener('mousedown', handler, true);
      if (!TEMP_DISABLE_INPUT_INTERCEPTS) {
        document.removeEventListener('keydown', keyHandler, true);
        document.removeEventListener('scroll', scrollHandler, true);
      }
    };
  }, [onClose]);

  // Position within the IDE container bounds: flip up/down and clamp left/right
  // so the menu never overflows the container the explorer lives in. Falls back
  // to the viewport if no container ancestor is found.
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const container = ref.current.closest('[data-container-id]') as HTMLElement | null;
    const bounds = container
      ? container.getBoundingClientRect()
      : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };

    const margin = 4;
    const availTop = bounds.top + margin;
    const availBottom = bounds.bottom - margin;
    const availLeft = bounds.left + margin;
    const availRight = bounds.right - margin;
    const availHeight = availBottom - availTop;

    // Cap height to the container; menu scrolls if taller.
    const maxHeight = rect.height > availHeight ? availHeight : undefined;
    const height = Math.min(rect.height, availHeight);

    // Vertical: prefer below the cursor; flip above if it doesn't fit there but
    // does above; otherwise clamp within the container.
    let top: number;
    if (y + height <= availBottom) {
      top = y;
    } else if (y - height >= availTop) {
      top = y - height;
    } else {
      top = Math.max(availTop, availBottom - height);
    }

    // Horizontal: prefer right of the cursor; flip left, then clamp.
    let left: number;
    if (x + rect.width <= availRight) {
      left = x;
    } else if (x - rect.width >= availLeft) {
      left = x - rect.width;
    } else {
      left = Math.max(availLeft, availRight - rect.width);
    }

    setPos({ left, top, maxHeight });
  }, [x, y, items]);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 10000,
        minWidth: 200,
        maxHeight: pos.maxHeight,
        overflowY: pos.maxHeight ? 'auto' : undefined,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '4px 0',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        fontSize: 12,
        fontFamily: 'var(--font-sans)',
      }}
    >
      {items.map((item, i) => {
        if (isSeparator(item)) {
          return (
            <div
              key={`sep-${i}`}
              style={{
                height: 1,
                background: 'var(--border)',
                margin: '4px 8px',
              }}
            />
          );
        }
        return (
          <div
            key={`${item.label}-${i}`}
            onClick={() => {
              if (!item.disabled) {
                item.action();
                onClose();
              }
            }}
            style={{
              padding: '5px 12px 5px 8px',
              cursor: item.disabled ? 'default' : 'pointer',
              color: item.disabled
                ? 'var(--text-muted)'
                : item.danger
                  ? 'var(--accent-red)'
                  : 'var(--text-primary)',
              opacity: item.disabled ? 0.5 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
            onMouseEnter={e => {
              if (!item.disabled) {
                (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
              }
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
          >
            <span style={{ width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: item.icon ? 1 : 0 }}>
              {item.icon ?? null}
            </span>
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.shortcut && (
              <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 16 }}>
                {item.shortcut}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};
