import { describe, expect, it } from 'vitest';
import { transcriptEventsFromJsonl } from './session-transcript';

const SESSION = 'pane-1';

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

describe('transcriptEventsFromJsonl', () => {
  it('rebuilds a conversation as pane events', () => {
    const events = transcriptEventsFromJsonl(
      SESSION,
      jsonl(
        { type: 'mode', mode: 'normal' },
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'fix the build' } },
        {
          type: 'assistant',
          uuid: 'a1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
        },
      ),
    );
    expect(events).toEqual([
      { type: 'user.message', sessionId: SESSION, itemId: 'h:u1', text: 'fix the build' },
      { type: 'text.delta', sessionId: SESSION, itemId: 'h:a1:0', kind: 'assistant', text: 'On it.' },
      { type: 'text.end', sessionId: SESSION, itemId: 'h:a1:0' },
    ]);
  });

  it('pairs a stored tool call with its result', () => {
    const events = transcriptEventsFromJsonl(
      SESSION,
      jsonl(
        {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }],
          },
        },
        {
          type: 'user',
          uuid: 'u2',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a\nb', is_error: false }],
          },
        },
      ),
    );
    expect(events[0]).toMatchObject({ type: 'tool.start', toolUseId: 'tu_1', summary: 'ls' });
    expect(events[1]).toMatchObject({ type: 'tool.end', toolUseId: 'tu_1', output: 'a\nb' });
    // Both sides share the item id the live stream uses, so the card renders
    // as one collapsed row rather than two orphans.
    expect(events[0].type === 'tool.start' && events[0].itemId).toBe('tool:tu_1');
    expect(events[1].type === 'tool.end' && events[1].itemId).toBe('tool:tu_1');
  });

  it('keeps thinking blocks as thinking', () => {
    const events = transcriptEventsFromJsonl(
      SESSION,
      jsonl({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
      }),
    );
    expect(events[0]).toMatchObject({ kind: 'thinking', text: 'hmm' });
  });

  it('drops machinery: meta entries, sidechains and non-message lines', () => {
    const events = transcriptEventsFromJsonl(
      SESSION,
      jsonl(
        { type: 'user', uuid: 'm1', isMeta: true, message: { content: 'caveat noise' } },
        { type: 'assistant', uuid: 's1', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } },
        { type: 'attachment', uuid: 'x1' },
        { type: 'file-history-snapshot' },
      ),
    );
    expect(events).toEqual([]);
  });

  it('survives a half-written trailing line', () => {
    const raw = `${jsonl({ type: 'user', uuid: 'u1', message: { content: 'hi' } })}\n{"type":"assis`;
    expect(transcriptEventsFromJsonl(SESSION, raw)).toHaveLength(1);
  });

  it('ignores empty prompts', () => {
    const events = transcriptEventsFromJsonl(
      SESSION,
      jsonl({ type: 'user', uuid: 'u1', message: { content: '   ' } }),
    );
    expect(events).toEqual([]);
  });
});
