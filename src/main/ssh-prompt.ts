// ─── Password/sudo prompt detection (pure) ───────────────────────────────────
// Extracted from ssh-manager so it can be unit-tested without Electron/ssh2/PTY.
// The only job here is: "does this terminal output END in a password prompt?"
// It must be CONSERVATIVE — we only ever OFFER the saved password (never
// auto-send), but a false positive that fired mid-command would still be noise.

// Strip CSI/OSC escape sequences so colour codes can't defeat the match.
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

// A line ENDING in "password:" — optionally prefixed with "[sudo] ", a
// "<user>@<host>'s " owner, or " for <user>" / localized " для <user>". Anchored
// to end-of-buffer with only spaces/tabs after the colon (a real prompt leaves
// the cursor on the line — no trailing newline). The tight middle (only the
// known "for/для <user>" shapes) is what keeps "The password is wrong:" out.
export const PROMPT_RE =
  /(?:\[sudo\]\s*)?(?:password|passwd|пароль)(?:\s+(?:for|для)\s+[^:\n]*)?[ \t]*:[ \t]*$/i;

// How much of the buffer tail to inspect (a prompt line is short).
const TAIL = 160;

/** True when the output buffer currently ends in a password/sudo prompt. */
export function endsWithPasswordPrompt(buffer: string): boolean {
  return PROMPT_RE.test(stripAnsi(buffer).slice(-TAIL));
}
