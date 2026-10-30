import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { interpretStoredUserText } from '../agent/transcript-text';
import type { ChunkKind, ParsedTranscript, SessionMeta, TranscriptChunk } from './types';

// Turning Claude Code's JSONL session store into retrievable chunks.
//
// The store records far more than the conversation: API request blobs, file
// snapshots, permission-mode flips, background-task reports, slash-command
// envelopes and every tool result in full. The history index wants none of
// that noise, only what was asked and what the assistant said and did, so this
// module reduces a transcript to turns (one real prompt plus everything the
// assistant wrote until the next one) and gives each a deterministic id.
// Re-parsing a grown file then yields the same ids, and the store re-embeds
// only the chunks whose hash moved.
//
// Pure Node on purpose: no Electron, so the whole thing runs under vitest.
// It reads the same records as src/main/agent/session-transcript.ts and reuses
// its envelope interpretation (transcript-text.ts), but it does NOT apply that
// module's "anything still starting with a tag is machinery" rule, because a
// user who pastes `<div>…` has typed a prompt.

// ─── Tunables ────────────────────────────────────────────────────────────────

/**
 * A prompt shorter than this ("ok", "yes", "continue") does not open a turn of
 * its own. It is folded into the current turn as a follow-up exchange. Dropping
 * it would lose the work the assistant did next, which is often the most
 * valuable part of a session ("go ahead" → the implementation). Folding keeps
 * that work next to the request it answers, which also helps retrieval.
 */
export const MIN_PROMPT_CHARS = 15;

/**
 * Upper bound on one chunk's text. Around 3 chars per token keeps an embedded
 * chunk within about 6000 tokens; a longer turn is split into parts.
 */
export const MAX_CHUNK_CHARS = 18_000;

/** One-line tool markers are cut to this length. */
export const TOOL_MARKER_CHARS = 100;

/** How much of the prompt a continuation part repeats, so it stays in context. */
const CONTINUATION_PROMPT_CHARS = 300;

/** Tools whose `file_path` / `notebook_path` input means "this turn changed that file". */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * User text that the CLI generated rather than the user typing it. Slash
 * commands (`<command-name>`) and task notifications are absent on purpose:
 * they are recognised separately below.
 */
const SYSTEM_PREFIXES = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<command-stdout>',
  '<command-stderr>',
  '<system-reminder>',
  '<user-prompt-submit-hook>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '[Request interrupted',
  'Caveat:',
];

// ─── File discovery ──────────────────────────────────────────────────────────

/** One transcript file found under ~/.claude/projects. */
export interface TranscriptFile {
  /** Session id: file stem (`<uuid>` for a main session, `agent-<id>` for a subagent). */
  id: string;
  /** Absolute path of the .jsonl file. */
  file: string;
  /** Main session this subagent transcript belongs to; undefined for a main session. */
  parentSessionId?: string;
  size: number;
  mtimeMs: number;
}

async function listDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    // Missing, unreadable or vanished mid-scan: nothing to index here.
    return [];
  }
}

async function statFile(
  file: string,
  id: string,
  parentSessionId?: string,
): Promise<TranscriptFile | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    return {
      id,
      file,
      ...(parentSessionId ? { parentSessionId } : {}),
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return null;
  }
}

/**
 * Every main-session and subagent transcript under `projectsDir`:
 *   <slug>/<sessionId>.jsonl
 *   <slug>/<sessionId>/subagents/agent-<id>.jsonl
 * The slug is a lossy encoding of the project path (space and `/` both become
 * `-`), so it is never decoded. Workspace membership comes from the records'
 * `cwd` instead (see transcriptBelongsTo). Results are sorted by path so the
 * output is deterministic.
 */
export async function discoverTranscriptFiles(projectsDir: string): Promise<TranscriptFile[]> {
  const pending: Promise<TranscriptFile | null>[] = [];
  for (const project of await listDir(projectsDir)) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(projectsDir, project.name);
    for (const entry of await listDir(projectPath)) {
      const entryPath = path.join(projectPath, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        pending.push(statFile(entryPath, entry.name.slice(0, -'.jsonl'.length)));
      } else if (entry.isDirectory()) {
        // Only `<sessionId>/subagents/` holds transcripts. `memory/` and
        // `tool-results/` have no such child, so a failed listing costs nothing.
        const subDir = path.join(entryPath, 'subagents');
        for (const sub of await listDir(subDir)) {
          if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue;
          pending.push(
            statFile(path.join(subDir, sub.name), sub.name.slice(0, -'.jsonl'.length), entry.name),
          );
        }
      }
    }
  }
  const found = (await Promise.all(pending)).filter((f): f is TranscriptFile => f !== null);
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// ─── Record shapes ───────────────────────────────────────────────────────────

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

interface RecordLike {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  /** `{kind: 'human' | 'task-notification' | 'peer' | 'coordinator' | …}`. */
  origin?: { kind?: string };
  /** `'human' | 'scheduled' | 'task_notification' | 'peer' | 'auto_continuation' | 'sdk'`. */
  turnOrigin?: string;
  aiTitle?: string;
  customTitle?: string;
  relocatedCwd?: string;
  message?: { role?: string; model?: string; content?: string | Block[] };
  attachment?: {
    type?: string;
    prompt?: unknown;
    commandMode?: string;
    origin?: { kind?: string };
    isMeta?: boolean;
  };
}

