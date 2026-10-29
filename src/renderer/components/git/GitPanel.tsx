import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PaneFocusButton } from '../focusMode';
import { RefreshIcon, SidebarIcon, SplitHorizontalIcon, SplitVerticalIcon } from '../Icons';
import { IDEContextMenu, type ContextMenuEntry } from '../ide/IDEContextMenu';
import type { ContainerContent } from '../../../shared/types';
import type { GitCommandResult, GitPaneState } from '../../../shared/git-types';
import { useGitRepo } from './useGitRepo';
import { GitSidebar, type GitRefTarget } from './GitSidebar';
import { GitLogList, WORKING_ROW } from './GitLogList';
import { GitCommitView } from './GitCommitView';
import { GitChangesPanel } from './GitChangesPanel';
import { shortSha } from './format';
import './git-pane.css';

interface Props {
  containerId: string;
  content: ContainerContent;
  /** Workspace folder — the repository the pane opens by default. */
  workspaceRootPath?: string | null;
  zoomLevel: number;
  onContentChange: (content: ContainerContent) => void;
  onClose: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
}

const DEFAULT_STATE: Required<Pick<GitPaneState, 'tab' | 'sidebarWidth' | 'detailHeight' | 'sidebarCollapsed'>> = {
  tab: 'history',
  sidebarWidth: 210,
  detailHeight: 300,
  sidebarCollapsed: false,
};

const MIN_SIDEBAR = 150;
const MAX_SIDEBAR = 420;
const MIN_DETAIL = 120;

const iconButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  borderRadius: 4,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  flexShrink: 0,
  color: 'var(--text-muted)',
};

const toolbarButton = (active = false): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  height: 20,
  padding: '0 7px',
  borderRadius: 4,
  fontSize: 10.5,
  fontWeight: 600,
  background: active ? 'var(--bg-hover)' : 'transparent',
  border: '1px solid transparent',
  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
  cursor: 'pointer',
  flexShrink: 0,
  whiteSpace: 'nowrap',
});

interface PromptState {
  title: string;
  label: string;
  value: string;
  placeholder?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (value: string) => void;
}

/**
 * The repository pane: commit graph, refs, worktrees, stashes and the working
 * copy, over the repository the workspace is rooted at.
 */
