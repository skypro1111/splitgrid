import React, { createContext, useCallback, useSyncExternalStore } from 'react';

// --- Focus mode ---
// Expands one container over the whole grid (visually overlaying the others)
// WITHOUT touching the layout tree or reparenting any DOM: the chosen LeafCell is
// simply lifted to `position: fixed` at the grid's rect, so terminals/IDE/browser
// /SQL keep running untouched and exiting just clears the id. Transient (resets
// when the grid remounts on workspace switch); never persisted.
//
// The context lives here rather than in WorkspaceGrid so a pane's own header can
// carry the toggle. It used to float over the container's bottom-right corner,
// where it sat on top of whatever the pane put there — the Claude Code pane's
// Send button, for one. A header button belongs to the pane's chrome and can
// never collide with its content.

export interface GridRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface FocusModeValue {
  focusModeId: string | null;
  gridRect: GridRect | null;
  toggle: (containerId: string) => void;
}

export const FocusModeContext = createContext<FocusModeValue>({
  focusModeId: null,
  gridRect: null,
  toggle: () => {},
});

// The terminal, browser and IDE panes are portalled to the App root — siblings
// of the grid, not descendants — so their headers sit OUTSIDE the provider. A
// module-level store reaches them all; the grid publishes into it.
const EMPTY: FocusModeValue = { focusModeId: null, gridRect: null, toggle: () => {} };
let currentFocus: FocusModeValue = EMPTY;
const listeners = new Set<() => void>();

/** Called by the grid whenever focus state or the grid rect changes. */
export function publishFocusMode(value: FocusModeValue): void {
  currentFocus = value;
  for (const listener of listeners) listener();
}

export function useFocusMode(): FocusModeValue {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return useSyncExternalStore(subscribe, () => currentFocus, () => currentFocus);
}

const ExpandGlyph: React.FC = () => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-5 5M2.5 13.5l5-5" />
  </svg>
);

const CompressGlyph: React.FC = () => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" />
  </svg>
);

/**
 * The focus toggle, sized and coloured like the other header icon buttons.
 * Drop it right after a pane's close button.
 */
export const PaneFocusButton: React.FC<{ containerId: string }> = ({ containerId }) => {
  const focus = useFocusMode();
  const isFocused = focus.focusModeId === containerId;

  return (
    <button
      // The header starts a container drag on mousedown; this must not.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        focus.toggle(containerId);
      }}
      title={isFocused ? 'Exit focus (⌘/Ctrl+Shift+F)' : 'Focus this container (⌘/Ctrl+Shift+F)'}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        padding: 0,
        borderRadius: 4,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        flexShrink: 0,
        color: isFocused ? 'var(--accent)' : 'var(--text-muted)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-hover)';
        e.currentTarget.style.color = 'var(--text-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = isFocused ? 'var(--accent)' : 'var(--text-muted)';
      }}
    >
      {isFocused ? <CompressGlyph /> : <ExpandGlyph />}
    </button>
  );
};
