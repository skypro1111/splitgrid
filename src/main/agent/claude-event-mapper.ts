import type { AgentEvent, AgentTurnUsage } from '../../shared/agent-types';

// Pure translation of Claude Agent SDK messages into the pane's `AgentEvent`s.
//
// Kept free of SDK imports on purpose: the shapes below are structural, so this
// module is testable without spawning anything and survives SDK type churn —
// unknown message types are simply ignored rather than crashing a session.
//
// With `includePartialMessages: true` the CLI sends, per assistant message:
//   stream_event(message_start)
//   stream_event(content_block_start | content_block_delta | content_block_stop)*
//   assistant                        <- the same content, complete
// so text/thinking is streamed from the stream_events and the final `assistant`
// message only contributes what was NOT streamed (tool_use blocks, plus text
// blocks as a fallback if partial streaming was off or a delta was missed).

interface RawBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawMessage {
  type?: string;
  subtype?: string;
  content?: unknown;
  status?: string | null;
  compact_result?: string;
  compact_error?: string;
  compact_metadata?: {
    trigger?: string;
    pre_tokens?: number;
    post_tokens?: number;
    duration_ms?: number;
  };
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: RawBlock[] | string; role?: string };
  event?: {
    type?: string;
    index?: number;
    content_block?: RawBlock;
    delta?: { type?: string; text?: string; thinking?: string };
    usage?: { output_tokens?: number };
  };
  // thinking_tokens
  estimated_tokens?: number;
  // tool_progress
  tool_name?: string;
  elapsed_time_seconds?: number;
  // result
  is_error?: boolean;
  num_turns?: number;
  result?: string;
  errors?: string[];
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

type BlockKind = 'assistant' | 'thinking';

/** Per-session bookkeeping the mapper needs between messages. */
export interface MapperState {
  /** Id of the turn currently in flight (set by the session on send). */
  turnId: string;
  /** Streaming text/thinking blocks of the assistant message being received. */
  blocks: Map<number, { itemId: string; kind: BlockKind }>;
  /** uuid of the assistant message currently streaming (for stable item ids). */
  streamingMessageId: string;
  /** tool_use ids whose `tool.start` has already been emitted. */
  startedTools: Set<string>;
}

export function createMapperState(turnId = ''): MapperState {
  return { turnId, blocks: new Map(), streamingMessageId: '', startedTools: new Set() };
}

const MAX_SUMMARY = 120;
const MAX_TOOL_OUTPUT = 20_000;

function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SUMMARY ? `${collapsed.slice(0, MAX_SUMMARY - 1)}…` : collapsed;
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A one-line description of a tool call, used in the transcript header and in
 * approval prompts ("Bash: npm test", "Edit: src/main.ts").
 */
export function summarizeTool(name: string, input: unknown): string {
  const pick = (key: string) => stringField(input, key);
  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return oneLine(pick('command') ?? pick('description') ?? name);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return oneLine(pick('file_path') ?? pick('notebook_path') ?? name);
    case 'Glob':
    case 'Grep':
      return oneLine(`${pick('pattern') ?? ''}${pick('path') ? ` in ${pick('path')}` : ''}` || name);
    case 'WebFetch':
      return oneLine(pick('url') ?? name);
    case 'WebSearch':
      return oneLine(pick('query') ?? name);
    case 'Task':
    case 'Agent':
      return oneLine(pick('description') ?? pick('subagent_type') ?? name);
    case 'TodoWrite':
      return 'update todo list';
    default: {
      const guess = pick('command') ?? pick('file_path') ?? pick('path') ?? pick('url') ?? pick('query');
      if (guess) return oneLine(guess);
      try {
        const json = JSON.stringify(input ?? {});
        return json === '{}' ? name : oneLine(json);
      } catch {
        return name;
      }
    }
  }
}

/** Flatten a tool_result `content` field (string | blocks) into display text. */
export function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, MAX_TOOL_OUTPUT);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as RawBlock[]) {
    if (typeof block === 'string') parts.push(block);
    else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'image') parts.push('[image]');
  }
  return parts.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function usageFrom(message: RawMessage): AgentTurnUsage {
  const usage = message.usage ?? {};
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    costUsd: message.total_cost_usd,
    durationMs: message.duration_ms,
  };
}

