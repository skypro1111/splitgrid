import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const STORE_FILE = 'known-hosts.json';

export type HostKeyCheck =
  | { status: 'match' }
  | { status: 'new'; fingerprint: string }
  | { status: 'mismatch'; expected: string; actual: string };

/** OpenSSH-style base64 SHA-256 fingerprint of the server's public host key. */
function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

class KnownHostsStore {
  private filePath: string;
  private keys: Record<string, string> = {};

  constructor() {
    this.filePath = path.join(app.getPath('userData'), STORE_FILE);
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        this.keys = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      }
    } catch {
      this.keys = {};
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.keys, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private id(host: string, port: number): string {
    return `${host}:${port}`;
  }

  check(host: string, port: number, key: Buffer): HostKeyCheck {
    const fp = fingerprintOf(key);
    const stored = this.keys[this.id(host, port)];
    if (!stored) return { status: 'new', fingerprint: fp };
    if (stored === fp) return { status: 'match' };
    return { status: 'mismatch', expected: stored, actual: fp };
  }

  trust(host: string, port: number, key: Buffer): void {
    this.keys[this.id(host, port)] = fingerprintOf(key);
    this.save();
  }

  forget(host: string, port: number): void {
    delete this.keys[this.id(host, port)];
    this.save();
  }
}

export const knownHostsStore = new KnownHostsStore();

/**
 * ssh2 hostVerifier with TOFU "accept-new" semantics: the first host key we see
 * for a host:port is pinned silently; a key that DIFFERS from the pinned one
 * fails closed (possible man-in-the-middle). On a mismatch, `onMismatch` is
 * invoked so the caller can surface a clear error before the handshake aborts.
 */
export function makeHostVerifier(
  host: string,
  port: number,
  onMismatch?: (m: { expected: string; actual: string }) => void,
) {
  return (key: Buffer, verify: (ok: boolean) => void): void => {
    const result = knownHostsStore.check(host, port, key);
    if (result.status === 'mismatch') {
      onMismatch?.({ expected: result.expected, actual: result.actual });
      verify(false);
      return;
    }
    if (result.status === 'new') knownHostsStore.trust(host, port, key);
    verify(true);
  };
}
