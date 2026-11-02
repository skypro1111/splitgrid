import React, { useCallback, useSyncExternalStore } from 'react';
import type { ZonePlace } from '../../shared/agent-zones';

// --- Zone tray toggle ---
// A pane in an agent's zone can be collapsed into the zone's tray (the thin
// strip along its bottom) and brought back out (shared/agent-zones,
// moveZonePane). The grid owns the layout, but the terminal, browser and IDE
// panes are portalled to the App root, outside it, so — like focus mode — the
// grid publishes into a module store their headers read.

export interface ZoneTrayValue {
  /** Where each zone pane sits; panes outside every zone are absent. */
  places: ReadonlyMap<string, ZonePlace>;
  toggle: (containerId: string) => void;
}

const EMPTY: ZoneTrayValue = { places: new Map(), toggle: () => {} };
let current: ZoneTrayValue = EMPTY;
const listeners = new Set<() => void>();

/** Called by the grid whenever the layout (or its toggle) changes. */
export function publishZoneTray(value: ZoneTrayValue): void {
  current = value;
  for (const listener of listeners) listener();
}

function useZoneTray(): ZoneTrayValue {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return useSyncExternalStore(subscribe, () => current, () => current);
}

// A window with its bottom strip: an arrow into the strip collapses, out of it expands.
const TrayGlyph: React.FC<{ out: boolean }> = ({ out }) => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 13.5h11" />
    <path d={out ? 'M8 10.5v-8M5 5.5l3-3 3 3' : 'M8 2.5v8M5 7.5l3 3 3-3'} />
  </svg>
);

/**
 * Collapse into / expand out of the zone's tray. Renders nothing for a pane
 * outside every agent zone.
 */
export const PaneTrayButton: React.FC<{ containerId: string }> = ({ containerId }) => {
  const { places, toggle } = useZoneTray();
  const place = places.get(containerId);
  if (!place) return null;
  const inTray = place === 'tray';
  const title = inTray ? 'Expand out of the zone\'s tray' : 'Collapse into the zone\'s tray';

  return (
    <button
      // The header starts a container drag on mousedown; this must not.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        toggle(containerId);
      }}
      title={title}
      aria-label={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 16, height: 16, padding: 0, borderRadius: 4,
        background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0,
        color: 'var(--text-muted)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-hover)';
        e.currentTarget.style.color = 'var(--text-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'var(--text-muted)';
      }}
    >
      <TrayGlyph out={inTray} />
    </button>
  );
};
