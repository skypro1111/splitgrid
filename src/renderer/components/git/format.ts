// Presentation helpers for the Git pane. Pure, so the awkward cases (a commit
// dated in the future by a skewed clock, a path with no directory) are pinned by
// tests rather than discovered in the UI.

export function shortSha(sha: string, length = 7): string {
  return sha.slice(0, length);
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Git-log style relative time. Anything older than a year gets an absolute date,
 * because "2 years ago" stops being useful once you are reading history.
 */
export function relativeTime(unixSeconds: number, now: number = Date.now()): string {
  if (!unixSeconds) return '';
  const seconds = Math.floor(now / 1000) - unixSeconds;
  // A clock-skewed commit reads as "now" rather than a negative age.
  if (seconds < MINUTE) return 'just now';
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  if (seconds < 7 * DAY) return `${Math.floor(seconds / DAY)}d ago`;
  if (seconds < MONTH) return `${Math.floor(seconds / (7 * DAY))}w ago`;
  if (seconds < YEAR) return `${Math.floor(seconds / MONTH)}mo ago`;
  return absoluteDate(unixSeconds);
}

export function absoluteDate(unixSeconds: number): string {
  if (!unixSeconds) return '';
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function fullTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return '';
  return new Date(unixSeconds * 1000).toLocaleString();
}

/** Splits `src/main/git.ts` into its directory and file name for two-tone rendering. */
export function splitPath(filePath: string): { dir: string; name: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  if (slash === -1) return { dir: '', name: normalized };
  return { dir: normalized.slice(0, slash), name: normalized.slice(slash + 1) };
}

/** Two-letter avatar fallback: "Sasha Kravchenko" -> "SK". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic per-author color, so the same person keeps one hue. */
export function authorColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) hash = (hash * 31 + email.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 45%)`;
}

/** The first line of a commit message, for one-line displays. */
export function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

/** Status letter -> label/color for the file lists. */
export function statusLabel(letter: string): { text: string; color: string; title: string } {
  switch (letter) {
    case 'A':
      return { text: 'A', color: 'var(--accent-green)', title: 'Added' };
    case 'M':
      return { text: 'M', color: 'var(--accent-yellow)', title: 'Modified' };
    case 'D':
      return { text: 'D', color: 'var(--accent-red)', title: 'Deleted' };
    case 'R':
      return { text: 'R', color: 'var(--accent-blue)', title: 'Renamed' };
    case 'C':
      return { text: 'C', color: 'var(--accent-blue)', title: 'Copied' };
    case 'T':
      return { text: 'T', color: 'var(--accent-purple)', title: 'Type changed' };
    case 'U':
      return { text: 'U', color: 'var(--accent-red)', title: 'Unmerged' };
    case '?':
      return { text: 'U', color: 'var(--accent-green)', title: 'Untracked' };
    default:
      return { text: letter || '·', color: 'var(--text-muted)', title: letter };
  }
}
