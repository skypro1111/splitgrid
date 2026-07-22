// Pure path confinement for the agent SFTP bridge.
//
// An agent naming a path is not the user picking one in a file dialog: left
// unconstrained, `send ~/.ssh/id_rsa` would upload the user's keys to a remote
// host, and `get ../../etc/passwd` would write outside the workspace. So every
// path an agent supplies is resolved against a ROOT and rejected if it escapes.
//   • local  → the workspace's working directory (separator injected, so this
//              stays testable in the node vitest environment)
//   • remote → a sync target's remotePath. SSH-pane targets have no configured
//              root: the agent already has a shell on that host through the
//              pane, so confining SFTP there would buy nothing.
// Both helpers normalize '.' / '..' themselves — the renderer has no `path`.

import type { LocalSep } from './local-path';

export type { LocalSep };

/** True for an absolute local path: '/x' on POSIX; 'C:\x', '\x' or a UNC
 *  '\\server\share' on Windows. */
export function isAbsoluteLocal(p: string, sep: LocalSep): boolean {
  if (sep === '/') return p.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\') || p.startsWith('/');
}

// Collapse '.', '..' and repeated separators. Leading '..' segments are kept so
// the caller can tell an escape happened (the containment check then fails).
function normalizeSegments(segments: string[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out;
}

function splitLocal(p: string): string[] {
  return p.split(/[\\/]+/);
}

/**
 * Resolve an agent-supplied LOCAL path against the workspace root, or return
 * null when it escapes (or when there is no root to confine it to). Relative
 * inputs are joined to the root; absolute inputs are accepted only if they
 * already live under it. The result uses `sep` throughout.
 */
export function resolveAgentLocalPath(
  root: string | null | undefined,
  input: string,
  sep: LocalSep,
): string | null {
  if (!root || !input || input.includes('\0')) return null;

  const rootSegs = normalizeSegments(splitLocal(root));
  if (rootSegs.includes('..')) return null; // unusable root

  let segs: string[];
  if (isAbsoluteLocal(input, sep)) {
    const inSegs = normalizeSegments(splitLocal(input));
    // Windows compares drive letters case-insensitively; POSIX is exact.
    const eq = (a: string, b: string) => (sep === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (inSegs.length < rootSegs.length) return null;
    for (let i = 0; i < rootSegs.length; i++) {
      if (!eq(inSegs[i], rootSegs[i])) return null;
    }
    // Keep the ROOT's spelling for the shared prefix so results are canonical.
    segs = [...rootSegs, ...inSegs.slice(rootSegs.length)];
  } else {
    segs = normalizeSegments([...rootSegs, ...splitLocal(input)]);
    if (segs.length < rootSegs.length) return null;
    for (let i = 0; i < rootSegs.length; i++) {
      if (segs[i] !== rootSegs[i]) return null; // climbed out via '..'
    }
  }
  if (segs.includes('..')) return null;

  if (sep === '/') return `/${segs.join('/')}`;
  // Windows: joining already puts the separator after the drive ('C:' + '\' +
  // rest); a UNC root ('\\server\share') keeps its leading double separator.
  const joined = segs.join('\\');
  if (/^[A-Za-z]:$/.test(segs[0] ?? '')) return joined;
  return root.startsWith('\\\\') ? `\\\\${joined}` : `\\${joined}`;
}

/**
 * Resolve an agent-supplied REMOTE (POSIX) path. With a root, relative paths
 * are joined to it and the result must stay inside it; without a root (an
 * SSH-pane target) any absolute path is allowed and relative paths are refused
 * as ambiguous — the agent must be explicit about where a file lands.
 */
export function resolveAgentRemotePath(root: string | null | undefined, input: string): string | null {
  if (!input || input.includes('\0')) return null;

  if (!root) {
    if (!input.startsWith('/') && !input.startsWith('~')) return null;
    if (input.startsWith('~')) return input; // let the server expand it
    return `/${normalizeSegments(input.split('/')).join('/')}`;
  }

  const rootSegs = normalizeSegments(root.split('/'));
  const inputSegs = input.startsWith('/')
    ? normalizeSegments(input.split('/'))
    : normalizeSegments([...rootSegs, ...input.split('/')]);
  if (inputSegs.includes('..') || inputSegs.length < rootSegs.length) return null;
  for (let i = 0; i < rootSegs.length; i++) {
    if (inputSegs[i] !== rootSegs[i]) return null;
  }
  return `/${inputSegs.join('/')}`;
}

/** Last segment of a POSIX remote path ('' for '/'). */
export function remoteBasename(p: string): string {
  const segs = p.split('/').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : '';
}
