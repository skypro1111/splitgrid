import { describe, expect, it } from 'vitest';
import {
  lastAssistantText,
  paneSlashCommands,
  resolvePaneCommand,
  transcriptToMarkdown,
  usageTotals,
} from './paneCommands';
import type { AgentTranscriptItem } from '../../../shared/agent-types';

describe('resolvePaneCommand', () => {
  it('claims the commands the pane implements', () => {
    expect(resolvePaneCommand('/copy')).toEqual({ kind: 'pane', name: 'copy', args: '' });
    expect(resolvePaneCommand('/copy all')).toEqual({ kind: 'pane', name: 'copy', args: 'all' });
    expect(resolvePaneCommand('/resume')).toMatchObject({ kind: 'pane', name: 'resume' });
  });

  it('maps aliases to their command', () => {
    expect(resolvePaneCommand('/quit')).toMatchObject({ kind: 'pane', name: 'exit' });
  });

  it('flags commands the CLI keeps for the terminal', () => {
    expect(resolvePaneCommand('/vim')).toEqual({ kind: 'terminal-only', name: 'vim' });
    expect(resolvePaneCommand('/login')).toEqual({ kind: 'terminal-only', name: 'login' });
  });

  it('leaves CLI commands alone', () => {
    // /context and /model are served by the CLI itself and must reach it.
    expect(resolvePaneCommand('/context')).toBeNull();
    expect(resolvePaneCommand('/model opus')).toBeNull();
  });

  it('is not fooled by prose that merely contains a slash', () => {
    expect(resolvePaneCommand('look at /etc/hosts')).toBeNull();
    expect(resolvePaneCommand('what does /copy do?')).toBeNull();
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(resolvePaneCommand('  /COPY  ')).toMatchObject({ kind: 'pane', name: 'copy' });
  });
});

describe('paneSlashCommands', () => {
  it('describes every pane command for the picker', () => {
    const commands = paneSlashCommands();
    expect(commands.map((command) => command.name)).toContain('copy');
    expect(commands.every((command) => command.description.length > 0)).toBe(true);
  });
});

const TRANSCRIPT: AgentTranscriptItem[] = [
  { id: 'u1', kind: 'user', text: 'fix the build' },
  { id: 'a1', kind: 'assistant', text: 'Looking now.', streaming: false },
  {
    id: 't1',
    kind: 'tool',
    toolUseId: 'tu1',
    name: 'Bash',
    summary: 'npm test',
    input: {},
    running: false,
  },
  { id: 'a2', kind: 'assistant', text: 'Fixed it.', streaming: false },
  { id: 'e1', kind: 'turn-end', status: 'completed', usage: { costUsd: 0.05, inputTokens: 10, outputTokens: 5 } },
];

describe('transcriptToMarkdown', () => {
  it('renders the conversation with roles', () => {
    const markdown = transcriptToMarkdown(TRANSCRIPT);
    expect(markdown).toContain('## You\n\nfix the build');
    expect(markdown).toContain('## Claude\n\nFixed it.');
    expect(markdown).toContain('`Bash` npm test');
  });

  it('is empty for an empty transcript', () => {
    expect(transcriptToMarkdown([])).toBe('');
  });
});

describe('lastAssistantText', () => {
  it('returns the most recent reply', () => {
    expect(lastAssistantText(TRANSCRIPT)).toBe('Fixed it.');
  });

  it('skips blank replies and reports nothing to copy', () => {
    expect(lastAssistantText([{ id: 'a', kind: 'assistant', text: '  ', streaming: false }])).toBeNull();
  });
});

describe('usageTotals', () => {
  it('sums tokens but takes cost as the running total', () => {
    const totals = usageTotals([
      ...TRANSCRIPT,
      { id: 'e2', kind: 'turn-end', status: 'completed', usage: { costUsd: 0.09, inputTokens: 4, outputTokens: 2 } },
    ]);
    // The CLI reports cost cumulatively, so the latest turn IS the total.
    expect(totals.costUsd).toBe(0.09);
    expect(totals.turns).toBe(2);
    expect(totals.inputTokens).toBe(14);
    expect(totals.outputTokens).toBe(7);
  });

  it('reports nothing for a thread with no turns', () => {
    expect(usageTotals([])).toEqual({ turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
  });
});
