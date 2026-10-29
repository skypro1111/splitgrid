import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GitBranch,
  GitCommit,
  GitRemote,
  GitRepoInfo,
  GitStashEntry,
  GitStatus,
  GitTag,
  GitWorktree,
} from '../../../shared/git-types';
import { buildGraphRows, graphWidth, type GraphRow } from '../../../shared/git-graph';

/** How many commits the first page loads, and how much each "load more" adds. */
export const LOG_PAGE_SIZE = 500;

export interface GitLogFilters {
  /** Show every ref's history, not only the current branch's. */
  all: boolean;
  search: string;
  /** Limit history to one path. */
  path: string;
}

export interface GitRepoData {
  info: GitRepoInfo | null;
  /** Set when the path is not a repository, or git itself failed. */
  error: string | null;
  loading: boolean;
  commits: GitCommit[];
  graph: GraphRow[];
  graphLanes: number;
  hasMore: boolean;
  loadingMore: boolean;
  branches: GitBranch[];
  tags: GitTag[];
  worktrees: GitWorktree[];
  stashes: GitStashEntry[];
  remotes: GitRemote[];
  status: GitStatus | null;
  filters: GitLogFilters;
  setFilters: (update: Partial<GitLogFilters>) => void;
  refresh: () => void;
  /** Reload only the working-copy status — cheap enough for every focus event. */
  refreshStatus: () => void;
  loadMore: () => void;
}

const EMPTY_FILTERS: GitLogFilters = { all: true, search: '', path: '' };

/**
 * Loads and keeps fresh everything one repository view needs.
 *
 * The log is re-fetched wholesale rather than appended to, because the lane
 * layout of a commit depends on every commit above it — a page appended in
 * isolation would draw a different graph than the same commits loaded together.
 * Refetching 1–2k commits costs a few milliseconds of `git log`.
 */
export function useGitRepo(paneId: string, repoPath: string | null): GitRepoData {
  const [info, setInfo] = useState<GitRepoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(LOG_PAGE_SIZE);

  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [tags, setTags] = useState<GitTag[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [filters, setFiltersState] = useState<GitLogFilters>(EMPTY_FILTERS);

  // Bumped to force a reload; also lets an in-flight load know it is stale.
  const [nonce, setNonce] = useState(0);
  const loadToken = useRef(0);

  const setFilters = useCallback((update: Partial<GitLogFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...update }));
    setLimit(LOG_PAGE_SIZE);
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const refreshStatus = useCallback(() => {
    if (!info?.root) return;
    window.electronAPI
      .gitStatus(info.root)
      .then(setStatus)
      .catch(() => { /* a repo mid-checkout can fail a single poll; the next one wins */ });
  }, [info?.root]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setLimit((n) => n + LOG_PAGE_SIZE);
  }, [hasMore, loadingMore]);

  // Resolve the repository whenever the pane is pointed somewhere new.
  useEffect(() => {
    let cancelled = false;
    if (!repoPath) {
      setInfo(null);
      setError(null);
      return;
    }
    setLoading(true);
    window.electronAPI
      .gitDetect(repoPath)
      .then((detected) => {
        if (cancelled) return;
        setInfo(detected);
        setError(detected ? null : 'Not a git repository');
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setInfo(null);
        setError(e?.message ?? 'Failed to open repository');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, nonce]);

  const root = info?.root ?? null;

  // Everything else follows from the resolved root.
  useEffect(() => {
    if (!root) {
      setCommits([]);
      setBranches([]);
      setTags([]);
      setWorktrees([]);
      setStashes([]);
      setRemotes([]);
      setStatus(null);
      return;
    }

    const token = ++loadToken.current;
    const stale = () => token !== loadToken.current;
    setLoading(true);

    const logPromise = window.electronAPI
      .gitLog(root, {
        limit,
        all: filters.all,
        search: filters.search.trim() || undefined,
        path: filters.path.trim() || undefined,
      })
      .then((page) => {
        if (stale()) return;
        setCommits(page.commits);
        setHasMore(page.hasMore);
        setError(null);
      })
      .catch((e: Error) => {
        if (stale()) return;
        setCommits([]);
        setHasMore(false);
        setError(e?.message ?? 'git log failed');
      });

    const restPromise = Promise.all([
      window.electronAPI.gitRefs(root).then((r) => {
        if (stale()) return;
        setBranches(r.branches);
        setTags(r.tags);
      }),
      window.electronAPI.gitWorktrees(root).then((w) => !stale() && setWorktrees(w)),
      window.electronAPI.gitStashes(root).then((s) => !stale() && setStashes(s)),
      window.electronAPI.gitRemotes(root).then((r) => !stale() && setRemotes(r)),
      window.electronAPI
        .gitStatus(root)
        .then((s) => !stale() && setStatus(s))
        .catch(() => { /* status is best-effort; the log still renders */ }),
    ]).catch(() => { /* individual failures already handled */ });

    void Promise.all([logPromise, restPromise]).finally(() => {
      if (stale()) return;
      setLoading(false);
      setLoadingMore(false);
    });
  }, [root, limit, filters.all, filters.search, filters.path, nonce]);

  // Follow the repository's refs, HEAD and index — including moves made from a
  // terminal in the pane next door.
  useEffect(() => {
    if (!root) return;
    void window.electronAPI.gitWatch(paneId, root);
    const off = window.electronAPI.onGitChanged((changedRoot) => {
      if (changedRoot === root) refresh();
    });
    return () => {
      off();
      void window.electronAPI.gitUnwatch(paneId);
    };
  }, [paneId, root, refresh]);

  // Working-copy edits are not watched (walking a big checkout costs more than
  // it is worth), so catch up whenever the user comes back to the window.
  useEffect(() => {
    if (!root) return;
    const onFocus = () => refreshStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [root, refreshStatus]);

  const graph = useMemo(() => buildGraphRows(commits), [commits]);
  const graphLanes = useMemo(() => graphWidth(graph), [graph]);

  return {
    info,
    error,
    loading,
    commits,
    graph,
    graphLanes,
    hasMore,
    loadingMore,
    branches,
    tags,
    worktrees,
    stashes,
    remotes,
    status,
    filters,
    setFilters,
    refresh,
    refreshStatus,
    loadMore,
  };
}
