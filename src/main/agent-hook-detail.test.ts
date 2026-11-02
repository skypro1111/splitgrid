import { describe, it, expect } from 'vitest';
import { DETAIL_MAX, doneDetail, oneLine, parseHookPayload, toolSummary, waitingDetail } from './agent-hook-detail';

describe('oneLine', () => {
  it('drops markdown and line breaks', () => {
    expect(oneLine('## Done\n\n- Fixed **two** bugs in `app.ts`\n- See [the PR](https://x.y/1)\n\n```ts\nconst a = 1;\n```\nAll green.'))
      .toBe('Done Fixed two bugs in app.ts See the PR All green.');
    expect(oneLine('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a b 1 2');
  });

  it('clips long text at a word, with an ellipsis, so a banner stays a banner', () => {
    const long = 'word '.repeat(200);
    const out = oneLine(long);
    expect(out.length).toBeLessThanOrEqual(DETAIL_MAX);
    expect(out.endsWith('word…')).toBe(true);
  });
});

describe('hook details', () => {
  it('takes the final reply on Stop', () => {
    expect(doneDetail(parseHookPayload({ hook_event_name: 'Stop', last_assistant_message: 'Shipped **1.3.1**.\nAll tests pass.' })))
      .toBe('Shipped 1.3.1. All tests pass.');
    expect(doneDetail(parseHookPayload({ hook_event_name: 'Stop' }))).toBeUndefined();
    expect(doneDetail(null)).toBeUndefined();
  });

  it('shows the question an agent asks, with its choices', () => {
    const ask = parseHookPayload({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [
        { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] },
        { question: 'Second?', header: 'x', options: [] },
      ] },
    });
    expect(waitingDetail(ask)).toBe('Which database? Postgres / SQLite (+1 more)');
  });

  it('names the tool call a permission prompt is about', () => {
    const notification = parseHookPayload({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    expect(waitingDetail(notification, { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } })).toBe('Allow Bash: rm -rf dist?');
    // Codex's PermissionRequest names it itself.
    expect(waitingDetail(parseHookPayload({ hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: '/a/b/app.ts' } })))
      .toBe('Allow Edit: app.ts?');
    // Nothing better known: the agent's own message.
    expect(waitingDetail(notification)).toBe('Claude needs your permission to use Bash');
  });

  it('summarises tools by what they act on', () => {
    expect(toolSummary('WebFetch', { url: 'https://example.com' })).toBe('WebFetch: https://example.com');
    expect(toolSummary('mcp__github__create_issue', {})).toBe('github: create_issue');
    expect(toolSummary(undefined, {})).toBe('');
  });

  it('ignores payloads that are not objects', () => {
    expect(parseHookPayload('x')).toBeNull();
    expect(parseHookPayload([1])).toBeNull();
    expect(parseHookPayload({ tool_input: 'nope', message: 3 })).toEqual(expect.objectContaining({ tool_input: undefined, message: undefined }));
  });
});
