// Layout-independent key identity for shortcut matching.
//
// `KeyboardEvent.key` (and Electron's `input.key`) carries the CHARACTER the
// active layout produces, not the physical key. Under a Cyrillic layout
// Ctrl+Shift+C arrives as key="С" (U+0421), so a `key === 'c'` check silently
// never fires — the shortcut does nothing at all, with no error and no beep.
// `code` carries the physical position ("KeyC"), which no layout changes.
//
// We still prefer `key` when it already is a latin letter/digit, so remapped
// latin layouts (Dvorak, Colemak) keep matching the character printed on the
// keycap, and fall back to the physical position for everything else.

export interface KeyLike {
  key: string;
  /** DOM KeyboardEvent.code / Electron Input.code — absent in synthetic events. */
  code?: string;
}

export function latinKey(input: KeyLike): string {
  const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  if (/^[a-z0-9]$/.test(key)) return key;

  const code = typeof input.code === 'string' ? input.code : '';
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];

  return key;
}

/** True when the keystroke is the given latin letter/digit, whatever the layout. */
export function isLatinKey(input: KeyLike, expected: string): boolean {
  return latinKey(input) === expected;
}
