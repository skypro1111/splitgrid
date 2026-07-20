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
