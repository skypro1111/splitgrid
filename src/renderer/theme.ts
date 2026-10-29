import {
  DEFAULT_BACKGROUND_COLOR,
  deriveBackgroundTheme,
  type DerivedBackgroundTheme,
} from '../shared/background-theme';

/**
 * Live app background theme: writes the derived surface ramp onto the document
 * root as CSS custom properties (overriding the defaults in global.css) and
 * notifies subscribers that paint outside CSS — the terminal renderers, which
 * hold their colours in a canvas/WebGL theme object.
 *
 * Module state rather than React context because terminals outlive their React
 * mounts (they sit in a module-level cache and are re-attached on remount).
 */

let current: DerivedBackgroundTheme = deriveBackgroundTheme(DEFAULT_BACKGROUND_COLOR);
const listeners = new Set<(theme: DerivedBackgroundTheme) => void>();

export function getBackgroundTheme(): DerivedBackgroundTheme {
  return current;
}

/** Apply a user-picked base colour (invalid/unset → the default base). */
export function applyBackgroundTheme(color: string | null | undefined): void {
  const next = deriveBackgroundTheme(color);
  if (next.background === current.background) return;
  current = next;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(next.vars)) root.style.setProperty(name, value);
  for (const listener of listeners) listener(next);
}

/** Subscribe to background changes. Returns an unsubscribe function. */
export function onBackgroundThemeChange(listener: (theme: DerivedBackgroundTheme) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