// ─── Chunk building ──────────────────────────────────────────────────────────

type Role = 'user' | 'assistant' | 'summary';

/** One rendered line or paragraph of a turn, already redacted. */
interface Piece {
  role: Role;
  text: string;
  ts: number;
  files?: string[];
}

interface Turn {
  seq: number;
  kind: ChunkKind;
  ts: number;
  /** Redacted prompt that opened the turn (null for assistant output with no prompt before it). */
  opener: string | null;
  /** The opener arrived as a queued-command attachment (see openPrompt's dedupe). */
  openerQueued: boolean;
  pieces: Piece[];
  /** Real assistant text or non-empty thinking was seen; tool markers alone don't count. */
  hasAssistantText: boolean;
}

export interface ParseOptions {
  maxChunkChars?: number;
  minPromptChars?: number;
  /** Diagnostics: called once per redacted secret with the rule name and the original match. */
  onRedact?: (rule: string, match: string) => void;
}

export interface TranscriptSource {
  file: string;
  /** Defaults to the file stem. */
  id?: string;
  /** Defaults to the `<sessionId>` directory when the file sits in `<sessionId>/subagents/`. */
  parentSessionId?: string;
}

function toMs(ts: unknown): number {
  if (typeof ts !== 'string') return 0;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * A short, searchable stand-in for a tool call. The result is left out
 * entirely: outputs are large, mostly noise, and already reflected in what the
 * assistant says next.
 */
function toolMarker(name: string, input: unknown): string {
  const pick = (key: string) => stringField(input, key);
  let detail: string | undefined;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      detail = pick('description') ?? pick('command');
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      detail = pick('file_path') ?? pick('notebook_path');
      break;
    case 'Glob':
    case 'Grep': {
      const pattern = pick('pattern');
      const where = pick('path');
      detail = pattern ? `${pattern}${where ? ` in ${where}` : ''}` : where;
      break;
    }
    case 'WebFetch':
      detail = pick('url');
      break;
    case 'WebSearch':
      detail = pick('query');
      break;
    case 'Task':
    case 'Agent':
      detail = pick('description') ?? pick('subagent_type');
      break;
    case 'Skill':
      detail = pick('skill') ?? pick('command');
      break;
    case 'TodoWrite':
      detail = undefined;
      break;
    default:
      detail =
        pick('command') ??
        pick('file_path') ??
        pick('path') ??
        pick('url') ??
        pick('query') ??
        pick('description') ??
        pick('pattern') ??
        pick('prompt');
  }
  return detail ? `[${name}] ${oneLine(detail, TOOL_MARKER_CHARS)}` : `[${name}]`;
}

function editedFile(name: string, input: unknown, cwd: string | undefined): string | undefined {
  if (!EDIT_TOOLS.has(name)) return undefined;
  const raw = stringField(input, 'file_path') ?? stringField(input, 'notebook_path');
  if (!raw) return undefined;
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || !cwd) return raw;
  return path.join(cwd, raw);
}

/** Text of a user message body, from a string or its `text` blocks (tool_result/image ignored). */
function userTexts(content: unknown): string[] {
  if (typeof content === 'string') return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content as Block[]) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      texts.push(block.text);
    }
  }
  return texts;
}

type UserTextKind =
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; text: string }
  | { kind: 'notification'; text: string }
  | { kind: 'ignore' };

/** Inline wrappers that can ride along inside a real prompt. */
function stripInlineNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, '')
    .trim();
}

/**
 * Decide what one stored user text is. A slash command counts as a prompt: the
 * `<command-name>` record is literally what the user typed, and skills such as
 * `/sg-terminal <ask>` get a real assistant reply. Built-ins like `/model` get
 * no reply, so their turn is dropped later by the "no assistant text" rule. The
 * skill's expanded body arrives separately as an isMeta record and is ignored.
 */
function classifyUserText(raw: string): UserTextKind {
  const source = raw.trim();
  if (!source) return { kind: 'ignore' };
  if (source.startsWith('<task-notification>')) {
    const read = interpretStoredUserText(source);
    return { kind: 'notification', text: read.kind === 'hidden' ? '' : read.text };
  }
  if (source.startsWith('<command-name>') || source.startsWith('<command-message>')) {
    const read = interpretStoredUserText(source);
    return read.kind === 'command' && read.text ? { kind: 'command', text: read.text } : { kind: 'ignore' };
  }
  if (SYSTEM_PREFIXES.some((prefix) => source.startsWith(prefix))) {
    // A typed prompt can still follow a leading reminder; only an envelope with
    // nothing else in it is machinery.
    const rest = stripInlineNoise(source);
    if (!rest || SYSTEM_PREFIXES.some((prefix) => rest.startsWith(prefix))) return { kind: 'ignore' };
    return { kind: 'prompt', text: rest };
  }
  const cleaned = stripInlineNoise(source);
  return cleaned ? { kind: 'prompt', text: cleaned } : { kind: 'ignore' };
}

/** `Another Claude session sent a message:\n<agent-message from="…">body</agent-message>` → body. */
function peerMessageBody(text: string): string {
  return text
    .replace(/^\s*Another Claude session sent a message:\s*/, '')
    .replace(/<agent-message\b[^>]*>/g, '')
    .replace(/<\/agent-message>/g, '')
    .trim();
}

function attachmentPromptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  return userTexts(prompt).join('\n');
}

const ROLE_LABEL: Record<Role, string> = {
  user: 'User: ',
  assistant: 'Assistant: ',
  summary: 'Compaction summary: ',
};

/** Characters `piece` adds when appended after a piece of role `prev`. */
function pieceCost(piece: Piece, prev: Role | null): number {
  if (prev === piece.role) return 1 + piece.text.length;
  return (prev === null ? 0 : 2) + ROLE_LABEL[piece.role].length + piece.text.length;
}

function renderPieces(pieces: Piece[]): string {
  const out: string[] = [];
  let prev: Role | null = null;
  for (const piece of pieces) {
    if (piece.role !== prev) {
      if (prev !== null) out.push('\n\n');
      out.push(ROLE_LABEL[piece.role]);
    } else {
      out.push('\n');
    }
    out.push(piece.text);
    prev = piece.role;
  }
  return out.join('');
}

/** Cut an oversized piece into slices of at most `max` chars, preferring line breaks. */
function slicePiece(piece: Piece, max: number): Piece[] {
  if (piece.text.length <= max) return [piece];
  const slices: Piece[] = [];
  const text = piece.text;
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > start + max / 2) end = newline + 1;
      // Never cut a surrogate pair in half.
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    const slice = text.slice(start, end).trim();
    if (slice) {
      slices.push({
        role: piece.role,
        text: slice,
        ts: piece.ts,
        ...(slices.length === 0 && piece.files ? { files: piece.files } : {}),
      });
    }
    start = end;
  }
  return slices;
}

function hashChunk(text: string, files: string[]): string {
  return createHash('sha1').update(text).update('\0').update(files.join('\n')).digest('hex');
}

/**
 * Render a turn into one or more chunks. Packing is greedy from the start, so a
 * turn that grows only changes its last part. Earlier parts keep their text and
 * hash, so they are not re-embedded. Part 0 keeps the bare `<sid>:<seq>` id,
 * so a turn that crosses the budget only gains ids and never renames one.
 */
function chunksForTurn(turn: Turn, sessionId: string, budget: number): TranscriptChunk[] {
  const header: Piece | null =
    turn.opener !== null
      ? {
          role: turn.kind === 'compact_summary' ? 'summary' : 'user',
          text: `${oneLine(turn.opener, CONTINUATION_PROMPT_CHARS)} (continued)`,
          ts: turn.ts,
        }
      : null;
  const headerCost = header ? pieceCost(header, null) : 0;
  // Leave room for the header and the role label so any slice fits in a fresh part.
  const maxPiece = Math.max(1000, budget - headerCost - 64);
  const pieces = turn.pieces.flatMap((piece) => slicePiece(piece, maxPiece));

  const parts: Piece[][] = [];
  let current: Piece[] = [];
  let currentLen = 0;
  let realInCurrent = 0;
  let prev: Role | null = null;
  for (const piece of pieces) {
    let cost = pieceCost(piece, prev);
    if (realInCurrent > 0 && currentLen + cost > budget) {
      parts.push(current);
      current = header ? [header] : [];
      currentLen = headerCost;
      prev = header ? header.role : null;
      realInCurrent = 0;
      cost = pieceCost(piece, prev);
    }
    current.push(piece);
    currentLen += cost;
    realInCurrent += 1;
    prev = piece.role;
  }
  if (realInCurrent > 0) parts.push(current);

  return parts.map((part, index) => {
    const text = renderPieces(part);
    const files: string[] = [];
    for (const piece of part) {
      for (const file of piece.files ?? []) if (!files.includes(file)) files.push(file);
    }
    const first = part.find((piece) => piece !== header);
    return {
      id: index === 0 ? `${sessionId}:${turn.seq}` : `${sessionId}:${turn.seq}.${index}`,
      sessionId,
      seq: turn.seq,
      ts: first?.ts || turn.ts,
      kind: turn.kind,
      text,
      files,
      hash: hashChunk(text, files),
    };
  });
}

/**
 * Record types this module never reads. Each is written with `type` as its
 * first key, so it is recognised from the line's first bytes and skipped
 * before UTF-8 decoding and JSON.parse. On the largest real transcript,
 * decoding cost about as much as parsing, and these lines were ~12% of it.
 * A type missing from this list is still parsed and then ignored, so the list
 * only has to be safe, not complete.
 */
const SKIPPED_TYPES = new Set([
  'file-history-snapshot',
  'file-history-delta',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'queue-operation',
  'mode',
  'permission-mode',
  'atis-latch',
  'bridge-session',
  'last-prompt',
  'agent-name',
  'cost-state',
  'tools-used',
  'frame-link',
  'progress',
  'worktree-state',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
]);
const TYPE_PREFIX = '{"type":"';
const TYPE_PREFIX_BYTES = Buffer.from(TYPE_PREFIX);

function skippedByPrefix(head: string): boolean {
  if (!head.startsWith(TYPE_PREFIX)) return false;
  const close = head.indexOf('"', TYPE_PREFIX.length);
  return close !== -1 && SKIPPED_TYPES.has(head.slice(TYPE_PREFIX.length, close));
}

