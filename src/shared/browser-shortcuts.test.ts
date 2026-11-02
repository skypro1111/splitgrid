import { describe, it, expect } from 'vitest';
import {
  matchBrowserShortcut,
  isGuestReservedShortcut,
  isBrowserShortcutAction,
  type BrowserKeyInput,
} from './browser-shortcuts';

const mac = { platform: 'darwin' };
const win = { platform: 'win32' };
const linux = { platform: 'linux' };

const k = (key: string, mods: Partial<BrowserKeyInput> = {}): BrowserKeyInput => ({ key, ...mods });

describe('matchBrowserShortcut — reload', () => {
  it('⌘R / Ctrl+R reload, with Shift hard-reload', () => {
    expect(matchBrowserShortcut(k('r', { meta: true }), mac)).toBe('reload');
    expect(matchBrowserShortcut(k('R', { meta: true, shift: true }), mac)).toBe('hard-reload');
    expect(matchBrowserShortcut(k('r', { control: true }), win)).toBe('reload');
    expect(matchBrowserShortcut(k('R', { control: true, shift: true }), linux)).toBe('hard-reload');
  });

  it('uses the platform primary modifier only', () => {
    expect(matchBrowserShortcut(k('r', { control: true }), mac)).toBeNull();
    expect(matchBrowserShortcut(k('r', { meta: true }), win)).toBeNull();
    expect(matchBrowserShortcut(k('r', { meta: true, alt: true }), mac)).toBeNull();
  });

  it('F5 reloads; Shift+F5 / Ctrl+F5 hard-reload; ⌘F5 is left alone', () => {
    expect(matchBrowserShortcut(k('F5'), win)).toBe('reload');
    expect(matchBrowserShortcut(k('F5'), mac)).toBe('reload');
    expect(matchBrowserShortcut(k('F5', { shift: true }), win)).toBe('hard-reload');
    expect(matchBrowserShortcut(k('F5', { control: true }), win)).toBe('hard-reload');
    expect(matchBrowserShortcut(k('F5', { meta: true }), mac)).toBeNull();
  });

  it('matches by physical key under a non-latin layout', () => {
    expect(matchBrowserShortcut({ key: 'к', code: 'KeyR', meta: true }, mac)).toBe('reload');
    expect(matchBrowserShortcut({ key: 'К', code: 'KeyR', control: true, shift: true }, win)).toBe('hard-reload');
  });

  it('ignores key-up events', () => {
    expect(matchBrowserShortcut(k('r', { meta: true, type: 'keyUp' }), mac)).toBeNull();
    expect(matchBrowserShortcut(k('r', { meta: true, type: 'keyDown' }), mac)).toBe('reload');
  });
});

describe('matchBrowserShortcut — DevTools', () => {
  it('F12 on every platform', () => {
    expect(matchBrowserShortcut(k('F12'), mac)).toBe('devtools');
    expect(matchBrowserShortcut(k('F12'), win)).toBe('devtools');
    expect(matchBrowserShortcut(k('F12', { shift: true }), win)).toBeNull();
  });

  it('⌘⌥I / ⌘⌥J on macOS (⌥ turns the key into a dead char, so code decides)', () => {
    expect(matchBrowserShortcut({ key: 'ˆ', code: 'KeyI', meta: true, alt: true }, mac)).toBe('devtools');
    expect(matchBrowserShortcut({ key: '∆', code: 'KeyJ', meta: true, alt: true }, mac)).toBe('devtools');
    expect(matchBrowserShortcut(k('I', { control: true, shift: true }), mac)).toBeNull();
  });

  it('Ctrl+Shift+I / Ctrl+Shift+J on Windows/Linux', () => {
    expect(matchBrowserShortcut(k('I', { control: true, shift: true }), win)).toBe('devtools');
    expect(matchBrowserShortcut(k('J', { control: true, shift: true }), linux)).toBe('devtools');
    expect(matchBrowserShortcut(k('i', { meta: true, alt: true }), win)).toBeNull();
  });
});

