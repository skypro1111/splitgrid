import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';

// File index behind the Claude Code pane's `@` mentions.
//
// The CLI expands `@path` itself once the prompt reaches it, so all the pane
// owes the user is the picker: a fast, ranked list of the project's files. The
// walk is cached per root for a few seconds — a mention is typed one keystroke
// at a time, and re-walking a repo on each one would be absurd.

/** Directories never worth walking, whatever .gitignore says. */
const ALWAYS_SKIP = new Set([
  '.git',
  'node_modules',
  '.vite',
  'dist',
  'out',
  'build',
  '.next',
  '.cache',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
]);

const MAX_FILES = 20_000;
const CACHE_TTL_MS = 5_000;

export interface ProjectFile {
  /** Path relative to the root, POSIX-separated — what gets typed after `@`. */
  path: string;
  isDirectory: boolean;
}

interface CacheEntry {
  at: number;
  files: ProjectFile[];
}
const cache = new Map<string, CacheEntry>();

/** Score a candidate against the query. Higher is better; -1 means no match. */
export function scoreMatch(candidate: string, query: string): number {
  if (!query) return 1;
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();
  const base = haystack.slice(haystack.lastIndexOf('/') + 1);

  // Name matches beat path matches: typing "app" wants App.tsx, not
  // src/renderer/apple-touch-icon.png.
  if (base.startsWith(needle)) return 1000 - base.length;
  const baseIndex = base.indexOf(needle);
  if (baseIndex > 0) return 700 - baseIndex - base.length / 100;
  if (haystack.startsWith(needle)) return 500 - haystack.length / 100;
  const pathIndex = haystack.indexOf(needle);
  if (pathIndex >= 0) return 300 - pathIndex - haystack.length / 100;

  // Subsequence ("rcApp" → renderer/components/App): the loose fallback, so it
  // ranks below every literal match.
  let cursor = 0;
  for (const char of needle) {
    cursor = haystack.indexOf(char, cursor);
    if (cursor === -1) return -1;
    cursor += 1;
  }
  return 100 - haystack.length / 100;
}

/** Rank and cap candidates for one query. Directories win ties (they expand). */
export function rankFileMatches(
  files: ProjectFile[],
  query: string,
  limit: number,
): ProjectFile[] {
  const scored: { file: ProjectFile; score: number }[] = [];
  for (const file of files) {
    const score = scoreMatch(file.path, query);
    if (score < 0) continue;
    scored.push({ file, score: score + (file.isDirectory ? 0.5 : 0) });
  }
  scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  return scored.slice(0, limit).map((entry) => entry.file);
}

/** Load the root's .gitignore, if any, as a matcher. */
async function ignoreMatcher(root: string): Promise<ReturnType<typeof ignore> | null> {
  try {
    return ignore().add(await readFile(path.join(root, '.gitignore'), 'utf8'));
  } catch {
    return null;
  }
}

/** Breadth-first walk of the project, bounded and ignore-aware. */
async function walk(root: string): Promise<ProjectFile[]> {
  const matcher = await ignoreMatcher(root);
  const files: ProjectFile[] = [];
  const queue: string[] = [''];

  while (queue.length > 0 && files.length < MAX_FILES) {
    const relDir = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (ALWAYS_SKIP.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (matcher?.ignores(rel)) continue;
      const isDirectory = entry.isDirectory();
      files.push({ path: rel, isDirectory });
      if (isDirectory) queue.push(rel);
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}

/** Ranked `@`-mention candidates under `root`. */
export async function searchProjectFiles(
  root: string,
  query: string,
  limit = 12,
): Promise<ProjectFile[]> {
  if (!root) return [];
  const cached = cache.get(root);
  const fresh =
    cached && Date.now() - cached.at < CACHE_TTL_MS ? cached.files : await walk(root);
  if (fresh !== cached?.files) cache.set(root, { at: Date.now(), files: fresh });
  return rankFileMatches(fresh, query.trim(), limit);
}

/** Test seam. */
export function clearProjectFileCache(): void {
  cache.clear();
}