/** Yield each line of `content` worth parsing, without building an array of every line first. */
function* lines(content: string | Uint8Array): Generator<string> {
  if (typeof content === 'string') {
    let start = 0;
    while (start < content.length) {
      let end = content.indexOf('\n', start);
      if (end === -1) end = content.length;
      if (end > start && !skippedByPrefix(content.slice(start, Math.min(end, start + 48)))) {
        yield content.slice(start, end);
      }
      start = end + 1;
    }
    return;
  }
  // Decode line by line: the largest transcripts are 100+ MB, and one string of
  // the whole file is wasteful (it also has a hard size cap in V8).
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(10, start);
    if (end === -1) end = buf.length;
    if (end > start) {
      const typed = buf.compare(TYPE_PREFIX_BYTES, 0, TYPE_PREFIX_BYTES.length, start, Math.min(end, start + TYPE_PREFIX_BYTES.length)) === 0;
      // Type names are ASCII, so latin1 decoding of the head is exact and cheap.
      if (!typed || !skippedByPrefix(buf.toString('latin1', start, Math.min(end, start + 48)))) {
        yield buf.toString('utf8', start, end);
      }
    }
    start = end + 1;
  }
}

function resolveSource(source: string | TranscriptSource): Required<Pick<TranscriptSource, 'file' | 'id'>> & {
  parentSessionId?: string;
} {
  const src = typeof source === 'string' ? { file: source } : source;
  const id = src.id ?? path.basename(src.file).replace(/\.jsonl$/, '');
  let parentSessionId = src.parentSessionId;
  if (parentSessionId === undefined) {
    const dir = path.dirname(src.file);
    if (path.basename(dir) === 'subagents') parentSessionId = path.basename(path.dirname(dir));
  }
  return { file: src.file, id, ...(parentSessionId ? { parentSessionId } : {}) };
}

/**
 * Parse transcript content (already read) into session meta and chunks. Lines
 * that are not valid JSON are skipped. That is how a truncated last line of a
 * file still being written is tolerated.
 */
