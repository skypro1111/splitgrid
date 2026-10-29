// Unwrapping the CLI's internal message envelopes.
//
// Claude Code stores more in a "user message" than the user ever typed: slash
// commands are recorded as `<command-name>` blocks, injected context arrives in
// `<system-reminder>`, background work reports through `<task-notification>`,
// and local command output comes back in `<local-command-stdout>`. The terminal
// UI never shows any of that raw, so a resumed pane must not either.

export type TranscriptText =
  | { kind: 'text'; text: string }
  /** A slash command the user ran, e.g. `/context`. */
  | { kind: 'command'; text: string }
  /** Output of a locally-executed command. */
  | { kind: 'output'; text: string }
  /** Machinery with no place in the conversation. */
  | { kind: 'hidden' };

function tagContent(source: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(source);
  return match ? match[1].trim() : null;
}

/** Drop wrappers that carry no conversation, wherever they sit in the text. */
function stripInlineNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, '')
    .trim();
}

/**
 * Interpret one stored user-message body. Returns what the pane should show —
 * which for pure machinery is nothing at all.
 */
export function interpretStoredUserText(raw: string): TranscriptText {
  const source = (raw ?? '').trim();
  if (!source) return { kind: 'hidden' };

  // `/context` and friends are stored as a command envelope; the terminal shows
  // just the command line, so that is what a resumed pane shows too.
  const commandName = tagContent(source, 'command-name');
  if (commandName !== null) {
    const args = tagContent(source, 'command-args') ?? '';
    return { kind: 'command', text: `${commandName}${args ? ` ${args}` : ''}`.trim() };
  }

  const stdout =
    tagContent(source, 'local-command-stdout') ?? tagContent(source, 'command-stdout');
  if (stdout !== null) {
    return stdout ? { kind: 'output', text: stdout } : { kind: 'hidden' };
  }

  // Background-task reports: a status line is worth keeping, the id soup is not.
  if (source.startsWith('<task-notification>')) {
    const summary = tagContent(source, 'summary') ?? tagContent(source, 'status') ?? '';
    return summary ? { kind: 'output', text: summary } : { kind: 'hidden' };
  }

  const cleaned = stripInlineNoise(source);
  if (!cleaned) return { kind: 'hidden' };
  // A body that was nothing but envelopes leaves stray tags behind; treat a
  // remnant that still opens with a tag as machinery rather than show it raw.
  if (/^<[a-z][a-z0-9-]*>/.test(cleaned)) return { kind: 'hidden' };
  return { kind: 'text', text: cleaned };
}