function textItemId(state: MapperState, messageUuid: string, index: number): string {
  return `${state.turnId || 'turn'}:${messageUuid || 'msg'}:${index}`;
}

function handleStreamEvent(sessionId: string, message: RawMessage, state: MapperState): AgentEvent[] {
  const event = message.event ?? {};
  const index = typeof event.index === 'number' ? event.index : -1;

  if (event.type === 'message_start') {
    state.blocks.clear();
    state.streamingMessageId = message.uuid ?? '';
    return [];
  }

  if (event.type === 'content_block_start') {
    const blockType = event.content_block?.type;
    const kind: BlockKind | null =
      blockType === 'text' ? 'assistant' : blockType === 'thinking' ? 'thinking' : null;
    if (!kind || index < 0) return [];
    const itemId = textItemId(state, state.streamingMessageId || (message.uuid ?? ''), index);
    state.blocks.set(index, { itemId, kind });
    // A block can open with text already in it (rare, but the API allows it).
    const seed = kind === 'assistant' ? event.content_block?.text : event.content_block?.thinking;
    return seed ? [{ type: 'text.delta', sessionId, itemId, kind, text: seed }] : [];
  }

  if (event.type === 'content_block_delta') {
    const block = state.blocks.get(index);
    if (!block) return [];
    const delta = event.delta ?? {};
    const text = delta.type === 'thinking_delta' ? delta.thinking : delta.text;
    if (typeof text !== 'string' || text.length === 0) return [];
    return [{ type: 'text.delta', sessionId, itemId: block.itemId, kind: block.kind, text }];
  }

  // The API reports cumulative usage on message_delta — the only live token
  // counter available while a message streams.
  if (event.type === 'message_delta') {
    const outputTokens = event.usage?.output_tokens;
    if (typeof outputTokens !== 'number') return [];
    return [{ type: 'turn.progress', sessionId, outputTokens }];
  }

  if (event.type === 'content_block_stop') {
    const block = state.blocks.get(index);
    if (!block) return [];
    return [{ type: 'text.end', sessionId, itemId: block.itemId }];
  }

  return [];
}

function handleAssistant(sessionId: string, message: RawMessage, state: MapperState): AgentEvent[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  const events: AgentEvent[] = [];
  const messageUuid = message.uuid ?? '';

  content.forEach((block, index) => {
    if (block?.type === 'tool_use') {
      const toolUseId = block.id ?? `${messageUuid}:${index}`;
      if (state.startedTools.has(toolUseId)) return;
      state.startedTools.add(toolUseId);
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
      return;
    }

    // Fallback for text/thinking that never streamed (partial messages off, or
    // a stream gap): emit the whole block at once. Blocks already streamed are
    // matched by index against the stream bookkeeping and skipped.
    const kind: BlockKind | null =
      block?.type === 'text' ? 'assistant' : block?.type === 'thinking' ? 'thinking' : null;
    if (!kind) return;
    // `blocks` holds exactly the indices streamed for THIS assistant message
    // (cleared at each message_start), so it is the reliable "already shown"
    // signal. Comparing uuids is not: a stream_event's uuid identifies the
    // frame, not the assistant message it belongs to.
    if (state.blocks.has(index)) return;
    const text = kind === 'assistant' ? block.text : block.thinking;
    if (typeof text !== 'string' || text.length === 0) return;
    const itemId = textItemId(state, messageUuid, index);
    events.push({ type: 'text.delta', sessionId, itemId, kind, text });
    events.push({ type: 'text.end', sessionId, itemId });
  });

  // The message is complete; the next one opens its own set of blocks.
  state.blocks.clear();
  state.streamingMessageId = '';
  return events;
}

function handleUser(sessionId: string, message: RawMessage, state: MapperState): AgentEvent[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    const toolUseId = block.tool_use_id ?? '';
    if (!toolUseId) continue;
    state.startedTools.delete(toolUseId);
    events.push({
      type: 'tool.end',
      sessionId,
      itemId: `tool:${toolUseId}`,
      toolUseId,
      isError: block.is_error === true,
      output: flattenToolResult(block.content),
    });
  }
  return events;
}

