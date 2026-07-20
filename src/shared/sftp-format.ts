// Pure, dependency-free formatting/path helpers for the SFTP file manager.
// No imports from electron or react so they stay unit-testable in the `node`
// vitest environment. Every time-dependent helper takes the clock injected, so
// the functions are pure (no Date.now() inside).

/** Human-readable byte size. 1024 base, 1 decimal for >= KB, integer bytes < KB.
 *  Directories ("—") are handled by the caller. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Relative time for the last 7 days ("just now", "5m ago", "3h ago", "2d ago"),
 *  otherwise an absolute "YYYY-MM-DD" date. `nowMs` is injected (no Date.now()
 *  inside) so the function is pure. `mtimeSeconds` is in seconds (ssh2 convention). */
export function formatMtime(mtimeSeconds: number, nowMs: number): string {
  const tsMs = mtimeSeconds * 1000;
  const diff = nowMs - tsMs;
  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  if (diff < WEEK_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  const d = new Date(tsMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const S_IFLNK = 0o120000;
const S_IFDIR = 0o40000;

/** POSIX permission string like "drwxr-xr-x" from a stat mode. Type prefix is
 *  'l' for symlink, 'd' for directory, '-' otherwise; then the low 9 bits. */
export function formatMode(mode: number): string {
  let type = '-';
  if ((mode & S_IFLNK) === S_IFLNK) type = 'l';
  else if (mode & S_IFDIR) type = 'd';
  const perms = ['r', 'w', 'x'];
  let out = '';
  for (let i = 8; i >= 0; i -= 1) {
    out += mode & (1 << i) ? perms[(8 - i) % 3] : '-';
  }
  return type + out;
}

/** POSIX path join: append `name` to `dir`, collapsing double slashes and
 *  handling the root directory. */
export function joinRemote(dir: string, name: string): string {
  if (dir === '/') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/** POSIX parent directory. Parent of '/' (and of any bare segment) is '/'. */
export function parentRemote(path: string): string {
  if (path === '/' || path === '') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}
