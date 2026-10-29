// Shape of everything the Git pane exchanges with the main process.
//
// Kept separate from types.ts so the porcelain parsers (src/main/git-porcelain.ts)
// and the graph layout (src/shared/git-graph.ts) can be unit-tested without
// dragging in the whole Electron API surface.

/** A repository the pane is looking at, as resolved from some path on disk. */
export interface GitRepoInfo {
  /** Worktree root (`rev-parse --show-toplevel`). */
  root: string;
  /** This worktree's .git dir. Differs from `commonDir` inside a linked worktree. */
  gitDir: string;
  /** The shared .git dir — where refs/objects actually live. */
  commonDir: string;
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  head: string | null;
  detached: boolean;
  /** True while a rebase/merge/cherry-pick/bisect is in progress. */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}

export type GitRefKind = 'head' | 'branch' | 'remote' | 'tag' | 'stash' | 'other';

/** A ref decoration attached to a commit row (from `%D`). */
export interface GitRefLabel {
  name: string;
  kind: GitRefKind;
  /** True for the branch HEAD points at. */
  isHead?: boolean;
}

export interface GitCommit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  authorDate: number;
  committerName: string;
  committerDate: number;
  subject: string;
  body: string;
  refs: GitRefLabel[];
}

export interface GitLogPage {
  commits: GitCommit[];
  /** True when the log was cut off by `limit` and more commits exist. */
  hasMore: boolean;
}

export interface GitLogOptions {
  limit?: number;
  skip?: number;
  /** Show every ref, not just HEAD's ancestry. Defaults to true. */
  all?: boolean;
  /** Restrict to these revisions/branches (ignored when `all`). */
  refs?: string[];
  /** Only commits touching this path. */
  path?: string;
  /** `--grep` over the message. */
  search?: string;
  author?: string;
}

export interface GitBranch {
  /** Short name: `main`, `origin/main`. */
  name: string;
  /** Full refname: `refs/heads/main`. */
  fullName: string;
  sha: string;
  isRemote: boolean;
  /** True for the branch HEAD is on in THIS worktree. */
  isHead: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Set when the branch is checked out in some (possibly other) worktree. */
  worktreePath: string | null;
  /** Unix seconds of the tip commit. */
  date: number;
  subject: string;
}

export interface GitTag {
  name: string;
  fullName: string;
  sha: string;
  date: number;
  subject: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  /** The first entry `worktree list` reports — the main worktree. */
  isMain: boolean;
  /** The worktree the pane is currently rooted at. */
  isCurrent: boolean;
}

export interface GitStashEntry {
  /** Position in the stash stack; `stash@{index}`. */
  index: number;
  ref: string;
  sha: string;
  message: string;
  branch: string | null;
  date: number;
}

/** One file in `git status`. */
export interface GitStatusFile {
  path: string;
  /** Rename/copy source. */
  origPath: string | null;
  /** Index (staged) status letter, `.` when unchanged. */
  index: string;
  /** Worktree (unstaged) status letter, `.` when unchanged. */
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  ignored: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
}

export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

/** One file changed by a commit, with its line counts. */
export interface GitFileChange {
  path: string;
  origPath: string | null;
  status: GitFileStatus;
  /** Rename/copy similarity percentage, when status is R or C. */
  score: number | null;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitCommitDetail {
  commit: GitCommit;
  files: GitFileChange[];
}

/** Which pair of blobs a diff request wants. */
export type GitDiffSource =
  | { kind: 'commit'; sha: string }
  | { kind: 'staged' }
  | { kind: 'unstaged' }
  | { kind: 'stash'; ref: string };

/** The two sides of a diff, ready to hand to Monaco. */
export interface GitDiffSides {
  original: string;
  modified: string;
  originalPath: string | null;
  modifiedPath: string | null;
  binary: boolean;
  /** Set when a side was skipped for exceeding the size cap. */
  tooLarge: boolean;
}

/** Uniform result for every mutating command, so the UI can show git's own message. */
export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Persisted per-pane UI state. */
export interface GitPaneState {
  /** Repo root the pane was last pointed at. */
  repoPath?: string;
  tab?: 'history' | 'changes';
  sidebarWidth?: number;
  detailHeight?: number;
  sidebarCollapsed?: boolean;
  showRemoteBranches?: boolean;
  /** Commit selected in the history list. */
  selectedSha?: string | null;
  /** Collapsed sidebar sections. */
  collapsedSections?: string[];
}
