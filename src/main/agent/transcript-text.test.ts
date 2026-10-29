import { describe, expect, it } from 'vitest';
import { interpretStoredUserText } from './transcript-text';

describe('interpretStoredUserText', () => {
  it('unwraps a slash command to the command line the terminal shows', () => {
    const stored = [
      '<command-name>/context</command-name>',
      '            <command-message>context</command-message>',
      '            <command-args></command-args>',
    ].join('\n');
    expect(interpretStoredUserText(stored)).toEqual({ kind: 'command', text: '/context' });
  });

  it('keeps command arguments', () => {
    const stored =
      '<command-name>/model</command-name><command-args>opus[1m]</command-args>';
    expect(interpretStoredUserText(stored)).toEqual({ kind: 'command', text: '/model opus[1m]' });
  });

  it('treats local command output as output, not as something the user said', () => {
    const stored = '<local-command-stdout>Current model: Opus 5</local-command-stdout>';
    expect(interpretStoredUserText(stored)).toEqual({
      kind: 'output',
      text: 'Current model: Opus 5',
    });
  });

  it('reduces a task notification to its summary', () => {
    const stored = [
      '<task-notification>',
      '<task-id>a1f2</task-id>',
      '<tool-use-id>toolu_01</tool-use-id>',
      '<summary>Background review finished</summary>',
      '</task-notification>',
    ].join('\n');
    expect(interpretStoredUserText(stored)).toEqual({
      kind: 'output',
      text: 'Background review finished',
    });
  });

  it('strips injected reminders but keeps the prompt around them', () => {
    const stored = 'fix the build\n<system-reminder>be careful</system-reminder>';
    expect(interpretStoredUserText(stored)).toEqual({ kind: 'text', text: 'fix the build' });
  });

  it('hides a message that was nothing but machinery', () => {
    expect(
      interpretStoredUserText('<system-reminder>context injected</system-reminder>'),
    ).toEqual({ kind: 'hidden' });
    expect(
      interpretStoredUserText('<local-command-caveat>Caveat: …</local-command-caveat>'),
    ).toEqual({ kind: 'hidden' });
    expect(interpretStoredUserText('   ')).toEqual({ kind: 'hidden' });
  });

  it('hides an unknown envelope rather than showing raw tags', () => {
    expect(interpretStoredUserText('<some-future-wrapper>x</some-future-wrapper>')).toEqual({
      kind: 'hidden',
    });
  });

  it('passes ordinary prose through untouched', () => {
    expect(interpretStoredUserText('why is the build red?')).toEqual({
      kind: 'text',
      text: 'why is the build red?',
    });
  });
});
