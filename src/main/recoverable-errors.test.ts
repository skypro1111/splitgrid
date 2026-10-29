import { describe, it, expect } from 'vitest';
import { isRecoverableSshError } from './recoverable-errors';

// The uncaughtException handler kills the app for anything this returns false
// for, so a miss here is a crash that takes every terminal down with it.
describe('isRecoverableSshError', () => {
  it('suppresses the handshake drop that was crashing the app', () => {
    // Logged repeatedly in ~/splitgrid-terminal-debug.log before this existed.
    const err = Object.assign(new Error('Connection lost before handshake'), {
      stack: 'Error: Connection lost before handshake\n    at makeError (…/node_modules/ssh2/lib/protocol/utils.js:142:15)',
    });
    expect(isRecoverableSshError(err)).toBe(true);
  });

  it('suppresses the connection errors the allowlist already covered', () => {
    for (const message of [
      'Connection terminated unexpectedly',
      'read ECONNRESET',
      'write EPIPE',
      'Channel open failure',
      'Keepalive timeout',
    ]) {
      expect(isRecoverableSshError(new Error(message)), message).toBe(true);
    }
  });

  it('suppresses anything thrown out of ssh2, whatever the wording', () => {
    const err = Object.assign(new Error('some future ssh2 wording'), {
      stack: 'Error: …\n    at Client.<anonymous> (/app.asar/node_modules/ssh2/lib/client.js:753:13)',
    });
    expect(isRecoverableSshError(err)).toBe(true);
  });

  it('suppresses ssh2 client errors tagged with a level', () => {
    expect(isRecoverableSshError(Object.assign(new Error('All auth methods failed'), { level: 'client-authentication' }))).toBe(true);
  });

  it('still lets a real bug through so it surfaces instead of being swallowed', () => {
    expect(isRecoverableSshError(new TypeError("Cannot read properties of undefined (reading 'foo')"))).toBe(false);
    expect(isRecoverableSshError(new Error('workspace state failed to save'))).toBe(false);
  });

  it('survives a non-Error being thrown', () => {
    expect(isRecoverableSshError(undefined)).toBe(false);
    expect(isRecoverableSshError('boom')).toBe(false);
    expect(isRecoverableSshError(null)).toBe(false);
  });
});
