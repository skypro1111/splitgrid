import { shellQuote } from './terminalDrop';

// Structural terminal type — both xterm's and ghostty-web's Terminal satisfy it,
// and text paste is all this helper needs from the terminal.
interface PasteableTerminal {
  paste(data: string): void;
}

// Minimal session shape the paste logic needs: whether it's remote (SSH) and the
// shell string (`wsl:<distro>` marks a WSL target).
export interface PasteSessionMeta {
  type: 'ssh' | 'local';
  shell?: string;
}

// Copying an image in a browser leaves BOTH the bitmap and the image's URL on
// the clipboard. Text normally wins (see below), but for a bare single-line URL
// the user clearly meant the picture — otherwise "copy image → paste" silently
// inserts a link. Any other text (even one containing a URL) still wins.
function isBareUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim()) && !/\s/.test(text.trim());
}

// Paste the clipboard into a terminal session.
//
// FILES copied in Explorer/Finder go in as their paths — same convention as
// dragging a file onto the terminal; the CLIs read a path as an attachment.
//
// Text is pasted as-is. An IMAGE is the interesting case — the CLIs (Claude Code /
// Codex / Cursor) accept images two ways:
//   1. Native clipboard read triggered by Ctrl-V (0x16). This only works where the
//      CLI can reach the OS clipboard through the PTY — reliably that's the macOS
//      pasteboard. On Windows/Linux (and always under WSL/SSH) it does nothing,
//      which is why paste "worked on macOS only".
//   2. A file path typed in, exactly like dragging an image file onto the terminal.
//      This works on every platform because SplitGrid writes the clipboard image
//      to a temp PNG itself and hands the CLI a real file.
//
// So: macOS local → forward Ctrl-V (nicer inline preview, unchanged behavior).
// Windows/Linux local (incl. WSL) → save temp file + type its (shell-quoted) path.
// SSH → forward Ctrl-V as a last resort; a local temp path is meaningless remotely.
export function pasteClipboardIntoTerminal(
  terminal: PasteableTerminal,
  sendData: (data: string) => void,
  session: PasteSessionMeta,
): void {
  void (async () => {
    try {
      const isMac = window.electronAPI?.platform === 'darwin';
      const isWsl = !!session.shell?.startsWith('wsl:');

      // Copied files carry no text at all, so check them before readText().
      const files = await window.electronAPI
        .clipboardReadFilePaths?.(isWsl ? 'wsl' : null)
        .catch(() => [] as string[]);
      if (files && files.length > 0) {
        sendData(`${files.map(shellQuote).join(' ')} `);
        return;
      }

      const text = await window.electronAPI.clipboardReadText();
      // Only pay for a clipboard image read when the text can't be what the
      // user meant (empty, or the bare URL a browser attaches to an image).
      if (text && !isBareUrl(text)) {
        terminal.paste(text);
        return;
      }

      const hasImage = await window.electronAPI.clipboardHasImage().catch(() => false);
      if (!hasImage) {
        if (text) terminal.paste(text);
        return;
      }

      // Remote sessions can't use a local temp file; macOS reads the native
      // pasteboard on Ctrl-V. Both fall back to forwarding the keystroke —
      // except over SSH, where the remote CLI can't reach this clipboard at
      // all, so any text we do have beats a keystroke that goes nowhere.
      if (session.type === 'ssh' && text) {
        terminal.paste(text);
        return;
      }
      if (session.type === 'ssh' || (isMac && !isWsl)) {
        sendData('\u0016');
        return;
      }

      const filePath = await window.electronAPI
        .clipboardSaveImageTemp(isWsl ? 'wsl' : null)
        .catch(() => null);
      if (filePath) {
        // Mirror the drag-drop convention: shell-quoted path + trailing space.
        sendData(`${shellQuote(filePath)} `);
      } else {
        sendData('\u0016'); // couldn't materialize the image — try native paste
      }
    } catch {
      // Last-ditch: browser clipboard for plain text.
      navigator.clipboard
        ?.readText()
        .then((t) => {
          if (t) terminal.paste(t);
        })
        .catch(() => {});
    }
  })();
}
