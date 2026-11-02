import { latinKey } from './keyboard';

// Chrome-style keyboard shortcuts for the embedded browser pane. Pure (no
// Electron/DOM imports) so the main process (guest before-input-event), the
// renderer (address bar / pane chrome) and the unit tests share one matcher.

export type BrowserShortcutAction =
  | 'reload'
  | 'hard-reload'
  | 'back'
  | 'forward'
  | 'focus-address'
  | 'devtools';

export const BROWSER_SHORTCUT_ACTIONS: readonly BrowserShortcutAction[] = [
  'reload',
  'hard-reload',
  'back',
  'forward',
  'focus-address',
  'devtools',
];

export function isBrowserShortcutAction(v: unknown): v is BrowserShortcutAction {
  return typeof v === 'string' && (BROWSER_SHORTCUT_ACTIONS as readonly string[]).includes(v);
}

/** The fields we read off Electron's before-input-event input, a DOM
 * KeyboardEvent, or the guest preload's forwarded key payload. */
export interface BrowserKeyInput {
  type?: string; // 'keyDown' | 'keyUp' (Electron) — DOM events omit this
  key: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface BrowserShortcutContext {
  /** process.platform of the host ('darwin' | 'win32' | 'linux' …). */
  platform: string;
  /** Focus is in an editable field — there ⌘←/⌘→ move the caret, not history. */
  editable?: boolean;
}

// '[' / ']' by character when the layout produces them, else by physical key —
// under uk/ru ⌘[ arrives as key="х", which must still mean Back.
function bracketKey(input: BrowserKeyInput): string {
  if (input.key === '[' || input.key === ']') return input.key;
  if (/^[\x20-\x7e]$/.test(input.key)) return '';
  if (input.code === 'BracketLeft') return '[';
  if (input.code === 'BracketRight') return ']';
  return '';
}

/** Map a keystroke to a browser action, or null. Exact modifier sets, so e.g.
 * ⌘⌥R or Ctrl+Alt+R stay free for the page. */
export function matchBrowserShortcut(
  input: BrowserKeyInput,
  ctx: BrowserShortcutContext,
): BrowserShortcutAction | null {
  if (input.type && input.type !== 'keyDown') return null;
  const mac = ctx.platform === 'darwin';
  const meta = !!input.meta;
  const ctrl = !!input.control;
  const alt = !!input.alt;
  const shift = !!input.shift;
  // The platform's primary modifier, alone (⌘ on macOS, Ctrl elsewhere).
  const primary = mac ? meta && !ctrl : ctrl && !meta;
  const key = latinKey(input);

  if (input.key === 'BrowserBack') return 'back';
  if (input.key === 'BrowserForward') return 'forward';

  // Reload: ⌘R / Ctrl+R, F5; hard reload with Shift (and Ctrl+F5, as in Chrome).
  // ⌘F5 / ⌥F5 are left alone (VoiceOver and friends on macOS).
  if (input.key === 'F5' && !meta && !alt) return shift || ctrl ? 'hard-reload' : 'reload';
  if (primary && !alt && key === 'r') return shift ? 'hard-reload' : 'reload';

  // DevTools: F12, ⌘⌥I / ⌘⌥J on macOS, Ctrl+Shift+I / Ctrl+Shift+J elsewhere.
  if (input.key === 'F12' && !meta && !ctrl && !alt && !shift) return 'devtools';
  if (mac && meta && alt && !ctrl && !shift && (key === 'i' || key === 'j')) return 'devtools';
  if (!mac && ctrl && shift && !alt && !meta && (key === 'i' || key === 'j')) return 'devtools';

  // Address bar: ⌘L / Ctrl+L, plus Alt+D on Windows/Linux.
  if (primary && !alt && !shift && key === 'l') return 'focus-address';
  if (!mac && alt && !ctrl && !meta && !shift && key === 'd') return 'focus-address';

  // History.
  if (mac) {
    if (meta && !ctrl && !alt && !shift) {
      const b = bracketKey(input);
      if (b === '[') return 'back';
      if (b === ']') return 'forward';
      if (!ctx.editable && input.key === 'ArrowLeft') return 'back';
      if (!ctx.editable && input.key === 'ArrowRight') return 'forward';
    }
  } else if (alt && !ctrl && !meta && !shift) {
    if (input.key === 'ArrowLeft') return 'back';
    if (input.key === 'ArrowRight') return 'forward';
  }
  return null;
}

/** Actions main takes from a guest page BEFORE the page sees the key (they must
 * work on error pages too, and a page shouldn't be able to swallow reload or
 * DevTools). Back/forward are not reserved: as in Chrome the page gets the first
 * say (an editor's ⌘[ outdent wins), so those come through the guest preload
 * only when the page didn't preventDefault. */
export function isGuestReservedShortcut(action: BrowserShortcutAction): boolean {
  return action !== 'back' && action !== 'forward';
}

/** IPC channel main → host renderer for reserved guest shortcuts. */
export const BROWSER_GUEST_SHORTCUT_CHANNEL = 'browser:guest-shortcut';
