import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_PRESETS,
  DEFAULT_BACKGROUND_COLOR,
  deriveBackgroundTheme,
  normalizeBackgroundColor,
  parseBackgroundColor,
} from './background-theme';

describe('parseBackgroundColor', () => {
  it('accepts #rrggbb, #rgb and bare hex', () => {
    expect(parseBackgroundColor('#141414')).toBe('#141414');
    expect(parseBackgroundColor('141414')).toBe('#141414');
    expect(parseBackgroundColor('#111')).toBe('#111111');
  });

  it('rejects non-colours', () => {
    for (const bad of ['', '  ', 'nope', '#12', '#1234567', 'rgb(1,2,3)', null, undefined]) {
      expect(parseBackgroundColor(bad as string)).toBeNull();
    }
  });

  it('clamps a too-light colour down into the dark range, keeping its hue', () => {
    const clamped = parseBackgroundColor('#e8f0ff');
    expect(clamped).not.toBeNull();
    const { l, h } = hsl(clamped!);
    expect(l).toBeLessThanOrEqual(0.245);
    // Blue-ish input stays blue-ish.
    expect(h).toBeGreaterThan(180);
    expect(h).toBeLessThan(260);
  });

  it('clamps a pure black up so surfaces stay distinguishable', () => {
    expect(hsl(parseBackgroundColor('#000000')!).l).toBeGreaterThanOrEqual(0.019);
  });

  it('tames neon saturation', () => {
    expect(hsl(parseBackgroundColor('#00ff00')!).s).toBeLessThanOrEqual(0.51);
  });
});

describe('normalizeBackgroundColor', () => {
  it('falls back to the default base for junk input', () => {
    expect(normalizeBackgroundColor('nope')).toBe(DEFAULT_BACKGROUND_COLOR);
    expect(normalizeBackgroundColor(undefined)).toBe(DEFAULT_BACKGROUND_COLOR);
  });

  it('is idempotent', () => {
    for (const preset of BACKGROUND_PRESETS) {
      const once = normalizeBackgroundColor(preset.color);
      expect(normalizeBackgroundColor(once)).toBe(once);
    }
  });
});

describe('deriveBackgroundTheme', () => {
  it('reproduces the hard-coded global.css palette for the default base', () => {
    const { vars, surfaces } = deriveBackgroundTheme(DEFAULT_BACKGROUND_COLOR);
    expect(vars['--bg-primary']).toBe('#141414');
    expect(vars['--bg-sidebar']).toBe('#141414');
    expect(vars['--bg-titlebar']).toBe('#141414');
    expect(vars['--bg-editor']).toBe('#181818');
    expect(vars['--bg-surface']).toBe('#1a1a1a');
    expect(vars['--bg-input']).toBe('#1e1e1e');
    expect(vars['--bg-hover']).toBe('#262626');
    expect(vars['--bg-line-highlight']).toBe('#262626');
    expect(vars['--border']).toBe('#383838');
    // ANSI blacks the two terminal renderers were built with (#242424 for
    // xterm.js, #1e1e1e — the input surface — for Ghostty).
    expect(surfaces.terminalBlack).toBe('#242424');
    expect(surfaces.input).toBe('#1e1e1e');
  });

  it('keeps the surfaces ordered from the base upwards for every preset', () => {
    for (const preset of BACKGROUND_PRESETS) {
      const { vars, background, surfaces } = deriveBackgroundTheme(preset.color);
      const order = [
        vars['--bg-primary'],
        vars['--bg-editor'],
        vars['--bg-surface'],
        vars['--bg-input'],
        vars['--bg-hover'],
        vars['--list-hover'],
        vars['--border'],
        vars['--list-inactive'],
      ].map((c) => hsl(c).l);
      for (let i = 1; i < order.length; i++) {
        expect(order[i]).toBeGreaterThan(order[i - 1] - 1e-6);
      }
      expect(hsl(surfaces.terminalBlack).l).toBeGreaterThan(hsl(background).l);
    }
  });

  it('carries the base hue into every derived surface', () => {
    const { vars } = deriveBackgroundTheme('#101720');
    const baseHue = hsl(vars['--bg-primary']).h;
    for (const key of ['--bg-surface', '--bg-hover', '--border', '--list-inactive']) {
      expect(Math.abs(hsl(vars[key]).h - baseHue)).toBeLessThan(2);
    }
  });

  it('normalizes junk input instead of emitting broken CSS values', () => {
    const { vars } = deriveBackgroundTheme('not a colour');
    for (const value of Object.values(vars)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(vars['--bg-primary']).toBe(DEFAULT_BACKGROUND_COLOR);
  });
});

// Local hex→HSL, kept independent of the implementation under test.
function hsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}
