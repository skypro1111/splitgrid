import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import path from 'node:path';

// Key material for the AES fallback used when the OS keychain (safeStorage) is
// unavailable — common on Linux without a keyring/libsecret. The OLD scheme
// derived the key from sha256(userData : user : home): all public, predictable
// inputs, so anyone who got a copy of the credential JSON could re-derive the
// key offline and decrypt every saved secret. This module replaces that with a
// random 32-byte secret persisted once (wrapped via safeStorage when available,
// else a 0600 file) and a scrypt-stretched key — never derivable from public
// data.

const KEY_FILE = 'credential-key.json';

interface StoredKey {
  v: 1;
  salt: string;
  /** base64 of the random secret; safeStorage-wrapped when `wrapped` is true. */
  secret: string;
  wrapped: boolean;
}

let cached: Buffer | null = null;

function filePath(): string {
  return path.join(app.getPath('userData'), KEY_FILE);
}

/**
 * Legacy weak key: sha256 of public machine paths. Retained ONLY so credentials
 * saved before this upgrade can still be decrypted (read-path fallback). Never
 * used for new writes.
 */
export function legacyFallbackKey(): Buffer {
  const material = [
    app.getPath('userData'),
    process.env.USER ?? process.env.USERNAME ?? '',
    app.getPath('home'),
  ].join(':');
  return createHash('sha256').update(material).digest();
}

function persist(secret: Buffer, salt: Buffer): void {
  const dir = path.dirname(filePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const wrapped = safeStorage.isEncryptionAvailable();
  const stored: StoredKey = {
    v: 1,
    salt: salt.toString('base64'),
    secret: wrapped
      ? safeStorage.encryptString(secret.toString('base64')).toString('base64')
      : secret.toString('base64'),
    wrapped,
  };
  writeFileSync(filePath(), JSON.stringify(stored), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * The 32-byte AES key for the encryption fallback. Loads (or creates once) a
 * random secret + salt and returns scrypt(secret, salt). Cached per process.
 */
export function fallbackKey(): Buffer {
  if (cached) return cached;

  let secret: Buffer | null = null;
  let salt: Buffer | null = null;

  if (existsSync(filePath())) {
    try {
      const data = JSON.parse(readFileSync(filePath(), 'utf-8')) as StoredKey;
      salt = Buffer.from(data.salt, 'base64');
      if (data.wrapped) {
        if (safeStorage.isEncryptionAvailable()) {
          secret = Buffer.from(
            safeStorage.decryptString(Buffer.from(data.secret, 'base64')),
            'base64',
          );
        }
      } else {
        secret = Buffer.from(data.secret, 'base64');
      }
    } catch {
      secret = null;
      salt = null;
    }
  }

  if (!secret || !salt) {
    secret = randomBytes(32);
    salt = randomBytes(16);
    persist(secret, salt);
  }

  cached = scryptSync(secret, salt, 32);
  return cached;
}
