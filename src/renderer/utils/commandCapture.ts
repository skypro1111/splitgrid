// Renderer-side heuristic capture of commands typed into terminals.
//
// Every keystroke from both terminal renderers (XtermTerminal + GridTerminal)
// funnels through `useTerminals.sendData`, so we buffer raw input bytes there,
// keyed by session id, and emit a completed command string on Enter.
//
// This is intentionally a heuristic (see the "Capture" decision): it captures
// plainly-typed commands well, but cannot reconstruct lines edited via history
// recall (↑/↓), reverse-search, or tab-completion — those involve escape
// sequences we can't replay against our buffer. Rather than record garbage we
// mark such a line "dirty" and skip it. Anything missed can still be added to
// favorites manually.
//
// SECURITY: at a no-echo prompt (sudo / ssh password / passphrase) the typed
// secret still flows through input. We watch terminal OUTPUT (noteTerminalOutput)
// for password-style prompts and "arm" the next line so the secret is never
// recorded — neither into the in-memory feed nor persisted to disk. We bias
// toward suppression: a false positive merely drops a command from "recent".

type Listener = (sessionId: string, command: string) => void;

interface LineState {
  buf: string;
  /** Set when an escape sequence or tab appears — the line can no longer be
   * trusted, so it is skipped (not recorded) when Enter arrives. */
  dirty: boolean;
  /** Tail of recent output on the current prompt line (ANSI-stripped, reset at
   * newlines) — used to detect password prompts. */
  outTail: string;
  /** Set when output looks like a secret prompt; the next submitted line is
   * dropped rather than recorded. */
  armedSecret: boolean;
}

const states = new Map<string, LineState>();
let listener: Listener | null = null;

// Guard against pasted blobs / runaway lines being stored as "commands".
const MAX_COMMAND_LEN = 800;

// Matches the trailing prompt of common secret entry: "Password:",
// "[sudo] password for user:", "user@host's password:", "Enter passphrase for
// key '…':", "PIN:", etc. Anchored to the end of the visible prompt line.
const SECRET_PROMPT_RE = /(password|passphrase|passcode|secret|pin)[^\n]{0,60}:\s*$/i;

function get(sessionId: string): LineState {
  let st = states.get(sessionId);
  if (!st) {
    st = { buf: '', dirty: false, outTail: '', armedSecret: false };
    states.set(sessionId, st);
  }
  return st;
}

/** Register the single consumer of captured commands (App sets this). */
export function setCommandListener(l: Listener | null): void {
  listener = l;
}

/** Forget a session's in-progress line (call on session close). */
export function dropCommandBuffer(sessionId: string): void {
  states.delete(sessionId);
}

/** Feed terminal OUTPUT so we can detect secret prompts and arm suppression. */
export function noteTerminalOutput(sessionId: string, data: string): void {
  const st = get(sessionId);
  // Strip CSI/OSC escapes and other control bytes, then keep only what's after
  // the last newline (the current prompt line), capped.
  /* eslint-disable no-control-regex */
  const cleaned = data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC … BEL/ST
    .replace(/\x1b[[0-9;?]*[ -/]*[@-~]/g, '') // CSI / other escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  /* eslint-enable no-control-regex */
  let tail = st.outTail + cleaned;
  const nl = tail.lastIndexOf('\n');
  if (nl >= 0) tail = tail.slice(nl + 1);
  st.outTail = tail.slice(-160);
  st.armedSecret = SECRET_PROMPT_RE.test(st.outTail);
}

/** Feed a raw input chunk for a session; emits to the listener on Enter. */
export function feedTerminalInput(sessionId: string, data: string): void {
  const st = get(sessionId);

  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\r' || ch === '\n') {
      const cmd = st.buf.trim();
      if (!st.dirty && !st.armedSecret && cmd && cmd.length <= MAX_COMMAND_LEN) {
        listener?.(sessionId, cmd);
      }
      st.buf = '';
      st.dirty = false;
      st.armedSecret = false;
    } else if (ch === '\x7f' || ch === '\b') {
      // Backspace / DEL — drop the last char.
      st.buf = st.buf.slice(0, -1);
    } else if (ch === '\x03' || ch === '\x15') {
      // Ctrl-C (cancel line) / Ctrl-U (kill line) — start fresh.
      st.buf = '';
      st.dirty = false;
    } else if (ch === '\x1b' || ch === '\t') {
      // Escape sequence (arrows / history / reverse-search) or tab-completion:
      // we can't faithfully reconstruct the resulting line.
      st.dirty = true;
    } else if (code >= 0x20) {
      st.buf += ch;
    }
    // Other control chars are ignored.
  }
}