export const GitPanel: React.FC<Props> = ({
  containerId,
  content,
  workspaceRootPath,
  zoomLevel,
  onContentChange,
  onClose,
  onSplitRight,
  onSplitDown,
}) => {
  const persisted = content.gitState ?? {};
  const [repoPath, setRepoPath] = useState<string | null>(persisted.repoPath ?? workspaceRootPath ?? null);
  const [tab, setTab] = useState<'history' | 'changes'>(persisted.tab ?? DEFAULT_STATE.tab);
  const [sidebarWidth, setSidebarWidth] = useState(persisted.sidebarWidth ?? DEFAULT_STATE.sidebarWidth);
  const [detailHeight, setDetailHeight] = useState(persisted.detailHeight ?? DEFAULT_STATE.detailHeight);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(persisted.sidebarCollapsed ?? false);
  const [collapsedSections, setCollapsedSections] = useState<string[]>(persisted.collapsedSections ?? ['remotes', 'tags']);
  const [selected, setSelected] = useState<string | null>(persisted.selectedSha ?? null);

  const [inlineDiff, setInlineDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);

  const repo = useGitRepo(containerId, repoPath);
  const root = repo.info?.root ?? null;
  // Pane zoom is expressed as a base font size (13 = 1x), the way the other panes read it.
  const diffFontSize = Math.max(9, (zoomLevel || 13) - 1);

  // Persist the pane's layout and place in the history.
  const contentRef = useRef(content);
  contentRef.current = content;
  useEffect(() => {
    const next: GitPaneState = {
      repoPath: repoPath ?? undefined,
      tab,
      sidebarWidth,
      detailHeight,
      sidebarCollapsed,
      collapsedSections,
      selectedSha: selected,
    };
    const current = contentRef.current.gitState;
    if (JSON.stringify(current ?? {}) === JSON.stringify(next)) return;
    onContentChange({
      ...contentRef.current,
      type: 'git',
      label: root ? `Git — ${root.replace(/\\/g, '/').split('/').filter(Boolean).pop()}` : 'Git',
      gitState: next,
    });
  }, [repoPath, tab, sidebarWidth, detailHeight, sidebarCollapsed, collapsedSections, selected, root, onContentChange]);

  /** Runs a mutating git command, showing git's own message when it fails. */
  const run = useCallback(
    async (fn: () => Promise<GitCommandResult>): Promise<boolean> => {
      setBusy(true);
      setBanner(null);
      try {
        const result = await fn();
        if (!result.ok) {
          setBanner({ text: (result.stderr || result.stdout || 'git command failed').trim(), tone: 'error' });
          return false;
        }
        if (result.stdout.trim()) setBanner({ text: result.stdout.trim().split('\n').slice(-3).join('\n'), tone: 'info' });
        return true;
      } catch (e) {
        setBanner({ text: (e as Error)?.message ?? 'git command failed', tone: 'error' });
        return false;
      } finally {
        setBusy(false);
        repo.refresh();
      }
    },
    [repo]
  );

  const chooseFolder = useCallback(async () => {
    const dir = await window.electronAPI.selectDirectory({ title: 'Open a git repository' });
    if (dir) {
      setRepoPath(dir);
      setSelected(null);
    }
  }, []);

  // ── Sidebar / detail resizing ──────────────────────────────────────────────

  const dragRef = useRef<{ kind: 'sidebar' | 'detail'; start: number; initial: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === 'sidebar') {
        setSidebarWidth(Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, drag.initial + (e.clientX - drag.start))));
      } else {
        setDetailHeight(Math.max(MIN_DETAIL, drag.initial - (e.clientY - drag.start)));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // ── Context menus ──────────────────────────────────────────────────────────

  const askFor = (state: PromptState) => setPrompt(state);

  const commitMenu = useCallback(
    (sha: string, x: number, y: number) => {
      if (!root || sha === WORKING_ROW) return;
      const short = shortSha(sha);
      setMenu({
        x,
        y,
        items: [
          { label: 'Copy commit hash', action: () => void navigator.clipboard.writeText(sha) },
          { separator: true },
          {
            label: `Create branch from ${short}…`,
            action: () =>
              askFor({
                title: 'New branch',
                label: `Branch from ${short}`,
                value: '',
                placeholder: 'feature/my-work',
                confirmLabel: 'Create & checkout',
                onConfirm: (name) => void run(() => window.electronAPI.gitCreateBranch(root, name, sha, true)),
              }),
          },
          {
            label: `Create tag at ${short}…`,
            action: () =>
              askFor({
                title: 'New tag',
                label: `Tag at ${short}`,
                value: '',
                placeholder: 'v1.2.0',
                confirmLabel: 'Create tag',
                onConfirm: (name) => void run(() => window.electronAPI.gitCreateTag(root, name, sha)),
              }),
          },
          { separator: true },
          {
            label: `Checkout ${short} (detached)`,
            action: () => void run(() => window.electronAPI.gitCheckout(root, sha)),
          },
          {
            label: `Merge ${short} into current branch`,
            action: () => void run(() => window.electronAPI.gitMerge(root, sha)),
          },
          { label: `Cherry-pick ${short}`, action: () => void run(() => window.electronAPI.gitCherryPick(root, sha)) },
          { label: `Revert ${short}`, action: () => void run(() => window.electronAPI.gitRevert(root, sha)) },
          { separator: true },
          {
            label: `Reset current branch to ${short} (soft)`,
            action: () => void run(() => window.electronAPI.gitReset(root, sha, 'soft')),
          },
          {
            label: `Reset current branch to ${short} (hard)`,
            danger: true,
            action: () =>
              askFor({
                title: 'Hard reset',
                label: `Type the short hash to reset --hard to ${short}. Uncommitted work in tracked files is lost.`,
                value: '',
                placeholder: short,
                confirmLabel: 'Reset --hard',
                danger: true,
                onConfirm: (typed) => {
                  if (typed.trim() !== short) {
                    setBanner({ text: 'Reset cancelled — the hash did not match.', tone: 'error' });
                    return;
                  }
                  void run(() => window.electronAPI.gitReset(root, sha, 'hard'));
                },
              }),
          },
        ],
      });
    },
    [root, run]
  );

  const refMenu = useCallback(
    (target: GitRefTarget, x: number, y: number) => {
      if (!root) return;
      const items: ContextMenuEntry[] = [];

      if (target.kind === 'branch') {
        const branch = target.branch;
        items.push({
          label: branch.isRemote ? `Checkout ${branch.name} (new local branch)` : `Checkout ${branch.name}`,
          disabled: branch.isHead,
          action: () =>
            void run(() =>
              branch.isRemote
                ? window.electronAPI.gitCheckout(root, branch.name, {
                    newBranch: branch.name.slice(branch.name.indexOf('/') + 1),
                  })
                : window.electronAPI.gitCheckout(root, branch.name)
            ),
        });
        items.push({
          label: `Merge ${branch.name} into current branch`,
          disabled: branch.isHead,
          action: () => void run(() => window.electronAPI.gitMerge(root, branch.name)),
        });
        if (!branch.isRemote) {
          items.push({
            label: 'Rename…',
            action: () =>
              askFor({
                title: 'Rename branch',
                label: `Rename ${branch.name} to`,
                value: branch.name,
                confirmLabel: 'Rename',
                onConfirm: (name) => void run(() => window.electronAPI.gitRenameBranch(root, branch.name, name)),
              }),
          });
          items.push({
            label: `Push ${branch.name}`,
            action: () =>
              void run(() =>
                window.electronAPI.gitPush(root, {
                  remote: branch.upstream ? undefined : repo.remotes[0]?.name,
                  branch: branch.upstream ? undefined : branch.name,
                  setUpstream: !branch.upstream,
                })
              ),
          });
        }
        items.push({ separator: true });
        items.push({ label: 'Copy name', action: () => void navigator.clipboard.writeText(branch.name) });
        items.push({
          label: branch.isRemote ? `Delete ${branch.name} on remote` : `Delete ${branch.name}`,
          danger: true,
          disabled: branch.isHead,
          action: () =>
            void run(() =>
              branch.isRemote
                ? window.electronAPI.gitDeleteBranch(root, branch.name.slice(branch.name.indexOf('/') + 1), {
                    remote: branch.name.slice(0, branch.name.indexOf('/')),
                  })
                : window.electronAPI.gitDeleteBranch(root, branch.name, { force: true })
            ),
        });
      }

      if (target.kind === 'tag') {
        const tag = target.tag;
        items.push({ label: `Checkout ${tag.name}`, action: () => void run(() => window.electronAPI.gitCheckout(root, tag.name)) });
        items.push({ label: 'Copy name', action: () => void navigator.clipboard.writeText(tag.name) });
        for (const remote of repo.remotes) {
          items.push({
            label: `Push ${tag.name} to ${remote.name}`,
            action: () => void run(() => window.electronAPI.gitPush(root, { remote: remote.name, branch: `refs/tags/${tag.name}` })),
          });
        }
        items.push({ separator: true });
        items.push({ label: `Delete ${tag.name}`, danger: true, action: () => void run(() => window.electronAPI.gitDeleteTag(root, tag.name)) });
      }

      if (target.kind === 'worktree') {
        const worktree = target.worktree;
        items.push({
          label: 'Show this worktree in the pane',
          disabled: worktree.isCurrent,
          action: () => {
            setRepoPath(worktree.path);
            setSelected(null);
          },
        });
        items.push({ label: 'Copy path', action: () => void navigator.clipboard.writeText(worktree.path) });
        items.push({
          label: worktree.locked ? 'Unlock' : 'Lock',
          disabled: worktree.isMain,
          action: () => void run(() => window.electronAPI.gitWorktreeLock(root, worktree.path, !worktree.locked)),
        });
        items.push({ separator: true });
        items.push({ label: 'Prune stale worktrees', action: () => void run(() => window.electronAPI.gitWorktreePrune(root)) });
        items.push({
          label: 'Remove worktree',
          danger: true,
          disabled: worktree.isMain,
          action: () =>
            askFor({
              title: 'Remove worktree',
              label: `Type "remove" to delete the worktree at ${worktree.path}. Its uncommitted changes are lost.`,
              value: '',
              placeholder: 'remove',
              confirmLabel: 'Remove worktree',
              danger: true,
              onConfirm: (typed) => {
                if (typed.trim().toLowerCase() !== 'remove') {
                  setBanner({ text: 'Removal cancelled.', tone: 'error' });
                  return;
                }
                void run(() => window.electronAPI.gitWorktreeRemove(root, worktree.path, true)).then((ok) => {
                  if (ok && worktree.isCurrent) setRepoPath(repo.worktrees.find((w) => w.isMain)?.path ?? null);
                });
              },
            }),
        });
      }

      if (target.kind === 'stash') {
        const stash = target.stash;
        items.push({ label: `Apply ${stash.ref}`, action: () => void run(() => window.electronAPI.gitStashAction(root, 'apply', stash.ref)) });
        items.push({ label: `Pop ${stash.ref}`, action: () => void run(() => window.electronAPI.gitStashAction(root, 'pop', stash.ref)) });
        items.push({ separator: true });
        items.push({ label: `Drop ${stash.ref}`, danger: true, action: () => void run(() => window.electronAPI.gitStashAction(root, 'drop', stash.ref)) });
      }

      setMenu({ x, y, items });
    },
    [repo.remotes, repo.worktrees, root, run]
  );

  const selectRef = useCallback((target: GitRefTarget) => {
    if (target.kind === 'worktree') {
      setRepoPath(target.worktree.path);
      setSelected(null);
      return;
    }
    const sha =
      target.kind === 'branch' ? target.branch.sha : target.kind === 'tag' ? target.tag.sha : target.stash.sha;
    setSelected(sha);
    setTab('history');
  }, []);

  const createBranchPrompt = useCallback(() => {
    if (!root) return;
    askFor({
      title: 'New branch',
      label: `Branch from ${repo.info?.branch ?? 'HEAD'}`,
      value: '',
      placeholder: 'feature/my-work',
      confirmLabel: 'Create & checkout',
      onConfirm: (name) => void run(() => window.electronAPI.gitCreateBranch(root, name, 'HEAD', true)),
    });
  }, [repo.info?.branch, root, run]);

  const addWorktreePrompt = useCallback(() => {
    if (!root) return;
    askFor({
      title: 'Add worktree',
      label: 'New branch for the worktree (leave empty to check out an existing ref)',
      value: '',
      placeholder: 'feature/my-work',
      confirmLabel: 'Choose folder…',
      onConfirm: (name) => {
        void (async () => {
          const parent = await window.electronAPI.selectDirectory({
            title: 'Where should the worktree live?',
            buttonLabel: 'Create here',
          });
          if (!parent) return;
          const safe = (name || 'worktree').replace(/[^\w.-]+/g, '-');
          const target = `${parent.replace(/[\\/]+$/, '')}/${safe}`;
          const ok = await run(() =>
            window.electronAPI.gitWorktreeAdd(root, target, name ? { newBranch: name } : { ref: 'HEAD', detach: true })
          );
          if (ok) setRepoPath(target);
        })();
      },
    });
  }, [root, run]);

  // ── Derived toolbar state ──────────────────────────────────────────────────

  const headBranch = useMemo(() => repo.branches.find((b) => b.isHead) ?? null, [repo.branches]);
  const workingCount = repo.status?.files.filter((f) => !f.ignored).length ?? 0;
  const repoName = root ? root.replace(/\\/g, '/').split('/').filter(Boolean).pop() : null;

  // A pane pointed at a folder with no repository, or none chosen yet.
  if (!repoPath || (!repo.loading && !repo.info)) {
    return (
      <PaneShell
        containerId={containerId}
        title={repoPath ? 'Not a git repository' : 'Git'}
        onClose={onClose}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
      >
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 12, padding: 20, textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
            {repoPath ? 'No repository here' : 'Open a repository'}
          </div>
          {repoPath && <div style={{ maxWidth: 380, wordBreak: 'break-all' }}>{repoPath}</div>}
          <button style={{ ...toolbarButton(), border: '1px solid var(--border)', height: 26, padding: '0 12px' }} onClick={() => void chooseFolder()}>
            Choose folder…
          </button>
        </div>
      </PaneShell>
    );
  }

  // Resolving the repository is one `git rev-parse`; everything below needs its
  // root, so wait for it rather than threading a null through the whole pane.
  if (!root) {
    return (
      <PaneShell
        containerId={containerId}
        title="Git"
        onClose={onClose}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
      >
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          Opening repository…
        </div>
      </PaneShell>
    );
  }

  const showChanges = tab === 'changes' || selected === WORKING_ROW;

  return (
    <PaneShell
      containerId={containerId}
      title={
        <>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{repoName}</span>
          {repo.info?.branch && (
            <span style={{ color: 'var(--accent-green)' }}>⎇ {repo.info.branch}</span>
          )}
          {repo.info?.detached && <span style={{ color: 'var(--accent-orange)' }}>detached</span>}
          {repo.info?.operation && (
            <span style={{ color: 'var(--accent-orange)' }}>{repo.info.operation} in progress</span>
          )}
        </>
      }
      onClose={onClose}
      onSplitRight={onSplitRight}
      onSplitDown={onSplitDown}
      toolbar={
        <>
          <button
            style={toolbarButton(tab === 'history' && selected !== WORKING_ROW)}
            onClick={() => {
              setTab('history');
              if (selected === WORKING_ROW) setSelected(null);
            }}
          >
            History
          </button>
          <button style={toolbarButton(showChanges)} onClick={() => setTab('changes')}>
            Changes{workingCount ? ` (${workingCount})` : ''}
          </button>
          <span style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 3px' }} />
          <button style={toolbarButton()} disabled={busy} onClick={() => void run(() => window.electronAPI.gitFetch(root!, { prune: true }))} title="git fetch --all --prune">
            Fetch
          </button>
          <button
            style={toolbarButton()}
            disabled={busy}
            onClick={() => void run(() => window.electronAPI.gitPull(root!))}
            title="git pull"
          >
            Pull{headBranch?.behind ? ` ↓${headBranch.behind}` : ''}
          </button>
          <button
            style={toolbarButton()}
            disabled={busy}
            onClick={() =>
              void run(() =>
                window.electronAPI.gitPush(root!, headBranch?.upstream ? {} : { remote: repo.remotes[0]?.name, branch: headBranch?.name, setUpstream: true })
              )
            }
            title={headBranch?.upstream ? 'git push' : 'git push --set-upstream'}
          >
            Push{headBranch?.ahead ? ` ↑${headBranch.ahead}` : ''}
          </button>
          <span style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 3px' }} />
          <button style={toolbarButton(inlineDiff)} onClick={() => setInlineDiff((v) => !v)} title="Toggle inline / side-by-side diff">
            {inlineDiff ? 'Inline' : 'Split'}
          </button>
          <button
            style={{ ...iconButton, color: sidebarCollapsed ? 'var(--text-muted)' : 'var(--text-primary)' }}
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? 'Show branches sidebar' : 'Hide branches sidebar'}
          >
            <SidebarIcon size={13} />
          </button>
          <button style={iconButton} onClick={() => repo.refresh()} title="Refresh" disabled={busy}>
            <RefreshIcon size={13} />
          </button>
        </>
      }
    >
      {banner && (
        <div
          onClick={() => setBanner(null)}
          title="Click to dismiss"
          style={{
            padding: '4px 10px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            whiteSpace: 'pre-wrap',
            maxHeight: 84,
            overflow: 'auto',
            cursor: 'pointer',
            color: banner.tone === 'error' ? 'var(--accent-red)' : 'var(--text-secondary)',
            background: banner.tone === 'error' ? 'rgba(241,76,76,0.10)' : 'var(--bg-surface)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          {banner.text}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {!sidebarCollapsed && (
          <>
            <div style={{ width: sidebarWidth, flexShrink: 0, minWidth: 0 }}>
              <GitSidebar
                info={repo.info}
                branches={repo.branches}
                tags={repo.tags}
                worktrees={repo.worktrees}
                stashes={repo.stashes}
                collapsed={collapsedSections}
                onToggleSection={(id) =>
                  setCollapsedSections((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
                }
                onSelectRef={selectRef}
                onContextMenu={refMenu}
                onCreateBranch={createBranchPrompt}
                onAddWorktree={addWorktreePrompt}
                activeSha={selected}
              />
            </div>
            <div
              onMouseDown={(e) => {
                dragRef.current = { kind: 'sidebar', start: e.clientX, initial: sidebarWidth };
                document.body.style.cursor = 'col-resize';
              }}
              style={{ width: 4, cursor: 'col-resize', background: 'var(--border)', flexShrink: 0 }}
            />
          </>
        )}

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {showChanges ? (
            <GitChangesPanel repo={root!} status={repo.status} inlineDiff={inlineDiff} diffFontSize={diffFontSize} busy={busy} run={run} />
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
                <input
                  className="git-input"
                  style={{ flex: 1, height: 22 }}
                  placeholder="Search commit messages…"
                  defaultValue={repo.filters.search}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') repo.setFilters({ search: (e.target as HTMLInputElement).value });
                    if (e.key === 'Escape') {
                      (e.target as HTMLInputElement).value = '';
                      repo.setFilters({ search: '' });
                    }
                  }}
                  spellCheck={false}
                />
                <button
                  style={toolbarButton(repo.filters.all)}
                  onClick={() => repo.setFilters({ all: !repo.filters.all })}
                  title={repo.filters.all ? 'Showing every branch' : 'Showing the current branch only'}
                >
                  {repo.filters.all ? 'All branches' : 'Current branch'}
                </button>
                <span style={{ fontSize: 10.5, color: 'var(--text-muted)', flexShrink: 0 }}>
                  {repo.commits.length}
                  {repo.hasMore ? '+' : ''} commits
                </span>
              </div>

              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <GitLogList
                  commits={repo.commits}
                  graph={repo.graph}
                  lanes={repo.graphLanes}
                  selected={selected}
                  onSelect={setSelected}
                  onContextMenu={commitMenu}
                  workingCount={workingCount}
                  hasMore={repo.hasMore}
                  loadingMore={repo.loadingMore}
                  onLoadMore={repo.loadMore}
                  emptyMessage={repo.loading ? 'Loading history…' : 'No commits yet'}
                />

                {selected && selected !== WORKING_ROW && (
                  <>
                    <div
                      onMouseDown={(e) => {
                        dragRef.current = { kind: 'detail', start: e.clientY, initial: detailHeight };
                        document.body.style.cursor = 'row-resize';
                      }}
                      style={{ height: 4, cursor: 'row-resize', background: 'var(--border)', flexShrink: 0 }}
                    />
                    <div style={{ height: detailHeight, flexShrink: 0, display: 'flex', minHeight: 0 }}>
                      <GitCommitView repo={root!} sha={selected} onSelectCommit={setSelected} inlineDiff={inlineDiff} diffFontSize={diffFontSize} />
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {menu && <IDEContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {prompt && (
        <GitPrompt
          state={prompt}
          onCancel={() => setPrompt(null)}
          onConfirm={(value) => {
            setPrompt(null);
            prompt.onConfirm(value);
          }}
        />
      )}
    </PaneShell>
  );
};

/** Pane chrome: the drag handle, close/focus/split buttons and toolbar slot. */
const PaneShell: React.FC<{
  containerId: string;
  title: React.ReactNode;
  toolbar?: React.ReactNode;
  onClose: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  children: React.ReactNode;
}> = ({ containerId, title, toolbar, onClose, onSplitRight, onSplitDown, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--bg-primary)', overflow: 'hidden', position: 'relative' }}>
    <div
      className="container-drag-handle"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
        height: 32, minHeight: 32, background: 'var(--bg-titlebar)',
        borderBottom: '1px solid var(--border)', userSelect: 'none', cursor: 'grab',
      }}
    >
      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onClose}
        title="Close"
        style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--accent-red)', border: 'none', cursor: 'pointer', flexShrink: 0, opacity: 0.7 }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
      />
      <PaneFocusButton containerId={containerId} />
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
        {title}
      </span>
      <span style={{ flex: 1 }} />
      <span
        onMouseDown={(e) => e.stopPropagation()}
        style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}
      >
        {toolbar}
      </span>
      <button onMouseDown={(e) => e.stopPropagation()} onClick={onSplitRight} title="Split right" style={iconButton}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        <SplitHorizontalIcon size={14} />
      </button>
      <button onMouseDown={(e) => e.stopPropagation()} onClick={onSplitDown} title="Split down" style={iconButton}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        <SplitVerticalIcon size={14} />
      </button>
    </div>
    {children}
  </div>
);

/** One-field modal for the actions that need a name or a typed confirmation. */
const GitPrompt: React.FC<{
  state: PromptState;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}> = ({ state, onCancel, onConfirm }) => {
  const [value, setValue] = useState(state.value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      onMouseDown={onCancel}
      style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 30 }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: 360, maxWidth: '90%', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}
      >
        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>{state.title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>{state.label}</div>
        <input
          ref={inputRef}
          className="git-input"
          value={value}
          placeholder={state.placeholder}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onConfirm(value.trim());
            if (e.key === 'Escape') onCancel();
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button style={{ ...toolbarButton(), border: '1px solid var(--border)', height: 24, padding: '0 10px' }} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={{
              ...toolbarButton(),
              border: `1px solid ${state.danger ? 'var(--accent-red)' : 'var(--accent)'}`,
              color: state.danger ? 'var(--accent-red)' : 'var(--accent-light)',
              height: 24,
              padding: '0 10px',
            }}
            onClick={() => onConfirm(value.trim())}
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
