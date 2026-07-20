// ─── Windows → WSL path translation (pure) ───────────────────────────────────
// `C:\a\b` → `/mnt/c/a/b`. Fixed drive letters only — good enough for an app
// install dir / userData path. Returns null for anything without a drive letter
// (UNC, already-POSIX) so callers can decide whether to skip or pass through.
// Shared by agent-file-bridge and agent-wsl-install (previously duplicated).

export function winPathToWsl(p: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}