export function parseTranscriptContent(
  content: string | Uint8Array,
  source: string | TranscriptSource,
  opts: ParseOptions = {},
): ParsedTranscript {
  const { file, id, parentSessionId } = resolveSource(source);
  const budget = Math.max(2000, opts.maxChunkChars ?? MAX_CHUNK_CHARS);
  const minPrompt = opts.minPromptChars ?? MIN_PROMPT_CHARS;
  const redact = (text: string) => redactSecrets(text, opts.onRedact);

  const cwds: string[] = [];
  const cwdSet = new Set<string>();
  const addCwd = (cwd: unknown) => {
    if (typeof cwd === 'string' && cwd && !cwdSet.has(cwd)) {
      cwdSet.add(cwd);
      cwds.push(cwd);
    }
  };
  let firstTs = 0;
  let lastTs = 0;
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let gitBranch: string | undefined;

  // Resumed sessions replay earlier records with the same uuid further down the
  // file. On real data that was thousands of identical copies. The first copy
  // wins, which keeps seq stable as the file grows.
  const seen = new Set<string>();
  const turns: Turn[] = [];
  let current: Turn | null = null;
  let nextSeq = 0;

  const openTurn = (kind: ChunkKind, opener: string | null, ts: number, queued = false): Turn => {
    const turn: Turn = {
      seq: nextSeq++,
      kind,
      ts,
      opener,
      openerQueued: queued,
      pieces: [],
      hasAssistantText: false,
    };
    if (opener !== null) turn.pieces.push({ role: kind === 'compact_summary' ? 'summary' : 'user', text: opener, ts });
    turns.push(turn);
    return turn;
  };

  const openPrompt = (raw: string, ts: number, flags: { queued?: boolean; exempt?: boolean } = {}) => {
    const text = redact(raw.trim());
    if (!text) return;
    // A prompt typed while the assistant was busy is stored as a queued-command
    // attachment, and occasionally a second time as a user record. Keep one.
    if (!flags.queued && current?.openerQueued && current.opener === text) return;
    if (!flags.exempt && text.length < minPrompt && current) {
      current.pieces.push({ role: 'user', text, ts });
      return;
    }
    current = openTurn('turn', text, ts, flags.queued === true);
  };

  const pushAssistant = (text: string, ts: number, isText: boolean, files?: string[]) => {
    // Assistant output with no prompt before it (a transcript that starts
    // mid-conversation) still deserves a chunk.
    if (!current) current = openTurn('turn', null, ts);
    current.pieces.push({ role: 'assistant', text: redact(text), ts, ...(files?.length ? { files } : {}) });
    if (isText) current.hasAssistantText = true;
  };

  /** Background-task completion: part of the current turn, never a new one. */
  const pushNotification = (summary: string, ts: number) => {
    if (!current) return;
    const marker = summary ? `[task-notification] ${oneLine(summary, TOOL_MARKER_CHARS * 2)}` : '[task-notification]';
    current.pieces.push({ role: 'assistant', text: redact(marker), ts });
  };

  const handleUser = (record: RecordLike, ts: number) => {
    const texts = userTexts(record.message?.content);
    if (texts.length === 0) return; // tool_result-only (or image-only): not a new prompt

    if (record.isCompactSummary) {
      const text = redact(texts.join('\n').trim());
      // The summary is its own chunk. The turn it interrupted (auto-compaction
      // fires mid-turn) keeps collecting what the assistant does next.
      if (text) openTurn('compact_summary', text, ts);
      return;
    }

    const originKind = record.origin?.kind;
    const joined = texts.join('\n');
    if (originKind === 'peer' || record.turnOrigin === 'peer') {
      const body = peerMessageBody(joined);
      if (body) openPrompt(`[peer message] ${body}`, ts, { exempt: true });
      return;
    }
    if (record.isMeta) {
      // Meta records are machinery (skill bodies, caveats, image dimensions,
      // "usage limit reset, continue"), with two exceptions that start new work:
      // scheduled wake-ups, and a subagent's prompt sent by its coordinator.
      if (record.turnOrigin === 'scheduled') {
        const body = stripInlineNoise(joined);
        if (body) openPrompt(`[scheduled] ${body}`, ts, { exempt: true });
      } else if (originKind === 'coordinator') {
        const body = stripInlineNoise(joined);
        if (body) openPrompt(body, ts, { exempt: true });
      }
      return;
    }
    if (originKind === 'task-notification' || record.turnOrigin === 'task_notification') {
      const read = classifyUserText(joined);
      pushNotification(read.kind === 'notification' || read.kind === 'prompt' ? read.text : '', ts);
      return;
    }

    const prompts: string[] = [];
    for (const text of texts) {
      const read = classifyUserText(text);
      if (read.kind === 'prompt') prompts.push(read.text);
      else if (read.kind === 'command') openPrompt(read.text, ts, { exempt: true });
      else if (read.kind === 'notification') pushNotification(read.text, ts);
    }
    if (prompts.length) openPrompt(prompts.join('\n'), ts);
  };

  const handleAssistant = (record: RecordLike, ts: number) => {
    // Error stand-ins and synthetic placeholders ("No response requested.") are
    // not something the model said.
    if (record.isApiErrorMessage || record.message?.model === '<synthetic>') return;
    const content = record.message?.content;
    if (typeof content === 'string') {
      if (content.trim()) pushAssistant(content.trim(), ts, true);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === 'text') {
        const text = typeof block.text === 'string' ? block.text.trim() : '';
        if (text) pushAssistant(text, ts, true);
      } else if (block?.type === 'thinking') {
        // With thinking display omitted the block is stored with an empty string.
        const text = typeof block.thinking === 'string' ? block.thinking.trim() : '';
        if (text) pushAssistant(`[thinking] ${text}`, ts, true);
      } else if (block?.type === 'tool_use') {
        const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
        const edited = editedFile(name, block.input, record.cwd);
        pushAssistant(toolMarker(name, block.input), ts, false, edited ? [edited] : undefined);
      }
    }
  };

  const handleAttachment = (record: RecordLike, ts: number) => {
    const attachment = record.attachment;
    if (attachment?.type !== 'queued_command' || attachment.isMeta) return;
    const text = attachmentPromptText(attachment.prompt);
    if (!text.trim()) return;
    if (attachment.commandMode === 'task-notification') {
      const read = classifyUserText(text);
      pushNotification(read.kind === 'notification' || read.kind === 'prompt' ? read.text : '', ts);
      return;
    }
    if (attachment.commandMode !== 'prompt') return;
    // A prompt typed while the assistant was busy is delivered mid-turn as this
    // attachment and, on real data, almost never also as a user record. It is
    // the user's words, so it opens a turn like a typed prompt.
    const originKind = attachment.origin?.kind;
    if (originKind === 'peer') {
      const body = peerMessageBody(text);
      if (body) openPrompt(`[peer message] ${body}`, ts, { exempt: true, queued: true });
      return;
    }
    if (originKind !== undefined && originKind !== 'human') return;
    const read = classifyUserText(text);
    if (read.kind === 'prompt') openPrompt(read.text, ts, { queued: true });
    else if (read.kind === 'command') openPrompt(read.text, ts, { queued: true, exempt: true });
  };

  for (const line of lines(content)) {
    let record: RecordLike;
    try {
      record = JSON.parse(line) as RecordLike;
    } catch {
      continue; // truncated tail of a live session, or a corrupt line
    }
    if (!record || typeof record !== 'object') continue;
    if (record.uuid && (record.type === 'user' || record.type === 'assistant')) {
      if (seen.has(record.uuid)) continue;
      seen.add(record.uuid);
    }

    const ts = toMs(record.timestamp);
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    addCwd(record.cwd);
    if (typeof record.gitBranch === 'string' && record.gitBranch) gitBranch = record.gitBranch;

    switch (record.type) {
      case 'user':
        handleUser(record, ts);
        break;
      case 'assistant':
        handleAssistant(record, ts);
        break;
      case 'attachment':
        handleAttachment(record, ts);
        break;
      case 'ai-title':
        if (typeof record.aiTitle === 'string' && record.aiTitle.trim()) aiTitle = record.aiTitle.trim();
        break;
      case 'custom-title':
        if (typeof record.customTitle === 'string' && record.customTitle.trim()) {
          customTitle = record.customTitle.trim();
        }
        break;
      case 'relocated':
        addCwd(record.relocatedCwd);
        break;
      default:
        break;
    }
  }

  const chunks: TranscriptChunk[] = [];
  for (const turn of turns) {
    if (turn.kind === 'turn' && !turn.hasAssistantText) continue;
    chunks.push(...chunksForTurn(turn, id, budget));
  }

  // A title the user set wins over the generated one. Titles are derived from
  // prompts, so they get the same redaction as chunk text.
  const title = customTitle ?? aiTitle;
  const meta: SessionMeta = {
    id,
    file,
    ...(parentSessionId ? { parentSessionId } : {}),
    cwds,
    firstTs,
    lastTs,
    ...(title ? { title: redactSecrets(title) } : {}),
    ...(gitBranch ? { gitBranch } : {}),
  };
  return { meta, chunks };
}

