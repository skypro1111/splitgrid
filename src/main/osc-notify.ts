// ─── Agent "notify" via OSC escape sequences ────────────────────────────────
// Agent-agnostic attention signal. Many CLIs emit a desktop-notification escape
// sequence when a turn finishes or they need input. Unlike the OTel path (which
// only knows Claude Code and Codex), this catches ANY tool — Aider, Gemini CLI,
// a test runner, `printf '\e]9;done\a'` — by scanning the raw PTY output, and it
// works cross-platform (it rides the data stream, not `ps`/`lsof`).
//
// Recognised (OSC = ESC ] … terminated by BEL \x07 or ST = ESC \\):
//   OSC 9 ; <text>                 iTerm2 / generic notification
//   OSC 99 ; <meta> ; <text>       kitty notification protocol
//   OSC 777 ; notify ; <t> ; <b>   urxvt / tmux notification
//
// OSC 9 is overloaded: ConEmu/Windows-Terminal use `9;<digit>;…` for progress
// and taskbar state — we exclude that form so progress bars don't ring.

// Match the START of a notify OSC; the payload itself is irrelevant — presence
// is the trigger. `99;` and `777;notify` are matched before the bare `9;` so
// the alternation doesn't short-circuit on the leading 9.
const NOTIFY_RE = /\x1b\](?:777;notify|99;|9;(?![0-9](?:;|\x07|\x1b\\)))/;

// PTY data arrives in arbitrary chunks, so a sequence can be cut mid-pattern.
// Keep a short tail per terminal, prepended to the next chunk, so a split prefix
// (e.g. "…ESC]9" then ";done\x07") is still recognised.
const CARRY = 64;
const tailByTerminal = new Map<string, string>();

/** Returns true if `data` (joined with the carried tail) contains a notify OSC. */
export function scanOscNotify(terminalId: string, data: string): boolean {
  const hay = (tailByTerminal.get(terminalId) ?? '') + data;
  const hit = NOTIFY_RE.test(hay);
  // On a hit, drop the tail so the matched bytes can't re-trigger next chunk.
  tailByTerminal.set(terminalId, hit ? '' : hay.slice(-CARRY));
  return hit;
}

export function clearOscNotify(terminalId: string): void {
  tailByTerminal.delete(terminalId);
}
