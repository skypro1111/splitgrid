// Autocomplete triggers for the Claude Code composer.
//
// `@path` and `/command` are features of the CLI's own prompt pipeline — it
// expands a mention and runs a command when the text reaches it. What the
// terminal UI adds, and a plain textarea does not, is the picker. This module
// is that picker's brain: where a trigger starts, what has been typed so far,
// and what range an accepted suggestion replaces.
//
// Modelled on t3code's `detectComposerTrigger`: a slash command only counts at
// the start of a line (so "see /etc/hosts" is prose, not a command), while a
// mention is any whitespace-delimited token starting with `@`.

export type ComposerTriggerKind = 'slash-command' | 'path';

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  /** What the user has typed after the trigger character. */
  query: string;
  /** Text range the accepted suggestion replaces (trigger char included). */
  rangeStart: number;
  rangeEnd: number;
}

function clampCursor(text: string, cursor: number): number {
  return Math.max(0, Math.min(text.length, cursor));
}

/** Start of the whitespace-delimited token the cursor sits in. */
function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && !/\s/.test(text[index - 1])) index -= 1;
  return index;
}

/**
 * The trigger active at `cursor`, or null when the caret is in ordinary prose.
 */
export function detectComposerTrigger(text: string, cursor: number): ComposerTrigger | null {
  const caret = clampCursor(text, cursor);
  const lineStart = text.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const linePrefix = text.slice(lineStart, caret);

  // A command is only a command at the start of a line, and only until the
  // first space — after that the rest is arguments, not a name to complete.
  const commandMatch = /^\/(\S*)$/.exec(linePrefix);
  if (commandMatch) {
    return {
      kind: 'slash-command',
      query: commandMatch[1] ?? '',
      rangeStart: lineStart,
      rangeEnd: caret,
    };
  }

  const tokenStart = tokenStartForCursor(text, caret);
  const token = text.slice(tokenStart, caret);
  if (!token.startsWith('@')) return null;
  return {
    kind: 'path',
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: caret,
  };
}

/** Replace a range and report where the caret lands. */
export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  return {
    text: `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`,
    cursor: safeStart + replacement.length,
  };
}

/**
 * Rank slash commands for a query. Name matches beat description matches, and
 * a prefix beats a substring — typing "rev" should surface /review, not every
 * command whose description happens to say "review".
 */
export function rankSlashCommands<T extends { name: string; description: string }>(
  commands: T[],
  query: string,
  limit = 12,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands.slice(0, limit);

  const scored: { command: T; score: number }[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const description = command.description.toLowerCase();
    let score = -1;
    if (name === needle) score = 1000;
    else if (name.startsWith(needle)) score = 900 - name.length;
    else if (name.includes(needle)) score = 700 - name.indexOf(needle);
    else if (description.includes(needle)) score = 300 - Math.min(description.indexOf(needle), 200);
    if (score < 0) continue;
    scored.push({ command, score });
  }
  scored.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
  return scored.slice(0, limit).map((entry) => entry.command);
}
