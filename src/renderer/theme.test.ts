// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyBackgroundTheme, getBackgroundTheme, onBackgroundThemeChange } from './theme';
import { DEFAULT_BACKGROUND_COLOR } from '../shared/background-theme';

describe('applyBackgroundTheme', () => {
  beforeEach(() => {
    applyBackgroundTheme(DEFAULT_BACKGROUND_COLOR);
    document.documentElement.removeAttribute('style');
  });

  it('writes the derived ramp onto the document root', () => {
    applyBackgroundTheme('#101720');
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--bg-primary')).toBe('#101720');
    expect(root.getPropertyValue('--bg-surface')).not.toBe('');
    expect(root.getPropertyValue('--border')).not.toBe('');
  });

  it('notifies subscribers with the derived theme, and stops after unsubscribe', () => {
    const seen: string[] = [];
    const off = onBackgroundThemeChange((t) => seen.push(t.background));
    applyBackgroundTheme('#0f1a16');
    off();
    applyBackgroundTheme('#16121f');
    expect(seen).toEqual(['#0f1a16']);
  });

  it('is a no-op when the colour does not change', () => {
    applyBackgroundTheme('#101720');
    let calls = 0;
    const off = onBackgroundThemeChange(() => { calls++; });
    applyBackgroundTheme('#101720');
    applyBackgroundTheme('101720'); // same colour, different spelling
    off();
    expect(calls).toBe(0);
  });

  it('falls back to the default base for unusable input', () => {
    applyBackgroundTheme('#101720');
    applyBackgroundTheme('not a colour');
    expect(getBackgroundTheme().background).toBe(DEFAULT_BACKGROUND_COLOR);
  });
});
