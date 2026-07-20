// One-time re-keying of saved credentials during the userData migration
// (legacy "Swapit" folder -> the renamed folder).
//
// The AES fallback used by the connection/SQL stores has two key schemes:
//   • portable  — scrypt(secret, salt) where secret lives in credential-key.json
//                 (path-INDEPENDENT, survives a folder rename);
//   • legacy    — sha256(userDataPath : user : home), which is DERIVED FROM THE
//                 FOLDER PATH. Renaming the userData folder changes this key, so
//                 any secret still under the legacy key would stop decrypting.
//
// This module decrypts every `aes:` secret with the OLD legacy key (computed
// from the OLD folder path) and re-encrypts it with the portable scrypt key, so
// the secrets no longer depend on the folder name. `safe:` secrets (OS keychain
// / Windows DPAPI) are left untouched — DPAPI decrypts regardless of app name,
// and keychain/keyring-bound ones can't be re-keyed offline anyway.
//
// Pure Node (no electron import) so it is unit-testable. The wrapped-secret
// unwrap (needed only when credential-key.json is keychain-wrapped) is injected.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALGO = 'aes-256-gcm';

function decryptAes(value: string, keys: Buffer[]): string | null {
  let blob: Buffer;
  try { blob = Buffer.from(value.slice(4), 'base64'); } catch { return null; }
  if (blob.length < 29) return null;
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  for (const key of keys) {
    try {
      const d = createDecipheriv(ALGO, key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf-8');
    } catch { /* try next key */ }
  }
  return null;
}

function encryptAes(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf-8'), c.final()]);
  const tag = c.getAuthTag();
  return 'aes:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

/** The legacy key the OLD install used: sha256(oldUserDataPath : user : home). */
export function legacyKeyForPath(oldUserDataPath: string): Buffer {
  const material = [
    oldUserDataPath,
    process.env.USER ?? process.env.USERNAME ?? '',
    os.homedir(),
  ].join(':');
  return createHash('sha256').update(material).digest();
}

/** The portable scrypt key from credential-key.json in `dir`, or null. */
export function portableKey(dir: string, unwrap?: (b64: string) => Buffer | null): Buffer | null {
  const f = path.join(dir, 'credential-key.json');
  if (!existsSync(f)) return null;
  let data: { salt: string; secret: string; wrapped: boolean };
  try { data = JSON.parse(readFileSync(f, 'utf-8')); } catch { return null; }
  let secret: Buffer | null = null;
  if (data.wrapped) {
    secret = unwrap ? unwrap(data.secret) : null;
  } else {
    try { secret = Buffer.from(data.secret, 'base64'); } catch { secret = null; }
  }
  if (!secret) return null;
  try { return scryptSync(secret, Buffer.from(data.salt, 'base64'), 32); } catch { return null; }
}

function rekeyNode(node: unknown, keys: Buffer[], dest: Buffer, counts: { rekeyed: number; failed: number }): unknown {
  if (typeof node === 'string') {
    if (!node.startsWith('aes:')) return node;
    const plain = decryptAes(node, keys);
    if (plain == null) { counts.failed++; return node; }
    counts.rekeyed++;
    return encryptAes(plain, dest);
  }
  if (Array.isArray(node)) return node.map((n) => rekeyNode(n, keys, dest, counts));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = rekeyNode(v, keys, dest, counts);
    return out;
  }
  return node;
}

/**
 * Re-key every `aes:` secret in the JSON files of `dir` from the old legacy key
 * (derived from `oldUserDataPath`) to the portable scrypt key in `dir`.
 * Returns counts; `portable:false` means there was no usable portable key, so
 * nothing was rewritten.
 */
export function rekeyUserDataDir(
  dir: string,
  oldUserDataPath: string,
  unwrap?: (b64: string) => Buffer | null,
): { rekeyed: number; failed: number; portable: boolean } {
  const dest = portableKey(dir, unwrap);
  const counts = { rekeyed: 0, failed: 0 };
  if (!dest) return { ...counts, portable: false };
  const keys = [dest, legacyKeyForPath(oldUserDataPath)];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'credential-key.json') continue;
    const fp = path.join(dir, name);
    let json: unknown;
    try { json = JSON.parse(readFileSync(fp, 'utf-8')); } catch { continue; }
    const before = counts.rekeyed;
    const out = rekeyNode(json, keys, dest, counts);
    if (counts.rekeyed !== before) {
      writeFileSync(fp, JSON.stringify(out, null, 2), { encoding: 'utf-8', mode: 0o600 });
    }
  }
  return { ...counts, portable: true };
}
