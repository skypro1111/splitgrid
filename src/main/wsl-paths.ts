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

// The reverse: `/mnt/c/a/b` → `C:\a\b`. A path a WSL agent reports (its $PWD,
// a file it names) must be in the host's form to match what the host indexed.
// Returns null for anything outside /mnt/<drive> (the distro's own filesystem
// has no fixed drive-letter form) so callers can pass it through unchanged.
export function wslPathToWin(p: string): string | null {
  const m = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(p);
  if (!m) return null;
  return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
}
