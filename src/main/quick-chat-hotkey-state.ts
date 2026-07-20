import type { QuickChatHotkey } from '../shared/types';
import { defaultQuickChatHotkey, defaultFocusModeHotkey } from '../shared/quick-chat-hotkey';

// The Fast chat palette hotkey, cached in memory so before-input-event matching
// (a hot path) never touches disk. Seeded with the platform default and updated
// whenever the user saves settings (see ipc-handlers).
let current: QuickChatHotkey = defaultQuickChatHotkey(process.platform);

export function getQuickChatHotkey(): QuickChatHotkey {
  return current;
}

export function setQuickChatHotkey(hotkey: QuickChatHotkey | undefined): void {
  current = hotkey ?? defaultQuickChatHotkey(process.platform);
}

// The focus-mode toggle hotkey, cached the same way. Matched in the browser-pane
// before-input handler so the chord works from inside an embedded browser too.
let focusMode: QuickChatHotkey = defaultFocusModeHotkey(process.platform);

export function getFocusModeHotkey(): QuickChatHotkey {
  return focusMode;
}

export function setFocusModeHotkey(hotkey: QuickChatHotkey | undefined): void {
  focusMode = hotkey ?? defaultFocusModeHotkey(process.platform);
}

// While the Settings recorder is capturing a new chord, suspend matching so the
// keystroke reaches the renderer to be recorded (instead of being swallowed and
// toggling the palette).
let capturing = false;

export function isCapturingQuickChatHotkey(): boolean {
  return capturing;
}

export function setCapturingQuickChatHotkey(value: boolean): void {
  capturing = value;
}
