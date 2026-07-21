import { describe, it, expect } from 'vitest';
import { latinKey, isLatinKey } from './keyboard';

describe('latinKey', () => {
  it('uses the character when it is already latin', () => {
    expect(latinKey({ key: 'C', code: 'KeyC' })).toBe('c');
    expect(latinKey({ key: 'v', code: 'KeyV' })).toBe('v');
    expect(latinKey({ key: '7', code: 'Digit7' })).toBe('7');
  });

  it('falls back to the physical position under a Cyrillic layout', () => {
    // uk-UA / ru-RU: Ctrl+Shift+C produces "С" (U+0421), not "C".
    expect(latinKey({ key: 'С', code: 'KeyC' })).toBe('c');
    expect(latinKey({ key: 'М', code: 'KeyV' })).toBe('v');
    expect(latinKey({ key: 'ф', code: 'KeyA' })).toBe('a');
  });

  it('keeps the character for remapped latin layouts (Dvorak)', () => {
    // Dvorak: physical KeyJ types "c" — the user expects the keycap they read.
    expect(latinKey({ key: 'c', code: 'KeyJ' })).toBe('c');
  });

  it('passes named and punctuation keys through unchanged', () => {
    expect(latinKey({ key: 'Enter', code: 'Enter' })).toBe('enter');
    expect(latinKey({ key: '=', code: 'Equal' })).toBe('=');
  });

  it('tolerates a missing code', () => {
    expect(latinKey({ key: 'k' })).toBe('k');
    expect(latinKey({ key: 'К' })).toBe('к');
  });

  it('isLatinKey compares against the resolved key', () => {
    expect(isLatinKey({ key: 'С', code: 'KeyC' }, 'c')).toBe(true);
    expect(isLatinKey({ key: 'С', code: 'KeyC' }, 'v')).toBe(false);
  });
});
