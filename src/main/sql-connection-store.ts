import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { SavedSQLConnection, SQLConnectionConfig } from '../shared/types';
import { getDialectCapabilities } from '../shared/dialects';
import { fallbackKey, legacyFallbackKey } from './fallback-key';

const STORE_FILE = 'saved-sql-connections.json';
const ALGO = 'aes-256-gcm';

let warnedWeakFallback = false;

function encrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return 'safe:' + safeStorage.encryptString(value).toString('base64');
    } catch { /* fall through */ }
  }
  if (!warnedWeakFallback) {
    warnedWeakFallback = true;
    console.warn('[sql-connection-store] OS keychain unavailable — encrypting credentials with the local random-key fallback. Anyone with read access to your userData directory can decrypt them.');
  }
  const key = fallbackKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'aes:' + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(stored: string): string {
  if (stored.startsWith('safe:')) {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'));
      } catch { /* fall through */ }
    }
    return '';
  }
  if (stored.startsWith('aes:')) {
    const blob = Buffer.from(stored.slice(4), 'base64');
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const encrypted = blob.subarray(28);
    // Current random key first, then the legacy weak key for old blobs.
    for (const key of [fallbackKey(), legacyFallbackKey()]) {
      try {
        const decipher = createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        return decipher.update(encrypted, undefined, 'utf-8') + decipher.final('utf-8');
      } catch { /* try next key */ }
    }
    return '';
  }
  // Legacy: raw base64 from old safeStorage
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch { /* not valid */ }
  }
  return '';
}

interface PersistedSavedSQLConnection extends SavedSQLConnection {
  encryptedPassword?: string;
}

interface SaveSQLConnectionInput extends Omit<SavedSQLConnection, 'id'> {
  password: string;
}

export class SQLConnectionStore {
  private filePath: string;
  private connections: PersistedSavedSQLConnection[] = [];

  constructor() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, STORE_FILE);
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      // Backward-compat: older saved connections predate the `dialect` field.
      // Default any missing/unknown dialect to 'postgres' so old files still load.
      this.connections = (parsed as PersistedSavedSQLConnection[]).map((connection) => ({
        ...connection,
        dialect: connection.dialect ?? 'postgres',
      }));
      try { chmodSync(this.filePath, 0o600); } catch { /* best effort */ }
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

  private toPublic(c: PersistedSavedSQLConnection): SavedSQLConnection {
    return {
      id: c.id,
      label: c.label,
      dialect: c.dialect,
      host: c.host,
      port: c.port,
      user: c.user,
      database: c.database,
      ssl: c.ssl,
      ...(c.filePath ? { filePath: c.filePath } : {}),
    };
  }

  getAll(): SavedSQLConnection[] {
    return this.connections.map((connection) => this.toPublic(connection));
  }

  add(input: SaveSQLConnectionInput): SavedSQLConnection {
    const saved: PersistedSavedSQLConnection = {
      id: uuidv4(),
      label: input.label,
      dialect: input.dialect,
      host: input.host,
      port: input.port,
      user: input.user,
      database: input.database,
      ssl: input.ssl,
      ...(input.filePath ? { filePath: input.filePath } : {}),
    };

    if (input.password) {
      saved.encryptedPassword = encrypt(input.password);
    }

    this.connections.push(saved);
    this.save();
    return this.toPublic(saved);
  }

  delete(id: string): void {
    this.connections = this.connections.filter((connection) => connection.id !== id);
    this.save();
  }

  update(
    id: string,
    patch: Partial<Pick<SavedSQLConnection, 'label' | 'host' | 'port' | 'user' | 'database' | 'ssl' | 'filePath'>>
  ): SavedSQLConnection {
    const idx = this.connections.findIndex((connection) => connection.id === id);
    if (idx < 0) throw new Error('Saved SQL connection not found');
    const prev = this.connections[idx];
    const next: PersistedSavedSQLConnection = {
      ...prev,
      ...patch,
      id: prev.id,
      dialect: prev.dialect,
    };
    this.connections[idx] = next;
    this.save();
    return this.toPublic(next);
  }

  toConnectionConfig(savedId: string, databaseOverride?: string): SQLConnectionConfig {
    const saved = this.connections.find((connection) => connection.id === savedId);
    if (!saved) throw new Error('Saved SQL connection not found');

    const password = saved.encryptedPassword ? decrypt(saved.encryptedPassword) : '';
    // File-based dialects (sqlite) have no password; the file path is stored in
    // `database`. Only require a decryptable password for network dialects.
    const requiresFilePath = getDialectCapabilities(saved.dialect).requiresFilePath;
    if (!requiresFilePath && !password) {
      throw new Error('Cannot decrypt saved password — delete and re-save this connection');
    }

    return {
      dialect: saved.dialect,
      host: saved.host,
      port: saved.port,
      user: saved.user,
      password,
      database: databaseOverride && databaseOverride.trim() ? databaseOverride.trim() : saved.database,
      ssl: saved.ssl,
      connectionName: saved.label,
      ...(saved.filePath ? { filePath: saved.filePath } : {}),
    };
  }
}
