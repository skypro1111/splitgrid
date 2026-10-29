import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

// Write a file so a crash / power loss mid-write can never leave it truncated:
// write a sibling temp file, then rename it over the target (atomic on the same
// volume). Every store treats an unparsable file as "empty", so a half-written
// store file would otherwise be silently replaced by empty state on next save.
//
// If the rename itself fails (Windows: target held open by AV/indexer → EPERM),
// fall back to an in-place write — no worse than before, and the data lands.
export function writeFileAtomicSync(
  filePath: string,
  data: string | Buffer,
  options: { mode?: number } = {},
): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const opts = typeof data === 'string'
    ? { encoding: 'utf-8' as const, mode: options.mode }
    : { mode: options.mode };
  writeFileSync(tmp, data, opts);
  try {
    renameSync(tmp, filePath);
  } catch {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    writeFileSync(filePath, data, opts);
  }
}
