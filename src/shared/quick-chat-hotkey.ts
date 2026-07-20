import type { QuickChatHotkey } from './types';

// Shared, pure hotkey logic used by both the main process (matching keystrokes in
// before-input-event) and the renderer (capturing + displaying the chord). Keep
// it free of Electron/DOM imports so both sides — and the unit tests — can use it.

/** Minimal shape of the fields we read off Electron's before-input-event input
 * (and equivalently a DOM KeyboardEvent). */
export interface HotkeyInput {
  type?: string; // 'keyDown' | 'keyUp' (Electron) — DOM events omit this
  key: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export function defaultQuickChatHotkey(platform: string): QuickChatHotkey {
  return platform === 'darwin' ? { key: 'k', meta: true } : { key: 'k', control: true };
}

/** Default chord for toggling a container's focus mode: ⌘⇧F on macOS,
 * Ctrl+Shift+F elsewhere. */
export function defaultFocusModeHotkey(platform: string): QuickChatHotkey {
  return platform === 'darwin'
    ? { key: 'f', meta: true, shift: true }
    : { key: 'f', control: true, shift: true };
}

/** Coerce arbitrary stored/captured input into a valid hotkey, or undefined if it
 * isn't usable (no key, or no modifier — a bare key would hijack typing). */
export function normalizeQuickChatHotkey(v: unknown): QuickChatHotkey | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const key = typeof o.key === 'string' ? o.key.toLowerCase() : '';
  if (!key) return undefined;
  const h: QuickChatHotkey = {
    key,
    meta: !!o.meta,
    control: !!o.control,
    alt: !!o.alt,
    shift: !!o.shift,
  };
  // Require at least one non-shift modifier (Shift+<key> alone is normal typing).
  if (!h.meta && !h.control && !h.alt) return undefined;
  return h;
}

/** Does a keystroke match the configured chord? Exact modifier equality so that
 * e.g. ⌘⇧K does not fire a ⌘K binding. */
export function hotkeyMatchesInput(hotkey: QuickChatHotkey, input: HotkeyInput): boolean {
  if (input.type && input.type !== 'keyDown') return false;
  return (
    input.key.toLowerCase() === hotkey.key &&
    !!input.meta === !!hotkey.meta &&
    !!input.control === !!hotkey.control &&
    !!input.alt === !!hotkey.alt &&
    !!input.shift === !!hotkey.shift
  );
}

const NAMED_KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: '⌫',
};

function keyLabel(key: string): string {
  const named = NAMED_KEY_LABELS[key];
  if (named) return named;
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Human-readable chord, e.g. "⌘K" on macOS or "Ctrl+Shift+P" elsewhere. */
export function formatQuickChatHotkey(hotkey: QuickChatHotkey, platform: string): string {
  const mac = platform === 'darwin';
  const parts: string[] = [];
  if (hotkey.control) parts.push(mac ? '⌃' : 'Ctrl');
  if (hotkey.alt) parts.push(mac ? '⌥' : 'Alt');
  if (hotkey.shift) parts.push(mac ? '⇧' : 'Shift');
  if (hotkey.meta) parts.push(mac ? '⌘' : 'Meta');
  parts.push(keyLabel(hotkey.key));
  // macOS convention concatenates symbols; other platforms join with "+".
  return mac ? parts.join('') : parts.join('+');
}
