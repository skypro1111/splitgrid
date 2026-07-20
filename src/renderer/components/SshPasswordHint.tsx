import React from 'react';
import type { SshPasswordOffer } from '../hooks/useSshPasswordOffer';

// Pixel anchor for rendering the hint inline on the prompt row, trailing the
// terminal cursor. Coordinates are relative to the terminal root element (the
// hint's offset parent). `rowHeight` lets the chip match one terminal row so it
// sits on the same baseline as the "password:" prompt instead of floating at the
// bottom where it would overlap the last line of output.
export interface SshHintAnchor {
  top: number;
  left: number;
  rowHeight: number;
}

// Convert a terminal cursor cell to a root-relative pixel anchor. Renderer-
// agnostic: callers supply the cursor cell, the cell size (from the renderer's
// font metrics) and the host/root bounding rects.
export function computeSshHintAnchor(opts: {
  cursorX: number;
  cursorY: number;
  cellWidth: number;
  cellHeight: number;
  hostRect: DOMRect;
  rootRect: DOMRect;
}): SshHintAnchor | null {
  if (!opts.cellWidth || !opts.cellHeight) return null;
  return {
    top: opts.hostRect.top - opts.rootRect.top + opts.cursorY * opts.cellHeight,
    left: opts.hostRect.left - opts.rootRect.left + opts.cursorX * opts.cellWidth,
    rowHeight: opts.cellHeight,
  };
}

// The inline hint shown while a saved password is on offer (Tabby-style). When
// `anchor` is provided it renders as a compact chip trailing the cursor on the
// prompt row; otherwise it falls back to the bottom-left of the terminal. A
// faint "↵ Press Enter to paste saved password" — Enter is the primary
// affordance (intercepted in the terminal's key handler); clicking is a
// fallback.
export const SshPasswordHint: React.FC<{
  offer: SshPasswordOffer;
  onApply: () => void;
  anchor?: SshHintAnchor | null;
}> = ({ offer, onApply, anchor }) => (
  <div
    style={{
      position: 'absolute',
      ...(anchor
        ? {
            top: anchor.top,
            left: anchor.left + 8,
            height: anchor.rowHeight,
            // Keep the chip on its own row; clip rather than wrap if the prompt
            // sits far to the right.
            maxWidth: 'calc(100% - 24px)',
            background: 'rgba(20,20,20,0.82)',
            padding: '0 7px',
            borderRadius: 5,
            boxShadow: '0 0 0 1px rgba(255,255,255,0.06)',
          }
        : { left: 16, bottom: 12 }),
      zIndex: 20,
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      fontSize: 11,
      lineHeight: 1.6,
      fontFamily: 'inherit',
      userSelect: 'none',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
    }}
  >
    <span
      style={{
        background: 'rgba(255,255,255,0.13)',
        color: 'var(--text-secondary)',
        padding: '2px 7px',
        borderRadius: 5,
        letterSpacing: 0.2,
        maxWidth: 180,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {offer.label}
    </span>
    <button
      onClick={onApply}
      // Keep terminal focus — apply writes straight to the PTY in main.
      onMouseDown={(e) => e.preventDefault()}
      title="Inject the saved password and press Enter"
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        color: 'var(--text-muted)',
        cursor: 'pointer',
        fontSize: 11,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>↵ Enter</span>
      {' '}to paste saved {offer.source === 'sudo' ? 'sudo ' : ''}password
    </button>
  </div>
);