/**
 * Read and parse one transcript. The whole file is re-parsed on every change.
 * Ids are deterministic, so the store re-embeds only chunks whose hash moved.
 * A subagent transcript without an `ai-title` takes its title from the
 * sibling `agent-<id>.meta.json` (the task description the parent gave it).
 */
export async function parseTranscript(
  source: string | TranscriptSource,
  opts: ParseOptions = {},
): Promise<ParsedTranscript> {
  const resolved = resolveSource(source);
  const parsed = parseTranscriptContent(await readFile(resolved.file), resolved, opts);
  if (!parsed.meta.title && resolved.parentSessionId) {
    try {
      const metaFile = resolved.file.replace(/\.jsonl$/, '.meta.json');
      const sidecar = JSON.parse(await readFile(metaFile, 'utf8')) as { description?: unknown };
      if (typeof sidecar.description === 'string' && sidecar.description.trim()) {
        parsed.meta.title = redactSecrets(sidecar.description.trim());
      }
    } catch {
      // No sidecar (older CLI) or unreadable: an untitled subagent is fine.
    }
  }
  return parsed;
}

// ─── Redaction ───────────────────────────────────────────────────────────────

const REDACTED = '[REDACTED]';

/** Values that name or reference a secret instead of being one. */
const PLACEHOLDER_WORDS = new Set([
  'null', 'none', 'nil', 'undefined', 'true', 'false', 'string', 'str', 'number', 'int',
  'integer', 'boolean', 'bool', 'any', 'object', 'unknown', 'required', 'optional', 'password',
  'passwd', 'secret', 'token', 'redacted', 'hidden', 'masked', 'example', 'placeholder',
  'changeme', 'empty', 'default',
]);

function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  // $VAR, ${VAR}, {{ x }}, {env:X}, f"{api_key}", <your-key>, %s, #{x}, [REDACTED, [...]
  if (/^[$%<@#{[]/.test(v)) return true;
  if (v.includes(REDACTED)) return true;
  if (/process\.env|os\.environ|getenv|import\.meta\.env|secrets\./.test(v)) return true;
  if (/^[*x•.…]+$/i.test(v)) return true; // ****, xxxx, ..., …
  if (/^(?:your|my|some|the)[_-]/i.test(v)) return true;
  return PLACEHOLDER_WORDS.has(v.toLowerCase());
}

/** Key words whose `key=value` / `key: value` assignments carry a secret. */
const STRONG_KEYWORDS = [
  'PASSWORD', '[Pp]assword', 'PASSWD', '[Pp]asswd', 'PASSPHRASE', '[Pp]assphrase',
  'SSHPASS', '[Ss]shpass',
];
const TOKEN_KEYWORDS = [
  'CLIENT[_-]?SECRET', '[Cc]lient[_-]?[Ss]ecret', 'SECRET', '[Ss]ecret',
  'TOKEN', '[Tt]oken', 'API[_-]?KEY', '[Aa]pi[_-]?[Kk]ey', 'ACCESS[_-]?KEY', '[Aa]ccess[_-]?[Kk]ey',
  'AUTH[_-]?KEY', '[Aa]uth[_-]?[Kk]ey', 'PRIVATE[_-]?KEY', '[Pp]rivate[_-]?[Kk]ey',
  // Bare `PASS` only in env form (`DB_PASS=…`, enforced below): in prose,
  // "Tests pass: 120/120" is far more common than a password.
  'PASS',
];
const KEYWORD = `(?:${[...STRONG_KEYWORDS, ...TOKEN_KEYWORDS].join('|')})`;

/**
 * Suffixes that turn a secret-sounding key into metadata about it:
 * TOKEN_URL, token_count, passwordField, SECRET_NAME, …
 */
const NON_SECRET_SUFFIX =
  /^(?:types?|counts?|limits?|url|uri|files?|paths?|dir|names?|ids?|endpoint|expiry|expires|expiration|ttl|len|length|size|budget|usage|kind|header|field|prefix|env|var|variable|mode|policy|hint|label|placeholder|regex|pattern|min|max|required|reset|rules?|strength|valid|validator|input|prompt|manager|store|provider|ref|arn|version|format|style|class|icon|button|dialog|form)$/i;

/**
 * `key = value`, `key: value`, `"key": "value"`, `--key=value`, `KEY=value`.
 * The keyword must start a key segment: after a non-alphanumeric character, or
 * as a camelCase hump (`dbPassword`, `apiKey`). It may be followed by more key
 * segments (`SECRET_ACCESS_KEY`) but not glued letters (`tokens`, `passport`).
 */
const ASSIGNMENT_RE = new RegExp(
  // A hump needs a lowercase tail (`Field`), or `PASSPORT` would parse as
  // `PASS` plus single-letter humps.
  `(?:(?<![A-Za-z0-9])|(?<=[a-z0-9])(?=[A-Z]))(${KEYWORD}(?:[_.-][A-Za-z0-9]+|[A-Z][a-z0-9]+)*)` +
    `(["']?[ \\t]*(?:=>|:=|=|:)[ \\t]*)` +
    `(?:"([^"\\n]{1,4096})"|'([^'\\n]{1,4096})'|\`([^\`\\n]{1,4096})\`|([^\\s"'\`,;)}\\]&<>]{1,4096}))`,
  'g',
);

/** `--password hunter2` / `--api-key "abc"`: the space-separated flag form. */
const FLAG_RE =
  /(?<![\w-])(--(?:[a-z0-9]+-)*(?:password|passwd|passphrase|pass|secret|client-secret|token|api-key|apikey|access-key|auth-token|private-key))([ \t]+)(?:'([^'\n]{1,4096})'|"([^"\n]{1,4096})"|([^\s'"-][^\s'"]{0,4095}))/gi;

