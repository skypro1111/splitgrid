import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shared, hoisted state the electron mock reads at call time. `vi.hoisted` is the
// canonical way to let a vi.mock factory reference test-controlled values.
const h = vi.hoisted(() => ({ dir: '', safeAvailable: false }));

// Mock electron so ConnectionStore is testable in node: app.getPath → a temp dir
// (used for the store file AND the AES key material); safeStorage is a reversible
// stand-in whose availability we flip per-test to exercise both crypto paths.
vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  safeStorage: {
    isEncryptionAvailable: () => h.safeAvailable,
    encryptString: (s: string) => Buffer.from('SS:' + s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^SS:/, ''),
  },
}));

// Imported AFTER the mock (vi.mock is hoisted above imports automatically).
import { ConnectionStore } from './connection-store';
import type { SSHConnectionConfig } from '../shared/types';

const base: Omit<SSHConnectionConfig, 'id'> = {
  label: 'prod',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
};

beforeEach(() => {
  h.dir = mkdtempSync(path.join(os.tmpdir(), 'splitgrid-conn-'));
  h.safeAvailable = false;
});
afterEach(() => {
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Both crypto paths must round-trip the secrets back out identically.
describe.each([
  { name: 'AES fallback (safeStorage unavailable)', safe: false },
  { name: 'safeStorage path', safe: true },
])('encrypt/decrypt round-trip — $name', ({ safe }) => {
  beforeEach(() => { h.safeAvailable = safe; });

  it('round-trips password + sudoPassword and preserves offerSavedPassword', () => {
    const store = new ConnectionStore();
    const saved = store.add({
      ...base,
      password: 'hunter2',
      sudoPassword: 's3cret-sudo',
      offerSavedPassword: true,
    });

    // Stored form must NOT be the plaintext.
    expect(saved.encryptedPassword).toBeTruthy();
    expect(saved.encryptedPassword).not.toBe('hunter2');
    expect(saved.encryptedSudoPassword).not.toBe('s3cret-sudo');
    expect(saved.offerSavedPassword).toBe(true);

    const cfg = store.toConnectionConfig(saved);
    expect(cfg.password).toBe('hunter2');
    expect(cfg.sudoPassword).toBe('s3cret-sudo');
    expect(cfg.offerSavedPassword).toBe(true);
  });

  it('round-trips a key passphrase', () => {
    const store = new ConnectionStore();
    const saved = store.add({ ...base, authMethod: 'privateKey', privateKeyPath: '/k', passphrase: 'pp' });
    expect(store.toConnectionConfig(saved).passphrase).toBe('pp');
  });
});

describe('update semantics', () => {
  it('persists across a fresh store instance (real file)', () => {
    const saved = new ConnectionStore().add({ ...base, password: 'pw1', offerSavedPassword: true });
    // A new instance loads the same temp file.
    const cfg = new ConnectionStore().toConnectionConfig(
      new ConnectionStore().getAll().find((c) => c.id === saved.id)!,
    );
    expect(cfg.password).toBe('pw1');
    expect(cfg.offerSavedPassword).toBe(true);
  });

  it('empty password/sudoPassword on update preserves the stored secrets', () => {
    const store = new ConnectionStore();
    const saved = store.add({ ...base, password: 'orig', sudoPassword: 'origSudo' });
    store.update(saved.id, { ...base, password: undefined, sudoPassword: undefined, offerSavedPassword: true });
    const cfg = store.toConnectionConfig(store.getAll().find((c) => c.id === saved.id)!);
    expect(cfg.password).toBe('orig');
    expect(cfg.sudoPassword).toBe('origSudo');
    expect(cfg.offerSavedPassword).toBe(true);
  });

  it('a new password on update replaces the old one', () => {
    const store = new ConnectionStore();
    const saved = store.add({ ...base, password: 'orig' });
    store.update(saved.id, { ...base, password: 'changed' });
    expect(store.toConnectionConfig(store.getAll().find((c) => c.id === saved.id)!).password).toBe('changed');
  });
});

describe('groups', () => {
  it('stores a trimmed group on add/update and lists it in the group order', () => {
    const store = new ConnectionStore();
    const a = store.add({ ...base, group: '  prod ' });
    expect(a.group).toBe('prod');
    store.update(a.id, { ...base, group: '' });
    expect(store.getAll()[0].group).toBeUndefined();
    // The group stays known even after its last member left.
    expect(store.getGroups().groups).toEqual(['prod']);
  });

  it('keeps empty groups, order and fold state across a fresh instance', () => {
    const store = new ConnectionStore();
    store.createGroup('b');
    store.createGroup('a');
    store.setGroupCollapsed('a', true);
    const fresh = new ConnectionStore();
    expect(fresh.getGroups()).toEqual({ groups: ['b', 'a'], collapsed: ['a'] });
    fresh.setGroupCollapsed('a', false);
    expect(new ConnectionStore().getGroups().collapsed).toEqual([]);
  });

  it('moves connections between groups and to ungrouped', () => {
    const store = new ConnectionStore();
    const a = store.add({ ...base });
    const b = store.add({ ...base, label: 'b' });
    store.moveToGroup([a.id, b.id], 'staging');
    expect(store.getAll().map((c) => c.group)).toEqual(['staging', 'staging']);
    expect(store.getGroups().groups).toEqual(['staging']);
    store.moveToGroup([a.id], null);
    expect(store.getAll().map((c) => c.group)).toEqual([undefined, 'staging']);
  });

  it('renames a group in place, carrying members and fold state', () => {
    const store = new ConnectionStore();
    store.createGroup('x');
    const a = store.add({ ...base, group: 'old' });
    store.setGroupCollapsed('old', true);
    store.renameGroup('old', 'new');
    expect(store.getAll().find((c) => c.id === a.id)!.group).toBe('new');
    expect(store.getGroups()).toEqual({ groups: ['x', 'new'], collapsed: ['new'] });
  });

  it('renaming onto an existing group merges them', () => {
    const store = new ConnectionStore();
    store.add({ ...base, group: 'a' });
    store.add({ ...base, group: 'b' });
    store.renameGroup('a', 'b');
    expect(store.getAll().map((c) => c.group)).toEqual(['b', 'b']);
    expect(store.getGroups().groups).toEqual(['b']);
  });

  it('deleting a group ungroups its connections without deleting them', () => {
    const store = new ConnectionStore();
    store.add({ ...base, group: 'a' });
    store.setGroupCollapsed('a', true);
    store.deleteGroup('a');
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].group).toBeUndefined();
    expect(store.getGroups()).toEqual({ groups: [], collapsed: [] });
  });

  it('surfaces a group named only by a connection (e.g. a hand-edited file)', () => {
    const store = new ConnectionStore();
    store.add({ ...base, group: 'a' });
    store.deleteGroup('zzz');
    expect(new ConnectionStore().getGroups().groups).toEqual(['a']);
  });
});

describe('duplicate', () => {
  it('copies the connection with its secrets under a new id, right after the original', () => {
    const store = new ConnectionStore();
    const a = store.add({ ...base, password: 'pw', group: 'g' });
    const b = store.add({ ...base, label: 'other' });
    const copy = store.duplicate(a.id)!;
    expect(copy.id).not.toBe(a.id);
    expect(copy.label).toBe('prod (copy)');
    expect(copy.group).toBe('g');
    expect(store.getAll().map((c) => c.id)).toEqual([a.id, copy.id, b.id]);
    expect(store.toConnectionConfig(copy).password).toBe('pw');
    expect(store.duplicate('missing')).toBeNull();
  });
});
