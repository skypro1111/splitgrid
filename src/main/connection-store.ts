import { app, safeStorage } from 'electron';
import { readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionGroupsState, SavedConnection, SSHConnectionConfig } from '../shared/types';
import { fallbackKey, legacyFallbackKey } from './fallback-key';
import { writeFileAtomicSync } from './atomic-write';

const STORE_FILE = 'saved-connections.json';
// Group order (incl. empty groups) and fold state. Kept out of STORE_FILE so the
// connections file stays a plain array older builds can still read.
const GROUPS_FILE = 'connection-groups.json';
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

/** Trimmed group name, or undefined for "no group". */
export function normalizeGroupName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return trimmed || undefined;
}

export class ConnectionStore {
  private filePath: string;
  private groupsFilePath: string;
  private connections: SavedConnection[] = [];
  private groups: ConnectionGroupsState = { groups: [], collapsed: [] };

  constructor() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, STORE_FILE);
    this.groupsFilePath = path.join(userDataPath, GROUPS_FILE);
    this.load();
    this.loadGroups();
  }

  private loadGroups(): void {
    try {
      if (!existsSync(this.groupsFilePath)) return;
      const raw = JSON.parse(readFileSync(this.groupsFilePath, 'utf-8'));
      const names = (v: unknown): string[] => Array.isArray(v)
        ? Array.from(new Set(v.map(normalizeGroupName).filter((n): n is string => !!n)))
        : [];
      this.groups = { groups: names(raw?.groups), collapsed: names(raw?.collapsed) };
    } catch {
      this.groups = { groups: [], collapsed: [] };
    }
  }

  private saveGroups(): void {
    const dir = path.dirname(this.groupsFilePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(this.groupsFilePath, JSON.stringify(this.groups, null, 2));
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
    writeFileAtomicSync(this.filePath, JSON.stringify(this.connections, null, 2), { mode: 0o600 });
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
      group: normalizeGroupName(config.group),
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
    this.registerGroup(saved.group);
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
      group: normalizeGroupName(config.group),
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
    this.registerGroup(updated.group);
    return updated;
  }

  /**
   * Copy a connection (secrets included — the encrypted blobs are reused as-is)
   * under a new id, right after the original, labelled "<label> (copy)".
   */
  duplicate(id: string): SavedConnection | null {
    const idx = this.connections.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const copy: SavedConnection = { ...this.connections[idx], id: uuidv4(), label: `${this.connections[idx].label} (copy)` };
    this.connections.splice(idx + 1, 0, copy);
    this.save();
    return copy;
  }

  delete(id: string): void {
    this.connections = this.connections.filter((c) => c.id !== id);
    this.save();
  }

  // --- Groups ---------------------------------------------------------------

  /** Stored group order, plus any group a connection names that the list lacks. */
  getGroups(): ConnectionGroupsState {
    const groups = [...this.groups.groups];
    for (const c of this.connections) {
      if (c.group && !groups.includes(c.group)) groups.push(c.group);
    }
    return { groups, collapsed: this.groups.collapsed.filter((g) => groups.includes(g)) };
  }

  /** Append a group to the stored order if it is new. */
  private registerGroup(name: string | undefined): void {
    if (!name || this.groups.groups.includes(name)) return;
    this.groups.groups.push(name);
    this.saveGroups();
  }

  createGroup(name: string): void {
    const n = normalizeGroupName(name);
    if (!n) throw new Error('Group name is empty');
    this.registerGroup(n);
  }

  /** Rename a group; renaming onto an existing group merges the two. */
  renameGroup(from: string, to: string): void {
    const src = normalizeGroupName(from);
    const dst = normalizeGroupName(to);
    if (!src || !dst) throw new Error('Group name is empty');
    if (src === dst) return;
    // Read the order BEFORE moving members, or dst would already look present.
    const order = this.getGroups().groups;
    const merged = order.includes(dst);
    let touched = false;
    for (const c of this.connections) {
      if (c.group === src) { c.group = dst; touched = true; }
    }
    if (touched) this.save();
    this.groups.groups = merged
      ? order.filter((g) => g !== src)
      : order.map((g) => (g === src ? dst : g));
    const wasCollapsed = this.groups.collapsed.includes(src);
    this.groups.collapsed = this.groups.collapsed.filter((g) => g !== src);
    if (wasCollapsed && !merged) this.groups.collapsed.push(dst);
    this.saveGroups();
  }

  /** Remove a group; its connections become ungrouped (they are not deleted). */
  deleteGroup(name: string): void {
    const n = normalizeGroupName(name);
    if (!n) return;
    let touched = false;
    for (const c of this.connections) {
      if (c.group === n) { delete c.group; touched = true; }
    }
    if (touched) this.save();
    this.groups.groups = this.groups.groups.filter((g) => g !== n);
    this.groups.collapsed = this.groups.collapsed.filter((g) => g !== n);
    this.saveGroups();
  }

  setGroupCollapsed(name: string, collapsed: boolean): void {
    const n = normalizeGroupName(name);
    if (!n) return;
    const has = this.groups.collapsed.includes(n);
    if (has === collapsed) return;
    this.groups.collapsed = collapsed
      ? [...this.groups.collapsed, n]
      : this.groups.collapsed.filter((g) => g !== n);
    this.saveGroups();
  }

  /** File connections under `group` (null/empty = ungrouped). */
  moveToGroup(ids: string[], group: string | null): void {
    const g = normalizeGroupName(group);
    const wanted = new Set(ids);
    let touched = false;
    for (const c of this.connections) {
      if (!wanted.has(c.id) || c.group === g) continue;
      if (g) c.group = g; else delete c.group;
      touched = true;
    }
    if (touched) this.save();
    this.registerGroup(g);
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
      group: saved.group,
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
