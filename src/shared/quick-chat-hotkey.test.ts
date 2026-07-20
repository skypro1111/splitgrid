import { describe, it, expect } from 'vitest';
import {
  defaultQuickChatHotkey,
  normalizeQuickChatHotkey,
  hotkeyMatchesInput,
  formatQuickChatHotkey,
} from './quick-chat-hotkey';

describe('defaultQuickChatHotkey', () => {
  it('is ⌘K on macOS and Ctrl+K elsewhere', () => {
    expect(defaultQuickChatHotkey('darwin')).toEqual({ key: 'k', meta: true });
    expect(defaultQuickChatHotkey('win32')).toEqual({ key: 'k', control: true });
    expect(defaultQuickChatHotkey('linux')).toEqual({ key: 'k', control: true });
  });
});

describe('normalizeQuickChatHotkey', () => {
  it('lowercases the key and coerces modifier flags', () => {
    expect(normalizeQuickChatHotkey({ key: 'P', meta: true })).toEqual({
      key: 'p', meta: true, control: false, alt: false, shift: false,
    });
  });
  it('rejects chords without a non-shift modifier (would hijack typing)', () => {
    expect(normalizeQuickChatHotkey({ key: 'k' })).toBeUndefined();
    expect(normalizeQuickChatHotkey({ key: 'k', shift: true })).toBeUndefined();
  });
  it('rejects malformed input', () => {
    expect(normalizeQuickChatHotkey(null)).toBeUndefined();
    expect(normalizeQuickChatHotkey({})).toBeUndefined();
    expect(normalizeQuickChatHotkey({ key: '' })).toBeUndefined();
  });
});

describe('hotkeyMatchesInput', () => {
  const hk = { key: 'k', meta: true };
  it('matches exact modifiers + key on keyDown', () => {
    expect(hotkeyMatchesInput(hk, { type: 'keyDown', key: 'k', meta: true })).toBe(true);
    // Electron uppercases nothing here, but be safe about case.
    expect(hotkeyMatchesInput(hk, { type: 'keyDown', key: 'K', meta: true })).toBe(true);
  });
  it('ignores keyUp', () => {
    expect(hotkeyMatchesInput(hk, { type: 'keyUp', key: 'k', meta: true })).toBe(false);
  });
  it('requires exact modifier equality (⌘⇧K does not fire ⌘K)', () => {
    expect(hotkeyMatchesInput(hk, { type: 'keyDown', key: 'k', meta: true, shift: true })).toBe(false);
    expect(hotkeyMatchesInput(hk, { type: 'keyDown', key: 'k', control: true })).toBe(false);
  });
  it('treats missing type as a match candidate (DOM events have no type field)', () => {
    expect(hotkeyMatchesInput(hk, { key: 'k', meta: true })).toBe(true);
  });
});

describe('formatQuickChatHotkey', () => {
  it('uses concatenated symbols on macOS', () => {
    expect(formatQuickChatHotkey({ key: 'k', meta: true }, 'darwin')).toBe('⌘K');
    expect(formatQuickChatHotkey({ key: 'p', meta: true, shift: true }, 'darwin')).toBe('⇧⌘P');
    expect(formatQuickChatHotkey({ key: ' ', control: true }, 'darwin')).toBe('⌃Space');
  });
  it('uses +-joined labels elsewhere', () => {
    expect(formatQuickChatHotkey({ key: 'k', control: true }, 'win32')).toBe('Ctrl+K');
    expect(formatQuickChatHotkey({ key: 'k', control: true, shift: true }, 'linux')).toBe('Ctrl+Shift+K');
  });
});
