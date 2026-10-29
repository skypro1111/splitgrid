import { afterEach, describe, expect, it } from 'vitest';
import { dropCommandBuffer, feedTerminalInput, noteTerminalOutput, setCommandListener } from './commandCapture';

const SID = 'session-1';

function capture(): string[] {
  const got: string[] = [];
  setCommandListener((_sid, cmd) => got.push(cmd));
  return got;
}

afterEach(() => {
  setCommandListener(null);
  dropCommandBuffer(SID);
});

describe('commandCapture', () => {
  it('records a plainly typed command on Enter', () => {
    const got = capture();
    feedTerminalInput(SID, 'ls -la\r');
    expect(got).toEqual(['ls -la']);
  });

  it('never records the line typed at a password prompt', () => {
    const got = capture();
    noteTerminalOutput(SID, '[sudo] password for sk: ');
    feedTerminalInput(SID, 'hunter2\r');
    expect(got).toEqual([]);
  });

  it('stays armed when output (e.g. a tmux status redraw) lands mid-entry', () => {
    const got = capture();
    noteTerminalOutput(SID, '[sudo] password for sk: ');
    feedTerminalInput(SID, 'hun');
    noteTerminalOutput(SID, '\x1b7\x1b[24;1H[0] 0:zsh*  12:05\x1b8');
    feedTerminalInput(SID, 'ter2\r');
    expect(got).toEqual([]);
  });

  it('disarms after the secret line is submitted', () => {
    const got = capture();
    noteTerminalOutput(SID, 'Password: ');
    feedTerminalInput(SID, 'hunter2\r');
    noteTerminalOutput(SID, '\r\n$ ');
    feedTerminalInput(SID, 'git status\r');
    expect(got).toEqual(['git status']);
  });
});
