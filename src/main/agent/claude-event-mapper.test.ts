import { describe, expect, it } from 'vitest';
import {
  createMapperState,
  flattenToolResult,
  mapSdkMessage,
  summarizeTool,
} from './claude-event-mapper';

const SESSION = 'pane-1';

function streamStart(uuid: string) {
  return { type: 'stream_event', uuid, event: { type: 'message_start' } };
}

function blockStart(uuid: string, index: number, blockType: 'text' | 'thinking') {
  return {
    type: 'stream_event',
    uuid,
    event: { type: 'content_block_start', index, content_block: { type: blockType } },
  };
}

function blockDelta(uuid: string, index: number, text: string, thinking = false) {
  return {
    type: 'stream_event',
    uuid,
    event: {
      type: 'content_block_delta',
      index,
      delta: thinking ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text },
    },
  };
}

describe('mapSdkMessage', () => {
  it('streams assistant text as deltas and closes the block', () => {
    const state = createMapperState('turn-1');
    expect(mapSdkMessage(SESSION, streamStart('m1'), state)).toEqual([]);
    expect(mapSdkMessage(SESSION, blockStart('m1', 0, 'text'), state)).toEqual([]);

    const deltas = mapSdkMessage(SESSION, blockDelta('m1', 0, 'Hello'), state);
    expect(deltas).toEqual([
      { type: 'text.delta', sessionId: SESSION, itemId: 'turn-1:m1:0', kind: 'assistant', text: 'Hello' },
    ]);

    const end = mapSdkMessage(
      SESSION,
      { type: 'stream_event', uuid: 'm1', event: { type: 'content_block_stop', index: 0 } },
      state,
    );
    expect(end).toEqual([{ type: 'text.end', sessionId: SESSION, itemId: 'turn-1:m1:0' }]);
  });

  it('maps thinking deltas to the thinking kind', () => {
    const state = createMapperState('turn-1');
    mapSdkMessage(SESSION, streamStart('m1'), state);
    mapSdkMessage(SESSION, blockStart('m1', 0, 'thinking'), state);
    expect(mapSdkMessage(SESSION, blockDelta('m1', 0, 'hmm', true), state)).toEqual([
      { type: 'text.delta', sessionId: SESSION, itemId: 'turn-1:m1:0', kind: 'thinking', text: 'hmm' },
    ]);
  });

  it('does not re-emit text that already streamed', () => {
    const state = createMapperState('turn-1');
    // Stream frames carry their own uuids — deliberately different from the
    // assistant message's, which is what the duplicate-text bug hinged on.
    mapSdkMessage(SESSION, streamStart('frame-1'), state);
    mapSdkMessage(SESSION, blockStart('frame-2', 0, 'text'), state);
    mapSdkMessage(SESSION, blockDelta('frame-3', 0, 'Hello'), state);

    const events = mapSdkMessage(
      SESSION,
      { type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: 'Hello' }] } },
      state,
    );
    expect(events).toEqual([]);
  });

  it('starts a clean slate for the next assistant message', () => {
    const state = createMapperState('turn-1');
    mapSdkMessage(SESSION, streamStart('f1'), state);
    mapSdkMessage(SESSION, blockStart('f2', 0, 'text'), state);
    mapSdkMessage(SESSION, blockDelta('f3', 0, 'first'), state);
    mapSdkMessage(
      SESSION,
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'first' }] } },
      state,
    );

    // A second, unstreamed message must still be shown.
    const events = mapSdkMessage(
      SESSION,
      { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'second' }] } },
      state,
    );
    expect(events).toHaveLength(2);
  });

  it('still ends the turn for a local command, which runs no model turn', () => {
    const state = createMapperState('turn-1');
    const [event] = mapSdkMessage(
      SESSION,
      { type: 'result', subtype: 'success', is_error: false, num_turns: 0 },
      state,
    );
    // A /context or /model reply carries num_turns 0; treating that as "not a
    // turn" would leave the pane stuck on "Working" forever.
    expect(event).toMatchObject({ type: 'turn.end', status: 'completed' });
  });

  it('emits whole text blocks that never streamed', () => {
    const state = createMapperState('turn-1');
    const events = mapSdkMessage(
      SESSION,
      { type: 'assistant', uuid: 'm2', message: { content: [{ type: 'text', text: 'Done' }] } },
      state,
    );
    expect(events).toEqual([
      { type: 'text.delta', sessionId: SESSION, itemId: 'turn-1:m2:0', kind: 'assistant', text: 'Done' },
      { type: 'text.end', sessionId: SESSION, itemId: 'turn-1:m2:0' },
    ]);
  });

  it('pairs tool_use with its tool_result', () => {
    const state = createMapperState('turn-1');
    const start = mapSdkMessage(
      SESSION,
      {
        type: 'assistant',
        uuid: 'm3',
        message: {
          content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      state,
    );
    expect(start).toEqual([
      {
        type: 'tool.start',
        sessionId: SESSION,
        itemId: 'tool:tu_1',
        toolUseId: 'tu_1',
        name: 'Bash',
        summary: 'npm test',
        input: { command: 'npm test' },
      },
    ]);

    const end = mapSdkMessage(
      SESSION,
      {
        type: 'user',
        uuid: 'm4',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: false },
          ],
        },
      },
      state,
    );
    expect(end).toEqual([
      {
        type: 'tool.end',
        sessionId: SESSION,
        itemId: 'tool:tu_1',
        toolUseId: 'tu_1',
        isError: false,
        output: 'ok',
      },
    ]);
  });

  it('emits a tool_use only once even if the assistant message is replayed', () => {
    const state = createMapperState('turn-1');
    const message = {
      type: 'assistant',
      uuid: 'm3',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] },
    };
    expect(mapSdkMessage(SESSION, message, state)).toHaveLength(1);
    expect(mapSdkMessage(SESSION, message, state)).toHaveLength(0);
  });

  it('drops subagent output (it belongs to the Task tool card)', () => {
    const state = createMapperState('turn-1');
    const events = mapSdkMessage(
      SESSION,
      {
        type: 'assistant',
        uuid: 'm5',
        parent_tool_use_id: 'tu_1',
        message: { content: [{ type: 'text', text: 'inner' }] },
      },
      state,
    );
    expect(events).toEqual([]);
  });

  it('ends the turn on a success result with usage', () => {
    const state = createMapperState('turn-7');
    const events = mapSdkMessage(
      SESSION,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        num_turns: 1,
        duration_ms: 1200,
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 20 },
      },
      state,
    );
    expect(events).toEqual([
      {
        type: 'turn.end',
        sessionId: SESSION,
        turnId: 'turn-7',
        status: 'completed',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: undefined,
          cacheCreationTokens: undefined,
          costUsd: 0.02,
          durationMs: 1200,
        },
      },
    ]);
  });

  it('reports an interrupted turn as interrupted, not an error', () => {
    const state = createMapperState('turn-8');
    const [event] = mapSdkMessage(
      SESSION,
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['Request was aborted by the user'],
      },
      state,
    );
    expect(event).toMatchObject({ type: 'turn.end', status: 'interrupted' });
  });

  it('reports a failed turn with its error text', () => {
    const state = createMapperState('turn-9');
    const [event] = mapSdkMessage(
      SESSION,
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] },
      state,
    );
    expect(event).toMatchObject({ type: 'turn.end', status: 'error', message: 'boom' });
  });

  it('surfaces local slash-command output, which has no other home', () => {
    const state = createMapperState('turn-1');
    const events = mapSdkMessage(
      SESSION,
      { type: 'system', subtype: 'local_command_output', uuid: 'u1', content: '## Context' },
      state,
    );
    expect(events).toEqual([
      { type: 'text.delta', sessionId: SESSION, itemId: 'local:u1', kind: 'assistant', text: '## Context' },
      { type: 'text.end', sessionId: SESSION, itemId: 'local:u1' },
    ]);
  });

  it('reports what the CLI is busy with inside a turn', () => {
    const state = createMapperState('turn-1');
    expect(
      mapSdkMessage(SESSION, { type: 'system', subtype: 'status', status: 'compacting' }, state),
    ).toEqual([{ type: 'session.activity', sessionId: SESSION, activity: 'compacting' }]);
    // A null status ends the activity rather than leaving a stale caption.
    expect(
      mapSdkMessage(SESSION, { type: 'system', subtype: 'status', status: null }, state),
    ).toEqual([{ type: 'session.activity', sessionId: SESSION, activity: null }]);
  });

  it('surfaces a failed compaction as an error, not silence', () => {
    const state = createMapperState('turn-1');
    const events = mapSdkMessage(
      SESSION,
      {
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'failed',
        compact_error: 'context too small',
      },
      state,
    );
    expect(events[1]).toMatchObject({ type: 'session.error', message: 'context too small' });
  });

  it('records a compaction boundary with how much it shrank', () => {
    const state = createMapperState('turn-1');
    const [event] = mapSdkMessage(
      SESSION,
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'c1',
        compact_metadata: { trigger: 'manual', pre_tokens: 120000, post_tokens: 25000, duration_ms: 8200 },
      },
      state,
    );
    expect(event).toEqual({
      type: 'context.compacted',
      sessionId: SESSION,
      itemId: 'compact:c1',
      trigger: 'manual',
      preTokens: 120000,
      postTokens: 25000,
      durationMs: 8200,
    });
  });

  it('reports the running output-token count while a message streams', () => {
    const state = createMapperState('turn-1');
    expect(
      mapSdkMessage(
        SESSION,
        { type: 'stream_event', uuid: 'f1', event: { type: 'message_delta', usage: { output_tokens: 1420 } } },
        state,
      ),
    ).toEqual([{ type: 'turn.progress', sessionId: SESSION, outputTokens: 1420 }]);
  });

  it('reports the CLI thinking-token estimate', () => {
    const state = createMapperState('turn-1');
    expect(
      mapSdkMessage(
        SESSION,
        { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 780 },
        state,
      ),
    ).toEqual([{ type: 'turn.progress', sessionId: SESSION, thinkingTokens: 780 }]);
  });

  it('reports how long the running tool has been going', () => {
    const state = createMapperState('turn-1');
    expect(
      mapSdkMessage(
        SESSION,
        { type: 'tool_progress', tool_name: 'Bash', elapsed_time_seconds: 12.4 },
        state,
      ),
    ).toEqual([
      { type: 'turn.progress', sessionId: SESSION, tool: { name: 'Bash', elapsedSeconds: 12.4 } },
    ]);
  });

  it('keeps a subagent heartbeat off the main status line', () => {
    const state = createMapperState('turn-1');
    expect(
      mapSdkMessage(
        SESSION,
        { type: 'tool_progress', tool_name: 'Bash', elapsed_time_seconds: 3, parent_tool_use_id: 'tu_1' },
        state,
      ),
    ).toEqual([]);
  });

  it('ignores unknown message types', () => {
    const state = createMapperState('turn-1');
    expect(mapSdkMessage(SESSION, { type: 'rate_limit_event' }, state)).toEqual([]);
    expect(mapSdkMessage(SESSION, undefined, state)).toEqual([]);
  });
});

describe('summarizeTool', () => {
  it('uses the most identifying field per tool', () => {
    expect(summarizeTool('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(summarizeTool('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(summarizeTool('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src');
    expect(summarizeTool('TodoWrite', {})).toBe('update todo list');
  });

  it('collapses whitespace and truncates long summaries', () => {
    const summary = summarizeTool('Bash', { command: `echo ${'x'.repeat(300)}` });
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary.endsWith('…')).toBe(true);
    expect(summarizeTool('Bash', { command: 'a\n  b' })).toBe('a b');
  });

  it('falls back to the tool name when the input says nothing', () => {
    expect(summarizeTool('Weird', {})).toBe('Weird');
  });
});

describe('flattenToolResult', () => {
  it('handles strings and content blocks', () => {
    expect(flattenToolResult('plain')).toBe('plain');
    expect(flattenToolResult([{ type: 'text', text: 'a' }, { type: 'image' }])).toBe('a\n[image]');
    expect(flattenToolResult(undefined)).toBe('');
  });
});
