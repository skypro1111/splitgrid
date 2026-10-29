import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '../../shared/agent-types';
import { flattenToolResult, summarizeTool } from './claude-event-mapper';
import { interpretStoredUserText } from './transcript-text';

// Reading a past conversation out of Claude Code's own session store.
//
// `resume` tells the CLI to continue a thread, but it does not replay it: the
// pane's transcript is built from events its own session emitted, so a resumed
// thread would open blank. The prior messages live in the CLI's JSONL store, so
// the pane loads them and seeds its history with the same event shapes the live
// stream produces — one rendering path for both.

/** Entries beyond this are dropped from the front; a long thread is huge. */
const MAX_ENTRIES = 600;

interface JsonlBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface JsonlEntry {
  type?: string;
  uuid?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  message?: { role?: string; content?: JsonlBlock[] | string };
}

/** Claude's config dir: $CLAUDE_CONFIG_DIR if set, else ~/.claude. */
function claudeConfigDir(override?: string): string {
  const explicit = (override ?? process.env.CLAUDE_CONFIG_DIR ?? '').trim();
  return explicit ? explicit : path.join(homedir(), '.claude');
}

/**
 * Locate a session's JSONL. The CLI encodes the project directory into the
 * folder name (slashes, dots and spaces all become dashes), so rather than
 * reimplement that mangling — and break the day it changes — we look the
 * session id up across the project folders.
 */
export async function findSessionFile(
  sessionId: string,
  configDir?: string,
): Promise<string | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) return null;
  const projects = path.join(claudeConfigDir(configDir), 'projects');
  let dirs: string[];
  try {
    dirs = (await readdir(projects, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    try {
      // Existence only — the caller reads it; a long thread is megabytes.
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not in this project folder; keep looking.
    }
  }
  return null;
}

/** Convert the CLI's stored entries into the pane's event shapes. */
export function transcriptEventsFromJsonl(sessionId: string, raw: string): AgentEvent[] {
  const entries: JsonlEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as JsonlEntry);
    } catch {
      // A partially written trailing line is normal on a live session.
    }
  }

  const events: AgentEvent[] = [];
  const conversational = entries.filter(
    (entry) =>
      (entry.type === 'user' || entry.type === 'assistant') &&
      // Meta entries are machinery (caveats, command wrappers) and sidechains
      // belong to subagents — neither is part of the conversation the user had.
      entry.isMeta !== true &&
      entry.isSidechain !== true,
  );
  const recent = conversational.slice(Math.max(0, conversational.length - MAX_ENTRIES));

  recent.forEach((entry, index) => {
    const content = entry.message?.content;
    const uuid = entry.uuid ?? `h${index}`;

    if (entry.type === 'user') {
      const pushUserText = (raw: string, suffix = '') => {
        const interpreted = interpretStoredUserText(raw);
        const itemId = `h:${uuid}${suffix}`;
        if (interpreted.kind === 'hidden') return;
        if (interpreted.kind === 'text' || interpreted.kind === 'command') {
          // A slash command is what the user typed, so it stays a user bubble;
          // the pane just shows the command line rather than its envelope.
          events.push({ type: 'user.message', sessionId, itemId, text: interpreted.text });
          return;
        }
        // Local command output is the app answering, not Claude.
        events.push({ type: 'pane.note', sessionId, itemId, text: interpreted.text });
      };

      if (typeof content === 'string') {
        pushUserText(content);
        return;
      }
      if (!Array.isArray(content)) return;
      content.forEach((block, blockIndex) => {
        if (block?.type === 'text' && block.text) {
          pushUserText(block.text, `:${blockIndex}`);
        } else if (block?.type === 'tool_result' && block.tool_use_id) {
          events.push({
            type: 'tool.end',
            sessionId,
            itemId: `tool:${block.tool_use_id}`,
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            output: flattenToolResult(block.content),
          });
        }
      });
      return;
    }

    if (!Array.isArray(content)) return;
    content.forEach((block, blockIndex) => {
      const itemId = `h:${uuid}:${blockIndex}`;
      if (block?.type === 'text' && block.text) {
        events.push({ type: 'text.delta', sessionId, itemId, kind: 'assistant', text: block.text });
        events.push({ type: 'text.end', sessionId, itemId });
      } else if (block?.type === 'thinking' && block.thinking) {
        events.push({
          type: 'text.delta',
          sessionId,
          itemId,
          kind: 'thinking',
          text: block.thinking,
        });
        events.push({ type: 'text.end', sessionId, itemId });
      } else if (block?.type === 'tool_use') {
        const toolUseId = block.id ?? itemId;
        const name = block.name ?? 'tool';
        events.push({
          type: 'tool.start',
          sessionId,
          itemId: `tool:${toolUseId}`,
          toolUseId,
          name,
          summary: summarizeTool(name, block.input),
          input: block.input,
        });
      }
    });
  });

  return events;
}

/**
 * The stored conversation for `resumeSessionId`, as pane events. Empty when the
 * thread has no store yet (or the store moved) — a blank resumed pane is a
 * cosmetic loss, never a reason to fail the session.
 */
export async function loadSessionTranscript(
  paneSessionId: string,
  resumeSessionId: string,
  configDir?: string,
): Promise<AgentEvent[]> {
  const file = await findSessionFile(resumeSessionId, configDir);
  if (!file) return [];
  try {
    return transcriptEventsFromJsonl(paneSessionId, await readFile(file, 'utf8'));
  } catch {
    return [];
  }
}
