/**
 * App background colour.
 *
 * The user picks ONE base colour; every other surface (panels, inputs, hovers,
 * borders, list rows, the terminal background) is derived from it by lifting
 * lightness in fixed steps while keeping the base hue and saturation. That is
 * what keeps a custom colour consistent instead of leaving a tinted window with
 * neutral-grey panels sitting on top of it.
 *
 * Dark-only by design: the UI's text colours and its white-alpha overlays assume
 * a dark base, so any picked colour is clamped into a dark, non-garish range
 * (see MIN_LIGHTNESS / MAX_LIGHTNESS / MAX_SATURATION) rather than rejected.
 *
 * With the default base (#141414) the derived ramp reproduces the palette that
 * is hard-coded in global.css, so "no colour chosen" changes nothing.
 */

export const DEFAULT_BACKGROUND_COLOR = '#141414';

// Dark range the picked colour is clamped into. A base above MAX_LIGHTNESS stops
// reading as "dark chrome" (light text and the white overlays lose contrast);
// above MAX_SATURATION it reads as a neon wash rather than a tint.
const MIN_LIGHTNESS = 0.02;
const MAX_LIGHTNESS = 0.24;
const MAX_SATURATION = 0.5;

/**
 * Lightness added to the base for each derived surface. Values are the exact
 * deltas between #141414 and the corresponding colours in global.css, so the
 * default base round-trips to today's palette.
 */
const SURFACE_STEPS = {
  editor: 0.016,
  surface: 0.024,
  input: 0.04,
  hover: 0.071,
  listHover: 0.082,
  border: 0.142,
  listInactive: 0.153,
  /** ANSI black inside xterm.js terminals — a hair above the background. */
  terminalBlack: 0.062,
} as const;

export interface BackgroundPreset {
  id: string;
  label: string;
  color: string;
}

/** Curated bases: neutral first, then subtle hue tints. */
export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  { id: 'graphite', label: 'Graphite', color: DEFAULT_BACKGROUND_COLOR },
  { id: 'ink', label: 'Ink', color: '#0b0b0b' },
  { id: 'slate', label: 'Slate', color: '#15181d' },
  { id: 'midnight', label: 'Midnight', color: '#101720' },
  { id: 'forest', label: 'Forest', color: '#0f1a16' },
  { id: 'plum', label: 'Plum', color: '#16121f' },
  { id: 'cocoa', label: 'Cocoa', color: '#191411' },
];

export interface DerivedBackgroundTheme {
  /** The normalized (parsed + clamped) base colour. */
  background: string;
  /** CSS custom properties to set on the document root. */
  vars: Record<string, string>;
  /**
   * The same ramp by name, for surfaces that can't read CSS variables — the
   * terminal renderers paint on a canvas and need concrete colours.
   */
  surfaces: { editor: string; surface: string; input: string; hover: string; border: string; terminalBlack: string };
}

interface Hsl { h: number; s: number; l: number }

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** #rgb / #rrggbb, with or without the leading '#'. Returns null if unparseable. */
function parseHex(input: string): { r: number; g: number; b: number } | null {
  const hex = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return '#' + rgb
    .map((v) => Math.round(clamp((v + m) * 255, 0, 255)).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Parse a user-entered colour and clamp it into the supported dark range.
 * Returns null when the input isn't a colour at all, so callers can tell
 * "invalid" from "valid but adjusted".
 */
export function parseBackgroundColor(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const rgb = parseHex(input);
  if (!rgb) return null;
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return hslToHex({
    h: hsl.h,
    s: clamp(hsl.s, 0, MAX_SATURATION),
    l: clamp(hsl.l, MIN_LIGHTNESS, MAX_LIGHTNESS),
  });
}

/** Same as parseBackgroundColor but falls back to the default base. */
export function normalizeBackgroundColor(input: string | null | undefined): string {
  return parseBackgroundColor(input) ?? DEFAULT_BACKGROUND_COLOR;
}

/** Build the full surface ramp from one base colour. */
export function deriveBackgroundTheme(input: string | null | undefined): DerivedBackgroundTheme {
  const background = normalizeBackgroundColor(input);
  const rgb = parseHex(background)!;
  const base = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const lift = (delta: number): string => hslToHex({ h: base.h, s: base.s, l: clamp(base.l + delta, 0, 1) });

  const surfaces = {
    editor: lift(SURFACE_STEPS.editor),
    surface: lift(SURFACE_STEPS.surface),
    input: lift(SURFACE_STEPS.input),
    hover: lift(SURFACE_STEPS.hover),
    border: lift(SURFACE_STEPS.border),
    terminalBlack: lift(SURFACE_STEPS.terminalBlack),
  };

  return {
    background,
    vars: {
      '--bg-primary': background,
      '--bg-sidebar': background,
      '--bg-titlebar': background,
      '--bg-editor': surfaces.editor,
      '--bg-surface': surfaces.surface,
      '--bg-input': surfaces.input,
      '--bg-hover': surfaces.hover,
      '--bg-line-highlight': surfaces.hover,
      '--list-hover': lift(SURFACE_STEPS.listHover),
      '--border': surfaces.border,
      '--list-inactive': lift(SURFACE_STEPS.listInactive),
    },
    // --bg-active / --list-active stay accent-derived (they are a selection
    // tint, not a surface), so they follow the accent rather than the base.
    surfaces,
  };
}
