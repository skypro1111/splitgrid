/**
 * Shared host-key-change vocabulary used on both sides of the IPC boundary: the
 * main process builds the failure message (ssh-manager / sftp-sync-manager) and
 * the renderer parses it back into structured fields to offer a "the key
 * changed — accept the new one?" recovery flow. Kept free of any electron /
 * node imports so the renderer can import it too.
 */

export interface HostKeyChange {
  host: string;
  port: number;
  /** The fingerprint we previously pinned for this host (OpenSSH SHA256:…). */
  expected: string;
  /** The fingerprint the server presented now. */
  actual: string;
}

/** The single, canonical wording for a changed-host-key failure. Both transports
 * use this so the renderer parser below has exactly one format to recognize. */
export function hostKeyChangedMessage(c: HostKeyChange): string {
  return `Host key verification failed for ${c.host}:${c.port}: the server's key changed since you last connected (possible man-in-the-middle). Expected ${c.expected}, got ${c.actual}.`;
}

// Matches hostKeyChangedMessage even when wrapped by Electron's
// "Error invoking remote method '…': Error: …" IPC prefix (we search, not
// anchor). Fingerprints are OpenSSH base64 SHA-256 (SHA256:<base64, no padding>),
// so the charset capture stops cleanly before the trailing period.
const HOST_KEY_CHANGED_RE =
  /Host key verification failed for (.+?):(\d+):.*?Expected (SHA256:[A-Za-z0-9+/]+), got (SHA256:[A-Za-z0-9+/]+)/;

/** Parse a connect-error message back into a HostKeyChange, or null if it isn't
 * a changed-host-key failure. */
export function parseHostKeyChange(message: string): HostKeyChange | null {
  const m = HOST_KEY_CHANGED_RE.exec(message);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]), expected: m[3], actual: m[4] };
}