describe('matchBrowserShortcut — address bar', () => {
  it('⌘L / Ctrl+L', () => {
    expect(matchBrowserShortcut(k('l', { meta: true }), mac)).toBe('focus-address');
    expect(matchBrowserShortcut(k('l', { control: true }), win)).toBe('focus-address');
    expect(matchBrowserShortcut(k('l', { meta: true, shift: true }), mac)).toBeNull();
  });

  it('Alt+D on Windows/Linux only', () => {
    expect(matchBrowserShortcut(k('d', { alt: true }), win)).toBe('focus-address');
    expect(matchBrowserShortcut(k('d', { alt: true }), linux)).toBe('focus-address');
    expect(matchBrowserShortcut(k('∂', { code: 'KeyD', alt: true }), mac)).toBeNull();
  });
});

describe('matchBrowserShortcut — history', () => {
  it('⌘[ / ⌘] on macOS, also under a Cyrillic layout', () => {
    expect(matchBrowserShortcut(k('[', { meta: true }), mac)).toBe('back');
    expect(matchBrowserShortcut(k(']', { meta: true }), mac)).toBe('forward');
    expect(matchBrowserShortcut({ key: 'х', code: 'BracketLeft', meta: true }, mac)).toBe('back');
    expect(matchBrowserShortcut({ key: 'ї', code: 'BracketRight', meta: true }, mac)).toBe('forward');
  });

  it('a latin remap that puts another character on the bracket key does not navigate', () => {
    // Dvorak: physical BracketLeft types "/".
    expect(matchBrowserShortcut({ key: '/', code: 'BracketLeft', meta: true }, mac)).toBeNull();
  });

  it('⌘←/⌘→ navigate on macOS outside text fields only', () => {
    expect(matchBrowserShortcut(k('ArrowLeft', { meta: true }), mac)).toBe('back');
    expect(matchBrowserShortcut(k('ArrowRight', { meta: true }), mac)).toBe('forward');
    expect(matchBrowserShortcut(k('ArrowLeft', { meta: true }), { ...mac, editable: true })).toBeNull();
  });

  it('⌥← on macOS is word-jump, never Back', () => {
    expect(matchBrowserShortcut(k('ArrowLeft', { alt: true }), mac)).toBeNull();
  });

  it('Alt+←/→ on Windows/Linux', () => {
    expect(matchBrowserShortcut(k('ArrowLeft', { alt: true }), win)).toBe('back');
    expect(matchBrowserShortcut(k('ArrowRight', { alt: true }), linux)).toBe('forward');
    expect(matchBrowserShortcut(k('ArrowLeft', { alt: true, shift: true }), win)).toBeNull();
    expect(matchBrowserShortcut(k('ArrowLeft', { control: true }), win)).toBeNull();
  });

  it('hardware BrowserBack / BrowserForward keys', () => {
    expect(matchBrowserShortcut(k('BrowserBack'), win)).toBe('back');
    expect(matchBrowserShortcut(k('BrowserForward'), mac)).toBe('forward');
  });
});

describe('matchBrowserShortcut — leaves ordinary keys alone', () => {
  it('plain typing and unrelated chords', () => {
    expect(matchBrowserShortcut(k('r'), mac)).toBeNull();
    expect(matchBrowserShortcut(k('c', { meta: true }), mac)).toBeNull();
    expect(matchBrowserShortcut(k('c', { control: true }), win)).toBeNull();
    expect(matchBrowserShortcut(k('ArrowLeft'), win)).toBeNull();
    expect(matchBrowserShortcut(k('Meta', { meta: true }), mac)).toBeNull();
  });
});

describe('isGuestReservedShortcut / isBrowserShortcutAction', () => {
  it('back/forward are the page’s first, everything else is reserved', () => {
    expect(isGuestReservedShortcut('reload')).toBe(true);
    expect(isGuestReservedShortcut('hard-reload')).toBe(true);
    expect(isGuestReservedShortcut('devtools')).toBe(true);
    expect(isGuestReservedShortcut('focus-address')).toBe(true);
    expect(isGuestReservedShortcut('back')).toBe(false);
    expect(isGuestReservedShortcut('forward')).toBe(false);
  });

  it('validates untrusted action strings', () => {
    expect(isBrowserShortcutAction('reload')).toBe(true);
    expect(isBrowserShortcutAction('rm -rf')).toBe(false);
    expect(isBrowserShortcutAction(3)).toBe(false);
  });
});
