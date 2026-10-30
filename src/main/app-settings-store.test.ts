import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// app.getPath('userData') → a per-test temp dir, read at call time.
const h = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => h.dir } }));

// Imported AFTER the mock (vi.mock is hoisted above imports automatically).
import { AppSettingsStore } from './app-settings-store';
import type { AppSettings } from '../shared/types';

const file = () => path.join(h.dir, 'app-settings.json');
const writeRaw = (o: unknown) => writeFileSync(file(), JSON.stringify(o), 'utf-8');

beforeEach(() => { h.dir = mkdtempSync(path.join(os.tmpdir(), 'splitgrid-settings-')); });
afterEach(() => {
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// historyEnabled is consent to a download, so anything short of a real `true`
// must read and save as off.
describe('AppSettingsStore historyEnabled', () => {
  it('defaults to false with no settings file, and when the key is missing', () => {
    expect(new AppSettingsStore().get().historyEnabled).toBe(false);
    writeRaw({ muteAll: true });
    expect(new AppSettingsStore().get().historyEnabled).toBe(false);
  });

  it('reads a stored boolean, and treats a non-boolean as off', () => {
    writeRaw({ historyEnabled: true });
    expect(new AppSettingsStore().get().historyEnabled).toBe(true);
    for (const v of ['true', 1, {}, null]) {
      writeRaw({ historyEnabled: v });
      expect(new AppSettingsStore().get().historyEnabled).toBe(false);
    }
  });

  it('saves only a real true as on, and round-trips', () => {
    const store = new AppSettingsStore();
    const base = store.get();
    store.save({ ...base, historyEnabled: true });
    expect(store.get().historyEnabled).toBe(true);
    store.save({ ...base, historyEnabled: 'yes' as unknown as boolean });
    expect(JSON.parse(readFileSync(file(), 'utf-8')).historyEnabled).toBe(false);
    store.save({ ...base, historyEnabled: undefined } as AppSettings);
    expect(store.get().historyEnabled).toBe(false);
  });
});

// historyDistill is consent to run Claude Haiku (plan limits or API money):
// same strictness as historyEnabled.
describe('AppSettingsStore historyDistill', () => {
  it('defaults to false, reads only a real boolean, and saves only a real true', () => {
    expect(new AppSettingsStore().get().historyDistill).toBe(false);
    writeRaw({ historyDistill: true });
    expect(new AppSettingsStore().get().historyDistill).toBe(true);
    writeRaw({ historyDistill: 'true' });
    expect(new AppSettingsStore().get().historyDistill).toBe(false);
    const store = new AppSettingsStore();
    store.save({ ...store.get(), historyDistill: 1 as unknown as boolean });
    expect(JSON.parse(readFileSync(file(), 'utf-8')).historyDistill).toBe(false);
    store.save({ ...store.get(), historyDistill: true });
    expect(store.get().historyDistill).toBe(true);
  });
});
