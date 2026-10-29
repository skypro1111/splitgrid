import React, { useMemo, useState } from 'react';
import type {
  GitBranch,
  GitRepoInfo,
  GitStashEntry,
  GitTag,
  GitWorktree,
} from '../../../shared/git-types';
import { relativeTime, shortSha } from './format';
import './git-pane.css';

export type GitRefTarget =
  | { kind: 'branch'; branch: GitBranch }
  | { kind: 'tag'; tag: GitTag }
  | { kind: 'worktree'; worktree: GitWorktree }
  | { kind: 'stash'; stash: GitStashEntry };

interface Props {
  info: GitRepoInfo | null;
  branches: GitBranch[];
  tags: GitTag[];
  worktrees: GitWorktree[];
  stashes: GitStashEntry[];
  collapsed: string[];
  onToggleSection: (id: string) => void;
  /** Left-click: bring that ref's tip into view in the log. */
  onSelectRef: (target: GitRefTarget) => void;
  onContextMenu: (target: GitRefTarget, x: number, y: number) => void;
  onCreateBranch: () => void;
  onAddWorktree: () => void;
  /** The ref whose tip is currently selected in the log, for highlighting. */
  activeSha: string | null;
}

const SECTION_LABEL: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  height: 22,
  padding: '0 6px',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  cursor: 'default',
  userSelect: 'none',
};

const ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  height: 21,
  padding: '0 6px 0 18px',
  fontSize: 11.5,
  cursor: 'default',
  userSelect: 'none',
  color: 'var(--text-secondary)',
};

