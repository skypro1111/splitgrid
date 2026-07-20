// Tiny module-level flag set by the Settings hotkey recorder while it captures a
// new chord. Renderer-side keyboard shortcuts (e.g. the focus-mode toggle in
// WorkspaceGrid) check it and bail out so the keystroke reaches the recorder to
// be recorded, instead of firing the shortcut. The main process has its own
// equivalent (isCapturingQuickChatHotkey) for before-input-event matching.

let capturing = false;

export function isCapturingHotkey(): boolean {
  return capturing;
}

export function setCapturingHotkey(value: boolean): void {
  capturing = value;
}
