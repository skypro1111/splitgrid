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

// Paste the clipboard into a terminal session.
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
      const text = await window.electronAPI.clipboardReadText();
      if (text) {
        terminal.paste(text);
        return;
      }

      const hasImage = await window.electronAPI.clipboardHasImage().catch(() => false);
      if (!hasImage) return;

      const isMac = window.electronAPI?.platform === 'darwin';
      const isWsl = !!session.shell?.startsWith('wsl:');

      // Remote sessions can't use a local temp file; macOS reads the native
      // pasteboard on Ctrl-V. Both fall back to forwarding the keystroke.
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
