// Which uncaught main-process errors must NOT kill the app.
//
// SSH/SFTP connection failures surface as uncaught exceptions (ssh2 emits them
// from socket callbacks, outside any await), but they are recoverable per
// session — the sync manager reconnects on the next attempt. Killing the whole
// process takes every terminal in every window with it.
//
// Matching on message text alone kept missing new ones: a network drop during
// the handshake raises "Connection lost before handshake", which no allowlist
// covered, so the app died repeatedly. Recognize the ORIGIN as well — ssh2 tags
// its client errors with `level` and throws from its own files.
export function isRecoverableSshError(err: unknown): boolean {
  const e = err as { message?: unknown; stack?: unknown; level?: unknown } | null | undefined;
  const message = typeof e?.message === 'string' ? e.message : '';
  if (
    message.includes('Connection terminated') ||
    message.includes('Connection lost') ||
    message.includes('ECONNRESET') ||
    message.includes('EPIPE') ||
    message.includes('Channel open failure') ||
    message.includes('Keepalive timeout')
  ) return true;
  if (typeof e?.level === 'string') return true; // ssh2 client error
  return typeof e?.stack === 'string' && e.stack.includes('ssh2/lib');
}
