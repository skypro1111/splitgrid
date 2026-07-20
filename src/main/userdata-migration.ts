// One-time migration of the userData folder when the app was renamed
// (legacy "Swapit" -> the current product name). Runs once at startup, before
// any store reads. Copies the previous version's data files (settings, saved
// connections, history, workspaces …) into the new userData folder and re-keys
// path-derived secrets so SSH/SQL passwords survive the rename.
//
// Per platform:
//   • Windows  — `safe:` (DPAPI) secrets are user-bound, not app-bound, so they
//                keep decrypting after the copy; nothing to re-key.
//   • Linux (no keyring) / older macOS — secrets are `aes:`; the legacy ones are
//                path-derived and are re-keyed to the portable scrypt key here.
//   • Linux/macOS with a keyring — `safe:` secrets are keychain-bound to the old
//                app name and can't be re-keyed offline; those connections keep
//                their metadata but ask for the password again.
import { app, dialog, safeStorage } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { rekeyUserDataDir } from './userdata-rekey';

// Previous userData folder name (Electron derives it from the app/product name).
const LEGACY_APP_DIR = 'Swapit';

export function migrateLegacyUserData(): void {
  let newDir: string;
  let appData: string;
  try {
    newDir = app.getPath('userData');
    appData = app.getPath('appData');
  } catch {
    return;
  }
  const oldDir = path.join(appData, LEGACY_APP_DIR);
  if (path.resolve(oldDir) === path.resolve(newDir)) return; // same folder — not renamed
  if (!existsSync(oldDir)) return;                            // no previous data — fresh start
  // Don't clobber data the renamed app already has.
  if (existsSync(path.join(newDir, 'app-settings.json')) || existsSync(path.join(newDir, 'saved-connections.json'))) {
    return;
  }

  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Migrate my data', 'Start fresh'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: 'Migrate your existing data to SplitGrid?',
    detail:
      'Settings and saved connections (including SSH passwords) from the previous version were found. Copy them over so you don’t have to set everything up again.',
  });
  if (choice !== 0) return;

  mkdirSync(newDir, { recursive: true });
  // Copy only the app's own data files (the *.json), never Chromium caches/cookies.
  for (const name of readdirSync(oldDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      copyFileSync(path.join(oldDir, name), path.join(newDir, name));
    } catch { /* skip a file we can't read */ }
  }

  // Re-key path-derived (legacy) secrets so they survive the new folder name.
  try {
    const result = rekeyUserDataDir(newDir, oldDir, (b64) => {
      if (!safeStorage.isEncryptionAvailable()) return null;
      try {
        return Buffer.from(safeStorage.decryptString(Buffer.from(b64, 'base64')), 'base64');
      } catch {
        return null;
      }
    });
    console.log(`[migration] userData copied from "${oldDir}"; re-keyed ${result.rekeyed} secret(s), ${result.failed} unreadable.`);
  } catch (err) {
    console.warn('[migration] secret re-key failed (connections copied, some passwords may need re-entry):', err);
  }
}
