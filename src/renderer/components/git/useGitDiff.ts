import { useEffect, useRef, useState } from 'react';
import type { GitDiffSides, GitDiffSource } from '../../../shared/git-types';

/**
 * Loads both sides of one file's diff.
 *
 * `nonce` lets a caller force a reload of the same file — the working copy's
 * diff changes under a stage/unstage without the file path ever changing.
 */
export function useGitDiff(
  repo: string | null,
  source: GitDiffSource | null,
  file: string | null,
  origFile?: string | null,
  nonce = 0
): { diff: GitDiffSides | null; loading: boolean } {
  const [diff, setDiff] = useState<GitDiffSides | null>(null);
  const [loading, setLoading] = useState(false);
  const token = useRef(0);

  const sourceKey = source ? JSON.stringify(source) : '';

  useEffect(() => {
    if (!repo || !source || !file) {
      // Invalidate any in-flight load too, or it lands after the reset.
      ++token.current;
      setDiff(null);
      setLoading(false);
      return;
    }
    const current = ++token.current;
    setLoading(true);
    window.electronAPI
      .gitDiff(repo, source, file, origFile ?? null)
      .then((sides) => {
        if (current !== token.current) return;
        setDiff(sides);
      })
      .catch(() => {
        if (current !== token.current) return;
        setDiff(null);
      })
      .finally(() => {
        if (current === token.current) setLoading(false);
      });
    // `source` is compared by value through sourceKey — a fresh object literal
    // on every render would otherwise refetch forever.
  }, [repo, sourceKey, file, origFile, nonce]);

  return { diff, loading };
}
