import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { SavedConnection, SSHConnectionConfig } from '../shared/types';
import { fallbackKey, legacyFallbackKey } from './fallback-key';

const STORE_FILE = 'saved-connections.json';
const ALGO = 'aes-256-gcm';

let warnedWeakFallback = false;

function encrypt(value: string): string {
  // Prefer OS-level encryption when available
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return 'safe:' + safeStorage.encryptString(value).toString('base64');
    } catch { /* fall through */ }
  }
  // Fallback: AES-256-GCM with a random, persisted key (see fallback-key.ts).
  if (!warnedWeakFallback) {
    warnedWeakFallback = true;
    console.warn('[connection-store] OS keychain unavailable — encrypting credentials with the local random-key fallback. Anyone with read access to your userData directory can decrypt them.');
  }
  const key = fallbackKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12) + tag(16) + ciphertext
  const blob = Buffer.concat([iv, tag, encrypted]);
  return 'aes:' + blob.toString('base64');
}

function decrypt(stored: string): string {
  if (stored.startsWith('safe:')) {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'));
      } catch { /* fall through to return empty */ }
    }
    return '';
  }

  if (stored.startsWith('aes:')) {
    const blob = Buffer.from(stored.slice(4), 'base64');
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const encrypted = blob.subarray(28);
    // Try the current random key first, then the legacy weak key so credentials
    // saved before the key upgrade still decrypt. GCM's auth tag rejects a wrong
    // key cleanly, so this can't silently return garbage.
    for (const key of [fallbackKey(), legacyFallbackKey()]) {
      try {
        const decipher = createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        return decipher.update(encrypted, undefined, 'utf-8') + decipher.final('utf-8');
      } catch { /* try next key */ }
    }
    return '';
  }

  if (stored.startsWith('b64:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf-8');
  }

  // Legacy: raw base64 from old safeStorage format (no prefix)
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch { /* not valid */ }
  }
  return '';
}

export class ConnectionStore {
  private filePath: string;
  private connections: SavedConnection[] = [];

  constructor() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, STORE_FILE);
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        this.connections = JSON.parse(raw);
        // Tighten perms on a file that may predate the 0600 hardening.
        try { chmodSync(this.filePath, 0o600); } catch { /* best effort */ }
      }
    } catch {
      this.connections = [];
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // 0600: the file holds encrypted credentials — never world-readable.
    writeFileSync(this.filePath, JSON.stringify(this.connections, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  getAll(): SavedConnection[] {
    return this.connections;
  }

  add(config: Omit<SSHConnectionConfig, 'id'>): SavedConnection {
    const saved: SavedConnection = {
      id: uuidv4(),
      label: config.label,
      host: config.host,
      port: config.port,
      username: config.username,
      authMethod: config.authMethod,
      privateKeyPath: config.privateKeyPath,
      offerSavedPassword: config.offerSavedPassword,
    };

    if (config.password) {
      saved.encryptedPassword = encrypt(config.password);
    }
    if (config.passphrase) {
      saved.encryptedPassphrase = encrypt(config.passphrase);
    }
    if (config.sudoPassword) {
      saved.encryptedSudoPassword = encrypt(config.sudoPassword);
    }

    this.connections.push(saved);
    this.save();
    return saved;
  }

  update(id: string, config: Omit<SSHConnectionConfig, 'id'>): SavedConnection | null {
    const idx = this.connections.findIndex((c) => c.id === id);
    if (idx === -1) return null;

    const existing = this.connections[idx];
    const updated: SavedConnection = {
      id,
      label: config.label,
      host: config.host,
      port: config.port,
      username: config.username,
      authMethod: config.authMethod,
      privateKeyPath: config.privateKeyPath,
      offerSavedPassword: config.offerSavedPassword,
    };

    if (config.password) {
      updated.encryptedPassword = encrypt(config.password);
    } else {
      updated.encryptedPassword = existing.encryptedPassword;
    }

    if (config.passphrase) {
      updated.encryptedPassphrase = encrypt(config.passphrase);
    } else {
      updated.encryptedPassphrase = existing.encryptedPassphrase;
    }

    // Empty string clears the dedicated sudo password; undefined preserves it.
    if (config.sudoPassword) {
      updated.encryptedSudoPassword = encrypt(config.sudoPassword);
    } else if (config.sudoPassword === undefined) {
      updated.encryptedSudoPassword = existing.encryptedSudoPassword;
    }

    this.connections[idx] = updated;
    this.save();
    return updated;
  }

  delete(id: string): void {
    this.connections = this.connections.filter((c) => c.id !== id);
    this.save();
  }

  toConnectionConfig(saved: SavedConnection): Omit<SSHConnectionConfig, 'id'> {
    const config: Omit<SSHConnectionConfig, 'id'> = {
      label: saved.label,
      host: saved.host,
      port: saved.port,
      username: saved.username,
      authMethod: saved.authMethod,
      privateKeyPath: saved.privateKeyPath,
      offerSavedPassword: saved.offerSavedPassword,
    };

    if (saved.encryptedPassword) {
      config.password = decrypt(saved.encryptedPassword);
    }
    if (saved.encryptedPassphrase) {
      config.passphrase = decrypt(saved.encryptedPassphrase);
    }
    if (saved.encryptedSudoPassword) {
      config.sudoPassword = decrypt(saved.encryptedSudoPassword);
    }

    return config;
  }
}
