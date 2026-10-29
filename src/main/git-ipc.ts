// IPC surface for the Git pane. Kept out of ipc-handlers.ts because the pane
// owns a self-contained slice of channels and one piece of live state — the
// per-repository ref watchers, ref-counted by the panes using them.

import { ipcMain } from 'electron';
import type {
  GitDiffSource,
  GitLogOptions,
  GitRepoInfo,
} from '../shared/git-types';
import * as git from './git-manager';

interface WatchEntry {
  watcher: git.GitWatcher;
  /** Pane ids keeping this watcher alive. */
  panes: Set<string>;
  info: GitRepoInfo;
}

export function registerGitIPCHandlers(
  broadcast: (channel: string, ...args: unknown[]) => void
): { disposeAll: () => void } {
  // Keyed by repo root — two panes on the same repository share one watcher.
  const watchers = new Map<string, WatchEntry>();
  const paneRepos = new Map<string, string>();

  const releasePane = (paneId: string) => {
    const root = paneRepos.get(paneId);
    if (!root) return;
    paneRepos.delete(paneId);
    const entry = watchers.get(root);
    if (!entry) return;
    entry.panes.delete(paneId);
    if (entry.panes.size === 0) {
      entry.watcher.dispose();
      watchers.delete(root);
    }
  };

  // ── Reads ──────────────────────────────────────────────────────────────────

  ipcMain.handle('git:detect', async (_e, dir: string) => git.detectRepo(dir));

  ipcMain.handle('git:log', async (_e, repo: string, options: GitLogOptions) =>
    git.getLog(repo, options ?? {})
  );

  ipcMain.handle('git:refs', async (_e, repo: string) => git.getRefs(repo));
  ipcMain.handle('git:worktrees', async (_e, repo: string) => git.getWorktrees(repo));
  ipcMain.handle('git:status', async (_e, repo: string) => git.getStatus(repo));
  ipcMain.handle('git:stashes', async (_e, repo: string) => git.getStashes(repo));
  ipcMain.handle('git:remotes', async (_e, repo: string) => git.getRemotes(repo));

  ipcMain.handle('git:commit-detail', async (_e, repo: string, sha: string) =>
    git.getCommitDetail(repo, sha)
  );

  ipcMain.handle('git:working-changes', async (_e, repo: string, staged: boolean) =>
    git.getWorkingChanges(repo, staged)
  );

  ipcMain.handle(
    'git:diff',
    async (_e, repo: string, source: GitDiffSource, file: string, origFile?: string | null) =>
      git.getDiff(repo, source, file, origFile)
  );

  ipcMain.handle('git:patch', async (_e, repo: string, source: GitDiffSource, file: string) =>
    git.getPatch(repo, source, file)
  );

  // ── Working copy ───────────────────────────────────────────────────────────

  ipcMain.handle('git:stage', async (_e, repo: string, paths: string[]) => git.stage(repo, paths));
  ipcMain.handle('git:unstage', async (_e, repo: string, paths: string[]) => git.unstage(repo, paths));
  ipcMain.handle('git:discard', async (_e, repo: string, paths: string[], untracked: string[]) =>
    git.discard(repo, paths ?? [], untracked ?? [])
  );
  ipcMain.handle(
    'git:commit',
    async (_e, repo: string, message: string, options: { amend?: boolean; signoff?: boolean; noVerify?: boolean }) =>
      git.commit(repo, message, options ?? {})
  );
  ipcMain.handle(
    'git:stash-push',
    async (_e, repo: string, options: { message?: string; includeUntracked?: boolean; keepIndex?: boolean }) =>
      git.stashPush(repo, options ?? {})
  );
  ipcMain.handle(
    'git:stash-action',
    async (_e, repo: string, action: 'apply' | 'pop' | 'drop', ref: string) =>
      git.stashAction(repo, action, ref)
  );

  // ── Refs ───────────────────────────────────────────────────────────────────

  ipcMain.handle(
    'git:checkout',
    async (_e, repo: string, ref: string, options: { newBranch?: string; force?: boolean }) =>
      git.checkout(repo, ref, options ?? {})
  );
  ipcMain.handle(
    'git:create-branch',
    async (_e, repo: string, name: string, startPoint?: string, checkoutAfter?: boolean) =>
      git.createBranch(repo, name, startPoint, checkoutAfter)
  );
  ipcMain.handle(
    'git:delete-branch',
    async (_e, repo: string, name: string, options: { force?: boolean; remote?: string }) =>
      git.deleteBranch(repo, name, options ?? {})
  );
  ipcMain.handle('git:rename-branch', async (_e, repo: string, from: string, to: string) =>
    git.renameBranch(repo, from, to)
  );
  ipcMain.handle(
    'git:merge',
    async (_e, repo: string, ref: string, options: { noFf?: boolean; squash?: boolean; message?: string }) =>
      git.mergeRef(repo, ref, options ?? {})
  );
  ipcMain.handle(
    'git:abort',
    async (_e, repo: string, operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert') =>
      git.abortOperation(repo, operation)
  );
  ipcMain.handle('git:create-tag', async (_e, repo: string, name: string, ref: string, message?: string) =>
    git.createTag(repo, name, ref, message)
  );
  ipcMain.handle('git:delete-tag', async (_e, repo: string, name: string, remote?: string) =>
    git.deleteTag(repo, name, remote)
  );
  ipcMain.handle('git:reset', async (_e, repo: string, ref: string, mode: 'soft' | 'mixed' | 'hard') =>
    git.resetTo(repo, ref, mode)
  );
  ipcMain.handle('git:revert', async (_e, repo: string, sha: string) => git.revertCommit(repo, sha));
  ipcMain.handle('git:cherry-pick', async (_e, repo: string, sha: string) => git.cherryPick(repo, sha));

  // ── Remotes ────────────────────────────────────────────────────────────────

  ipcMain.handle(
    'git:fetch',
    async (_e, repo: string, options: { remote?: string; all?: boolean; prune?: boolean }) =>
      git.fetch(repo, options ?? {})
  );
  ipcMain.handle('git:pull', async (_e, repo: string, options: { rebase?: boolean }) =>
    git.pull(repo, options ?? {})
  );
  ipcMain.handle(
    'git:push',
    async (
      _e,
      repo: string,
      options: { remote?: string; branch?: string; setUpstream?: boolean; force?: boolean; tags?: boolean }
    ) => git.push(repo, options ?? {})
  );

  // ── Worktrees ──────────────────────────────────────────────────────────────

  ipcMain.handle(
    'git:worktree-add',
    async (_e, repo: string, targetPath: string, options: { ref?: string; newBranch?: string; detach?: boolean }) =>
      git.worktreeAdd(repo, targetPath, options ?? {})
  );
  ipcMain.handle('git:worktree-remove', async (_e, repo: string, targetPath: string, force?: boolean) =>
    git.worktreeRemove(repo, targetPath, force)
  );
  ipcMain.handle('git:worktree-prune', async (_e, repo: string) => git.worktreePrune(repo));
  ipcMain.handle('git:worktree-lock', async (_e, repo: string, targetPath: string, lock: boolean) =>
    git.worktreeLock(repo, targetPath, lock)
  );

  // ── Live refresh ───────────────────────────────────────────────────────────

  ipcMain.handle('git:watch', async (_e, paneId: string, repo: string) => {
    // Re-pointing a pane at another repo drops its hold on the old one.
    if (paneRepos.get(paneId) !== repo) releasePane(paneId);

    const info = await git.detectRepo(repo);
    if (!info) return false;

    let entry = watchers.get(info.root);
    if (!entry) {
      entry = {
        panes: new Set(),
        info,
        watcher: new git.GitWatcher(info, () => broadcast('git:changed', info.root)),
      };
      entry.watcher.start();
      watchers.set(info.root, entry);
    }
    entry.panes.add(paneId);
    paneRepos.set(paneId, info.root);
    return true;
  });

  ipcMain.handle('git:unwatch', async (_e, paneId: string) => {
    releasePane(paneId);
  });

  return {
    disposeAll() {
      for (const entry of watchers.values()) entry.watcher.dispose();
      watchers.clear();
      paneRepos.clear();
    },
  };
}
