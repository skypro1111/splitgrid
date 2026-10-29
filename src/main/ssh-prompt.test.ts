import { describe, it, expect } from 'vitest';
import { endsWithPasswordPrompt, stripAnsi } from './ssh-prompt';

// These lock in the conservative detection behaviour: it must fire on real
// password/sudo prompts (incl. ANSI-wrapped + localized) and stay quiet on
// everything that merely mentions "password".

describe('endsWithPasswordPrompt — should detect', () => {
  const prompts = [
    '[sudo] password for rpuzak: ',
    '[sudo] password for rpuzak:',
    'Password:',
    'password: ',
    "rpuzak@host's password: ",
    '[sudo] пароль для rpuzak: ',          // localized sudo (uk/ru)
    'passwd: ',
    '\x1b[0m\x1b[1m[sudo] password for user:\x1b[0m', // ANSI-wrapped
    'Building stuff...\nLots of output\n[sudo] password for ci:', // tail of a longer buffer
  ];
  for (const p of prompts) {
    it(JSON.stringify(p.slice(-32)), () => {
      expect(endsWithPasswordPrompt(p)).toBe(true);
    });
  }
});

describe('endsWithPasswordPrompt — should NOT detect', () => {
  const nonPrompts = [
    'The password is wrong:',
    'password expires:',
    'Enter your new password below',
    'password saved to vault',
    '$ sudo apt update',
    'Now type your password:\nfoo',         // prompt not at end-of-buffer
    'Last login: ... password expires in 3 days',
    '',
  ];
  for (const s of nonPrompts) {
    it(JSON.stringify(s.slice(-32)), () => {
      expect(endsWithPasswordPrompt(s)).toBe(false);
    });
  }
});

describe('endsWithPasswordPrompt — large buffers', () => {
  // Runs per chunk on the full ~100 KB session buffer, so only the tail is
  // inspected; a prompt at the end must still be found, one far back must not.
  const filler = '\x1b[32mbuild output line\x1b[0m\n'.repeat(4000);
  it('detects an ANSI-wrapped prompt at the end of a ~100 KB buffer', () => {
    expect(endsWithPasswordPrompt(filler + '\x1b[1m[sudo] password for ci:\x1b[0m ')).toBe(true);
  });
  it('ignores a prompt buried before the tail', () => {
    expect(endsWithPasswordPrompt('[sudo] password for ci: ' + filler)).toBe(false);
  });
});

describe('stripAnsi', () => {
  it('removes CSI colour codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
  it('removes OSC sequences (e.g. window title)', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
  });
  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});
