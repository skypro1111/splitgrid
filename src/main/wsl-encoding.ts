// ─── WSL output decoding (pure) ──────────────────────────────────────────────
// wsl.exe is inconsistent about output encoding: `--list` is UTF-16LE, command
// passthrough is usually UTF-8. We sniff by NUL density (UTF-16LE text is ~50%
// NULs for ASCII content) over a leading sample, then strip a leading BOM. Pure
// + Buffer-only so it's unit-testable. Shared by local-shell-manager and
// agent-wsl-install (previously duplicated in both).

const SNIFF_BYTES = 1024;
const UTF16_NUL_RATIO = 0.2; // >20% NULs in the sample ⇒ treat as UTF-16LE

export function decodeWslOutput(buf: Buffer): string {
  const sample = buf.subarray(0, Math.min(buf.length, SNIFF_BYTES));
  let nuls = 0;
  for (const b of sample) if (b === 0) nuls += 1;
  const isUtf16 = sample.length > 0 && nuls / sample.length > UTF16_NUL_RATIO;
  return (isUtf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
}