const Section: React.FC<{
  id: string;
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: (id: string) => void;
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}> = ({ id, title, count, collapsed, onToggle, action, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column' }}>
    <div
      style={SECTION_LABEL}
      onClick={() => onToggle(id)}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
    >
      <span style={{ width: 10, textAlign: 'center', fontSize: 8 }}>{collapsed ? '▶' : '▼'}</span>
      <span style={{ flex: 1 }}>{title}</span>
      <span style={{ opacity: 0.7 }}>{count}</span>
      {action && (
        <button
          title={action.label}
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
          style={{
            width: 16, height: 16, border: 'none', borderRadius: 3, background: 'transparent',
            color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          +
        </button>
      )}
    </div>
    {!collapsed && children}
  </div>
);

const Row: React.FC<{
  active: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  title?: string;
  children: React.ReactNode;
}> = ({ active, onClick, onContextMenu, title, children }) => (
  <div
    title={title}
    onClick={onClick}
    onContextMenu={onContextMenu}
    style={{ ...ROW, background: active ? 'var(--list-active)' : 'transparent', color: active ? 'var(--text-primary)' : ROW.color }}
    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--list-hover)'; }}
    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
  >
    {children}
  </div>
);

/** Ahead/behind counters next to a tracking branch. */
const TrackBadge: React.FC<{ ahead: number; behind: number }> = ({ ahead, behind }) => {
  if (!ahead && !behind) return null;
  return (
    <span style={{ display: 'flex', gap: 4, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', flexShrink: 0 }}>
      {!!ahead && <span title={`${ahead} ahead of upstream`}>↑{ahead}</span>}
      {!!behind && <span title={`${behind} behind upstream`}>↓{behind}</span>}
    </span>
  );
};

export const GitSidebar: React.FC<Props> = ({
  info,
  branches,
  tags,
  worktrees,
  stashes,
  collapsed,
  onToggleSection,
  onSelectRef,
  onContextMenu,
  onCreateBranch,
  onAddWorktree,
  activeSha,
}) => {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);

  const local = useMemo(
    () => branches.filter((b) => !b.isRemote && matches(b.name)).sort((a, b) => b.date - a.date),
    [branches, needle]
  );
  // Remote branches are grouped under their remote, the way `git branch -r` reads.
  const remoteGroups = useMemo(() => {
    const groups = new Map<string, GitBranch[]>();
    for (const branch of branches) {
      if (!branch.isRemote || !matches(branch.name)) continue;
      const remote = branch.name.slice(0, branch.name.indexOf('/'));
      const list = groups.get(remote) ?? [];
      list.push(branch);
      groups.set(remote, list);
    }
    for (const list of groups.values()) list.sort((a, b) => b.date - a.date);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [branches, needle]);

  const visibleTags = useMemo(
    () => tags.filter((t) => matches(t.name)).sort((a, b) => b.date - a.date),
    [tags, needle]
  );
  const visibleWorktrees = useMemo(
    () => worktrees.filter((w) => matches(w.path) || matches(w.branch ?? '')),
    [worktrees, needle]
  );

  const isCollapsed = (id: string) => collapsed.includes(id);

  return (
    <div
      className="git-scroll"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto', background: 'var(--bg-sidebar)' }}
    >
      <div style={{ padding: '6px 6px 4px', position: 'sticky', top: 0, background: 'var(--bg-sidebar)', zIndex: 1 }}>
        <input
          className="git-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter refs…"
          spellCheck={false}
        />
      </div>

      <Section
        id="branches"
        title="Branches"
        count={local.length}
        collapsed={isCollapsed('branches')}
        onToggle={onToggleSection}
        action={{ label: 'New branch', onClick: onCreateBranch }}
      >
        {local.map((branch) => (
          <Row
            key={branch.fullName}
            active={activeSha === branch.sha}
            onClick={() => onSelectRef({ kind: 'branch', branch })}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu({ kind: 'branch', branch }, e.clientX, e.clientY);
            }}
            title={`${branch.name}${branch.upstream ? ` → ${branch.upstream}` : ''}\n${branch.subject}`}
          >
            <span style={{ width: 8, color: 'var(--accent-green)', flexShrink: 0 }}>
              {branch.isHead ? '◉' : ''}
            </span>
            <span
              style={{
                flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontWeight: branch.isHead ? 700 : 400,
                color: branch.isHead ? 'var(--text-primary)' : undefined,
              }}
            >
              {branch.name}
            </span>
            {branch.worktreePath && !branch.isHead && (
              <span title={`Checked out in ${branch.worktreePath}`} style={{ fontSize: 9, color: 'var(--accent-orange)', flexShrink: 0 }}>
                wt
              </span>
            )}
            <TrackBadge ahead={branch.ahead} behind={branch.behind} />
          </Row>
        ))}
      </Section>

      <Section
        id="remotes"
        title="Remotes"
        count={remoteGroups.reduce((n, [, list]) => n + list.length, 0)}
        collapsed={isCollapsed('remotes')}
        onToggle={onToggleSection}
      >
        {remoteGroups.map(([remote, list]) => (
          <div key={remote}>
            <div style={{ ...ROW, paddingLeft: 18, color: 'var(--text-muted)', fontSize: 10.5 }}>{remote}</div>
            {list.map((branch) => (
              <Row
                key={branch.fullName}
                active={activeSha === branch.sha}
                onClick={() => onSelectRef({ kind: 'branch', branch })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu({ kind: 'branch', branch }, e.clientX, e.clientY);
                }}
                title={branch.subject}
              >
                <span style={{ paddingLeft: 10, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {branch.name.slice(remote.length + 1)}
                </span>
              </Row>
            ))}
          </div>
        ))}
      </Section>

      <Section id="tags" title="Tags" count={visibleTags.length} collapsed={isCollapsed('tags')} onToggle={onToggleSection}>
        {visibleTags.map((tag) => (
          <Row
            key={tag.fullName}
            active={activeSha === tag.sha}
            onClick={() => onSelectRef({ kind: 'tag', tag })}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu({ kind: 'tag', tag }, e.clientX, e.clientY);
            }}
            title={`${tag.name}\n${tag.subject}`}
          >
            <span style={{ color: 'var(--accent-yellow)', flexShrink: 0, fontSize: 10 }}>#</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag.name}</span>
            <span style={{ fontSize: 9.5, color: 'var(--text-muted)', flexShrink: 0 }}>{relativeTime(tag.date)}</span>
          </Row>
        ))}
      </Section>

      <Section
        id="worktrees"
        title="Worktrees"
        count={visibleWorktrees.length}
        collapsed={isCollapsed('worktrees')}
        onToggle={onToggleSection}
        action={{ label: 'Add worktree', onClick: onAddWorktree }}
      >
        {visibleWorktrees.map((worktree) => {
          const name = worktree.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? worktree.path;
          return (
            <Row
              key={worktree.path}
              active={worktree.isCurrent}
              onClick={() => onSelectRef({ kind: 'worktree', worktree })}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu({ kind: 'worktree', worktree }, e.clientX, e.clientY);
              }}
              title={`${worktree.path}\n${worktree.branch ?? (worktree.detached ? 'detached' : '')}`}
            >
              <span style={{ width: 8, flexShrink: 0, color: 'var(--accent-blue)' }}>{worktree.isCurrent ? '▸' : ''}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {worktree.branch ?? name}
              </span>
              {worktree.isMain && <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>main</span>}
              {worktree.locked && <span title="Locked" style={{ fontSize: 9, color: 'var(--accent-orange)', flexShrink: 0 }}>🔒</span>}
              {worktree.prunable && <span title="Prunable — its directory is gone" style={{ fontSize: 9, color: 'var(--accent-red)', flexShrink: 0 }}>!</span>}
            </Row>
          );
        })}
      </Section>

      <Section id="stashes" title="Stashes" count={stashes.length} collapsed={isCollapsed('stashes')} onToggle={onToggleSection}>
        {stashes.map((stash) => (
          <Row
            key={stash.ref}
            active={activeSha === stash.sha}
            onClick={() => onSelectRef({ kind: 'stash', stash })}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu({ kind: 'stash', stash }, e.clientX, e.clientY);
            }}
            title={`${stash.ref}${stash.branch ? ` (on ${stash.branch})` : ''}\n${stash.message}`}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {stash.message || stash.ref}
            </span>
            <span style={{ fontSize: 9.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
              {shortSha(stash.sha, 6)}
            </span>
          </Row>
        ))}
      </Section>

      {info && (
        <div style={{ marginTop: 'auto', padding: '8px 8px 10px', fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={info.root}>
            {info.root}
          </div>
        </div>
      )}
    </div>
  );
};