function handleResult(sessionId: string, message: RawMessage, state: MapperState): AgentEvent[] {
  const interrupted =
    Array.isArray(message.errors) &&
    message.errors.some((error) => /interrupt|abort|cancel/i.test(String(error)));
  const status = interrupted
    ? 'interrupted'
    : message.subtype === 'success' && message.is_error !== true
      ? 'completed'
      : 'error';
  const errorText =
    status === 'error'
      ? (Array.isArray(message.errors) && message.errors.length > 0
          ? message.errors.join('\n')
          : message.result) || 'Claude ended the turn with an error.'
      : undefined;

  return [
    {
      type: 'turn.end',
      sessionId,
      turnId: state.turnId,
      status,
      ...(errorText ? { message: errorText } : {}),
      usage: usageFrom(message),
    },
  ];
}

/**
 * Translate one SDK message into zero or more pane events, updating `state`.
 * Unknown message types map to no events.
 */
export function mapSdkMessage(
  sessionId: string,
  message: unknown,
  state: MapperState,
): AgentEvent[] {
  const raw = (message ?? {}) as RawMessage;
  // Subagent (Task) output arrives with parent_tool_use_id set; it belongs to
  // the tool card, not the main transcript, so it is dropped for now.
  if (raw.parent_tool_use_id) return [];

  // Some slash commands answer locally (no model turn). Their output arrives on
  // this channel and has no other home in the transcript.
  if (raw.type === 'system' && raw.subtype === 'local_command_output') {
    const text = typeof raw.content === 'string' ? raw.content : '';
    if (!text) return [];
    const itemId = `local:${raw.uuid ?? state.turnId}`;
    return [
      { type: 'text.delta', sessionId, itemId, kind: 'assistant', text },
      { type: 'text.end', sessionId, itemId },
    ];
  }

  // Extended thinking reports its own running estimate.
  if (raw.type === 'system' && raw.subtype === 'thinking_tokens') {
    const thinkingTokens = raw.estimated_tokens;
    return typeof thinkingTokens === 'number'
      ? [{ type: 'turn.progress', sessionId, thinkingTokens }]
      : [];
  }

  // A long-running tool heartbeats with its elapsed time.
  if (raw.type === 'tool_progress') {
    // Subagent heartbeats carry parent_tool_use_id and were already dropped
    // above, so anything here is the main thread's own work.
    return [
      {
        type: 'turn.progress',
        sessionId,
        tool: {
          name: raw.tool_name ?? 'tool',
          elapsedSeconds: raw.elapsed_time_seconds ?? 0,
        },
      },
    ];
  }

  // The CLI's in-turn progress. The terminal renders this as its spinner
  // caption; a pane that ignores it looks frozen through a long compaction.
  if (raw.type === 'system' && raw.subtype === 'status') {
    const events: AgentEvent[] = [
      {
        type: 'session.activity',
        sessionId,
        activity:
          raw.status === 'compacting' || raw.status === 'requesting' ? raw.status : null,
      },
    ];
    if (raw.compact_result === 'failed') {
      events.push({
        type: 'session.error',
        sessionId,
        message: raw.compact_error || 'Compacting the conversation failed.',
      });
    }
    return events;
  }

  if (raw.type === 'system' && raw.subtype === 'compact_boundary') {
    const meta = raw.compact_metadata ?? {};
    return [
      {
        type: 'context.compacted',
        sessionId,
        itemId: `compact:${raw.uuid ?? state.turnId}`,
        trigger: meta.trigger === 'auto' ? 'auto' : 'manual',
        preTokens: meta.pre_tokens ?? 0,
        ...(typeof meta.post_tokens === 'number' ? { postTokens: meta.post_tokens } : {}),
        ...(typeof meta.duration_ms === 'number' ? { durationMs: meta.duration_ms } : {}),
      },
    ];
  }

  switch (raw.type) {
    case 'stream_event':
      return handleStreamEvent(sessionId, raw, state);
    case 'assistant':
      return handleAssistant(sessionId, raw, state);
    case 'user':
      return handleUser(sessionId, raw, state);
    case 'result':
      // NOT filtered on num_turns === 0: a local slash command (/context,
      // /model) legitimately answers without a model turn, and dropping its
      // result would leave the pane stuck on "Working". The resume handshake is
      // discriminated in the session instead, by whether a turn is in flight.
      return handleResult(sessionId, raw, state);
    default:
      return [];
  }
}