function isStrongKey(key: string): boolean {
  return /pass(?:word|wd|phrase)|sshpass/i.test(key);
}

function lastKeySegment(key: string): string {
  const parts = key.split(/[_.-]|(?<=[a-z0-9])(?=[A-Z][a-z0-9])/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

/**
 * Decide whether an assigned value is a secret. The point is to catch real
 * credentials without eating ordinary code: `password: string`,
 * `token = getToken()`, `secret: config.secret` and `max_token=4096` are
 * all left alone.
 */
function isSecretValue(key: string, value: string, quoted: boolean, envStyle: boolean): boolean {
  const v = value.trim();
  if (isPlaceholder(v)) return false;
  const suffix = lastKeySegment(key);
  if (suffix && NON_SECRET_SUFFIX.test(suffix)) return false;
  const strong = isStrongKey(key);
  if (v.length < (strong ? 4 : 8)) return false;
  if (!strong && /^\d+$/.test(v)) return false; // counts, limits, ports
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(v) || /^~?\.{0,2}\//.test(v)) return false; // URLs, paths
  if (!quoted) {
    // `password == x`, `token => …`, Rust/C++ paths (`Secret::new(`).
    if (/^[=>:]/.test(v)) return false;
    if (/^[A-Za-z_$][\w$.]*\(/.test(v)) return false; // a call: getToken(), z.string()
    if (/-$/.test(v)) return false; // cut at a C arrow: `session->token`
    // A plain identifier or member chain (`hashedPassword`, `config.secret`) is
    // code. An env-file line (`DB_PASSWORD=hunter`) is the exception.
    if (!envStyle && /^[A-Za-z_][A-Za-z_]*(?:\.[A-Za-z_][A-Za-z_]*)*$/.test(v)) return false;
  } else {
    if (v.split(/\s+/).length >= 3) return false; // prose in quotes: "Enter your password here"
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return false; // names a variable: "DB_PASS"
  }
  return true;
}

interface Rule {
  name: string;
  re: RegExp;
  /** Return the replacement, or null to leave the match alone. */
  replace: (match: string, groups: (string | undefined)[], report: (secret: string) => void) => string | null;
}

const whole = (match: string, _groups: (string | undefined)[], report: (secret: string) => void) => {
  report(match);
  return REDACTED;
};

const RULES: Rule[] = [
  {
    name: 'pem-private-key',
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----[\s\S]{0,20000}?-----END \1PRIVATE KEY\2-----/g,
    replace: whole,
  },
  {
    // A key cut off by a tool marker or a truncated paste: header plus base64 lines.
    name: 'pem-private-key',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:(?:\s|\\n)*[A-Za-z0-9+/=]{8,})*/g,
    replace: whole,
  },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: whole },
  { name: 'openai-key', re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, replace: whole },
  // Classic `sk-<48 alnum>`: no hyphens inside, or `sk-learn-…` would match.
  { name: 'openai-key', re: /\bsk-(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}\b/g, replace: whole },
  { name: 'stripe-key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: whole },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replace: whole },
  { name: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, replace: whole },
  { name: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replace: whole },
  { name: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{30,}\b/g, replace: whole },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: whole },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, replace: whole },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: whole },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: whole },
  {
    name: 'auth-header',
    re: /\b(authorization["']?[ \t]*[:=][ \t]*["']?(?:bearer|basic|token|bot|digest)[ \t]+)([A-Za-z0-9._~+/-]{8,}=*)/gi,
    replace: (_m, [prefix, secret], report) => {
      if (!secret || isPlaceholder(secret)) return null;
      report(secret);
      return `${prefix}${REDACTED}`;
    },
  },
  {
    // A bare `Bearer <token>` (curl -H, logs). A digit is required so that
    // prose like "Bearer authentication-flow-for-clients" is left alone.
    name: 'bearer-token',
    re: /\b(Bearer[ \t]+)((?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}=*)/g,
    replace: (_m, [prefix, secret], report) => {
      if (!secret) return null;
      report(secret);
      return `${prefix}${REDACTED}`;
    },
  },
  {
    name: 'url-credentials',
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:@/?#'"]{1,128}):([^\s@/?#'"]{1,256})@/gi,
    replace: (_m, [scheme, user, pass], report) => {
      // `http://localhost:80@169.254.169.254` is a host:port, not user:pass.
      if (!pass || isPlaceholder(pass) || /^\d{1,5}$/.test(pass)) return null;
      report(pass);
      return `${scheme}${user}:${REDACTED}@`;
    },
  },
  {
    name: 'sshpass',
    re: /\b(sshpass[ \t]+-p[ \t]*)('[^'\n]*'|"[^"\n]*"|[^\s'"]+)/g,
    replace: (_m, [prefix, secret], report) => {
      if (!secret || isPlaceholder(secret.replace(/^['"]|['"]$/g, ''))) return null;
      report(secret);
      return `${prefix}${REDACTED}`;
    },
  },
  {
    // mysql's `-p<password>` is glued to the flag. `-p` followed by a space
    // prompts, and the next word is the database name, so it is left alone.
    name: 'mysql-password',
    re: /\b((?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n|;&]*?[ \t]-p)('[^'\n]+'|"[^"\n]+"|[^\s'"]+)/g,
    replace: (_m, [prefix, secret], report) => {
      if (!secret || isPlaceholder(secret.replace(/^['"]|['"]$/g, ''))) return null;
      report(secret);
      return `${prefix}${REDACTED}`;
    },
  },
  {
    name: 'assignment',
    re: ASSIGNMENT_RE,
    replace: (match, [key, sep, dq, sq, bq, bare], report) => {
      const quotedValue = dq ?? sq ?? bq;
      const value = quotedValue ?? bare;
      if (!key || sep === undefined || value === undefined) return null;
      const envStyle = /^[A-Z0-9_]+$/.test(key) && /^=$/.test(sep);
      if (key === 'PASS' && !envStyle) return null;
      if (!isSecretValue(key, value, quotedValue !== undefined, envStyle)) return null;
      report(value);
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : bq !== undefined ? '`' : '';
      return `${key}${sep}${quote}${REDACTED}${quote}`;
    },
  },
  {
    name: 'cli-flag',
    re: FLAG_RE,
    replace: (_m, [flag, space, sq, dq, bare], report) => {
      const quotedValue = sq ?? dq;
      const value = quotedValue ?? bare;
      if (!flag || value === undefined) return null;
      if (!isSecretValue(flag.replace(/^-+/, ''), value, quotedValue !== undefined, false)) return null;
      report(value);
      const quote = sq !== undefined ? "'" : dq !== undefined ? '"' : '';
      return `${flag}${space}${quote}${REDACTED}${quote}`;
    },
  },
];

/**
 * Replace credentials in `text` with `[REDACTED]`. Chunks are stored on disk
 * and shown to agents, so this runs on everything that leaves this module.
 * The rules lean towards leaving ordinary code and prose alone. A missed
 * low-entropy password is a better failure than a history full of redacted
 * `token: string` annotations. `onHit` receives each original match, for
 * diagnostics only.
 */
export function redactSecrets(text: string, onHit?: (rule: string, match: string) => void): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    const report = (secret: string) => onHit?.(rule.name, secret);
    out = out.replace(rule.re, (match: string, ...args: unknown[]) => {
      // replace() passes (match, ...groups, offset, input[, namedGroups]).
      const offsetIndex = args.findIndex((arg) => typeof arg === 'number');
      const groups = args.slice(0, offsetIndex) as (string | undefined)[];
      return rule.replace(match, groups, report) ?? match;
    });
  }
  return out;
}

// ─── Workspace matching ──────────────────────────────────────────────────────

export interface BelongsToOptions {
  /** Defaults to process.platform; decides separators and case folding. */
  platform?: NodeJS.Platform;
  /** Defaults to fs.realpathSync.native. A throw means "use the path as given". */
  realpath?: (p: string) => string;
}

function defaultRealpath(p: string): string {
  return realpathSync.native(p);
}

/**
 * True when any `cwd` the session ran in is `folder` or lies inside it.
 * Matching is on a path boundary (`/a/b` does not match `/a/bc`), is
 * case-insensitive where the file system usually is (macOS, Windows), and
 * compares both the paths as recorded and their realpaths, so a workspace
 * opened through a symlink still finds sessions recorded under the target.
 */
export function transcriptBelongsTo(
  meta: Pick<SessionMeta, 'cwds'>,
  folder: string | null | undefined,
  opts: BelongsToOptions = {},
): boolean {
  if (!folder || !folder.trim()) return false;
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const foldCase = win || platform === 'darwin';
  const realpath = opts.realpath ?? defaultRealpath;

  const normalize = (raw: string): string => {
    let n = p.normalize(win ? raw.replace(/\//g, '\\') : raw);
    const root = p.parse(n).root;
    while (n.length > root.length && n.endsWith(p.sep)) n = n.slice(0, -1);
    // macOS file names can arrive decomposed (NFD); compare composed.
    n = n.normalize('NFC');
    return foldCase ? n.toLowerCase() : n;
  };
  const variants = (raw: string): string[] => {
    const out = [normalize(raw)];
    try {
      const real = normalize(realpath(raw));
      if (real !== out[0]) out.push(real);
    } catch {
      // Gone, or never existed on this machine: compare it as recorded.
    }
    return out;
  };
  const inside = (child: string, parent: string) =>
    child === parent || child.startsWith(parent.endsWith(p.sep) ? parent : parent + p.sep);

  const folders = variants(folder.trim());
  for (const cwd of meta.cwds) {
    if (!cwd) continue;
    for (const candidate of variants(cwd)) {
      if (folders.some((f) => inside(candidate, f))) return true;
    }
  }
  return false;
}
