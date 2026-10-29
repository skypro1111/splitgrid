// ─── Indicator state → appearance ────────────────────────────────────────────
// Pure: no chrome APIs, no DOM, no side effects. "What does this state look
// like" is a safety decision, so it lives in one place that can be read (and
// later unit-tested) without a browser. The plumbing is indicator.ts.

import type { ExtTab } from '../../src/shared/ext-protocol';

export type IndicatorMode = 'readonly' | 'interactive';

export interface IndicatorLook {
  /** Frame + label + badge colour. Never the only cue — see `dashed`/`filledDot`. */
  accent: string;
  /** Foreground on top of `accent`. */
  ink: string;
  borderPx: number;
  /** Second, hue-independent cue: read-only is dashed, interactive is solid. */
  dashed: boolean;
  /** Third cue: a hollow ring vs a filled dot in the corner label. */
  filledDot: boolean;
  label: string;
  badgeText: string;
  badgeColor: string;
  /** Toolbar tooltip — the badge is 3-4 glyphs, this is the sentence. */
  title: string;
}

/** Matches `default_title` in the manifest; restored when control ends. */
export const DEFAULT_ACTION_TITLE = 'SplitGrid Browser Control';

const LOOKS: Record<IndicatorMode, IndicatorLook> = {
  // Blue + dashed + hollow ring: present, calm, "someone is looking".
  readonly: {
    accent: '#2f6fed',
    ink: '#ffffff',
    borderPx: 3,
    dashed: true,
    filledDot: false,
    label: 'SplitGrid · agent watching · READ-ONLY',
    badgeText: 'READ',
    badgeColor: '#2f6fed',
    title: 'SplitGrid: an agent can read this tab (read-only)',
  },
  // Orange + solid + thicker + filled dot: this tab can be acted on.
  interactive: {
    accent: '#e8590c',
    ink: '#ffffff',
    borderPx: 5,
    dashed: false,
    filledDot: true,
    label: 'SplitGrid · agent watching · CAN ACT',
    badgeText: 'ACT',
    badgeColor: '#e8590c',
    title: 'SplitGrid: an agent can interact with this tab — navigate, reload, run JS',
  },
};

export function lookFor(mode: IndicatorMode): IndicatorLook {
  return LOOKS[mode];
}

/**
 * The frame must claim only what is true right now.
 *
 * `connected` is the floor: with no desktop socket nobody can send a command,
 * and a tab nobody can drive must not wear a badge saying it is under control.
 *
 * `writable` is the ceiling this side can see. The desktop's own write gate
 * (`agentChromeWrite`) is not on the wire, so "interactive" means *our* gate is
 * open — which over-warns when the desktop's gate is shut and never under-warns.
 * That is the correct direction for a safety signal.
 */
export function desiredIndicators(tabs: ExtTab[], connected: boolean): Map<number, IndicatorMode> {
  const wanted = new Map<number, IndicatorMode>();
  if (!connected) return wanted;
  for (const tab of tabs) wanted.set(tab.tabId, tab.writable ? 'interactive' : 'readonly');
  return wanted;
}
