import type { AgentSlashCommand, AgentTranscriptItem } from '../../../shared/agent-types';

// Slash commands the PANE owns.
//
// Claude Code's CLI advertises only part of its command set to SDK hosts: 30 of
// its built-ins are bound to the terminal UI and answer "isn't available in
// this environment" if you send them anyway. Some of those are perfectly
// meaningful in a pane (copy, resume, clear, export…) — the terminal is just
// where they happened to be implemented — so the pane implements them itself.
// The genuinely terminal-bound rest (vim mode, installer, login flows) get a
// straight answer plus somewhere to go, instead of the CLI's flat refusal.

export type PaneCommandName =
  | 'copy'
  | 'resume'
  | 'clear'
  | 'exit'
  | 'help'
  | 'status'
  | 'cost'
  | 'export';

interface PaneCommandSpec {
  name: PaneCommandName;
  /** Extra spellings that resolve here (the CLI has these aliases too). */
  aliases?: string[];
  description: string;
  argumentHint?: string;
}

const PANE_COMMANDS: PaneCommandSpec[] = [
  { name: 'copy', description: "Copy Claude's last reply to the clipboard", argumentHint: '[all]' },
  { name: 'resume', description: 'Open past threads for this folder' },
  { name: 'clear', description: 'Start a fresh thread in this pane' },
  { name: 'exit', aliases: ['quit'], description: 'Close this pane' },
  { name: 'help', description: 'What works in this pane and how' },
  { name: 'status', description: 'Account, model, permissions, context usage' },
  { name: 'cost', description: 'Token and cost totals for this session' },
  { name: 'export', description: 'Save this thread as Markdown' },
];

/**
 * Built-ins the CLI keeps for the terminal. Sending them wastes a round trip
 * and returns a refusal, so the pane answers for them.
 */
const TERMINAL_ONLY = new Set([
  'add-dir',
  'bug',
  'hooks',
  'ide',
  'install-github-app',
  'login',
  'logout',
  'memory',
  'migrate-installer',
  'output-style',
  'permissions',
  'plugin',
  'pr-comments',
  'privacy-settings',
  'release-notes',
  'review',
  'sandbox',
  'statusline',
  'terminal-setup',
  'todos',
  'upgrade',
  'vim',
]);

export type PaneCommandResolution =
  | { kind: 'pane'; name: PaneCommandName; args: string }
  | { kind: 'terminal-only'; name: string }
  | null;

/** Parse a draft. Null means "not a pane command" — send it to the CLI. */
export function resolvePaneCommand(text: string): PaneCommandResolution {
  const match = /^\/([a-z][a-z0-9-]*)\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const args = (match[2] ?? '').trim();

  const spec = PANE_COMMANDS.find(
    (candidate) => candidate.name === name || candidate.aliases?.includes(name),
  );
  if (spec) return { kind: 'pane', name: spec.name, args };
  if (TERMINAL_ONLY.has(name)) return { kind: 'terminal-only', name };
  return null;
}

/**
 * The pane's commands in the same shape the CLI reports its own, so both
 * appear in one `/` menu. Pane commands lead: they are the ones that would
 * otherwise look missing.
 */
export function paneSlashCommands(): AgentSlashCommand[] {
  return PANE_COMMANDS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    ...(spec.argumentHint ? { argumentHint: spec.argumentHint } : {}),
  }));
}

/** What to tell the user about a command that only works in a terminal. */
export function terminalOnlyNote(name: string): string {
  return [
    `**/${name}** only works in a terminal — Claude Code keeps it out of the SDK`,
    'surface it is built on, so this pane cannot run it.',
    '',
    'Open a Terminal pane in this workspace, run `claude`, and use it there.',
  ].join(' ');
}

/** Serialize a transcript for `/copy all` and `/export`. */
export function transcriptToMarkdown(items: AgentTranscriptItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        parts.push(`## You\n\n${item.text}`);
        break;
      case 'assistant':
        parts.push(`## Claude\n\n${item.text}`);
        break;
      case 'tool':
        // The call is the useful record; full output would drown the document.
        parts.push(`> \`${item.name}\` ${item.summary}${item.isError ? ' — failed' : ''}`);
        break;
      case 'plan':
        parts.push(`## Proposed plan\n\n${item.plan}`);
        break;
      case 'note':
        parts.push(`_${item.text}_`);
        break;
      case 'error':
        parts.push(`> **Error:** ${item.message}`);
        break;
      default:
        break;
    }
  }
  return parts.join('\n\n');
}

/** The last thing Claude said, for `/copy`. */
export function lastAssistantText(items: AgentTranscriptItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'assistant' && item.text.trim()) return item.text;
  }
  return null;
}

/** Token/cost totals across a session's turns, for `/cost`. */
export function usageTotals(items: AgentTranscriptItem[]): {
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
} {
  let turns = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const item of items) {
    if (item.kind !== 'turn-end') continue;
    turns += 1;
    // The CLI reports cost cumulatively per session, so the latest turn already
    // carries the running total — summing would multiply it.
    costUsd = Math.max(costUsd, item.usage?.costUsd ?? 0);
    inputTokens += item.usage?.inputTokens ?? 0;
    outputTokens += item.usage?.outputTokens ?? 0;
  }
  return { turns, costUsd, inputTokens, outputTokens };
}
