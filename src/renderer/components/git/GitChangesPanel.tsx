import React, { useMemo, useState } from 'react';
import type { GitCommandResult, GitDiffSource, GitStatus, GitStatusFile } from '../../../shared/git-types';
import { GitFileList, type GitFileAction, type GitFileRow } from './GitFileList';
import { GitDiffEditor } from './GitDiffEditor';
import { useGitDiff } from './useGitDiff';
import './git-pane.css';

interface Props {
  repo: string;
  status: GitStatus | null;
  inlineDiff: boolean;
  /** Diff editor font size, following the pane's zoom level. */
  diffFontSize: number;
  busy: boolean;
  /** Runs a git command, surfaces its error, and refreshes the pane. */
  run: (fn: () => Promise<GitCommandResult>) => Promise<boolean>;
}

const SECTION_HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  background: 'var(--bg-surface)',
  borderTop: '1px solid var(--border-subtle)',
  borderBottom: '1px solid var(--border-subtle)',
  position: 'sticky',
  top: 0,
  zIndex: 1,
};

const smallButton = (accent?: string): React.CSSProperties => ({
  padding: '3px 8px',
  borderRadius: 4,
  fontSize: 10.5,
  fontWeight: 600,
  background: 'transparent',
  border: `1px solid ${accent ?? 'var(--border)'}`,
  color: accent ?? 'var(--text-secondary)',
  cursor: 'pointer',
});

const toRow = (file: GitStatusFile, side: 'index' | 'worktree'): GitFileRow => ({
  path: file.path,
  origPath: file.origPath,
  status: file.untracked ? '?' : side === 'index' ? file.index : file.worktree,
});

/** Working copy: stage, unstage, discard, commit and stash. */
export const GitChangesPanel: React.FC<Props> = ({ repo, status, inlineDiff, diffFontSize, busy, run }) => {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [selected, setSelected] = useState<{ path: string; staged: boolean; origPath: string | null } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<GitFileRow[] | null>(null);
  // Staging does not change the file path, but it does change its diff.
  const [diffNonce, setDiffNonce] = useState(0);

  const staged = useMemo(() => (status?.files ?? []).filter((f) => f.staged).map((f) => toRow(f, 'index')), [status]);
  const unstaged = useMemo(
    () => (status?.files ?? []).filter((f) => f.unstaged && !f.ignored).map((f) => toRow(f, 'worktree')),
    [status]
  );
  const untrackedPaths = useMemo(
    () => new Set((status?.files ?? []).filter((f) => f.untracked).map((f) => f.path)),
    [status]
  );

  const source = useMemo<GitDiffSource | null>(
    () => (selected ? (selected.staged ? { kind: 'staged' } : { kind: 'unstaged' }) : null),
    [selected]
  );
  const { diff, loading } = useGitDiff(repo, source, selected?.path ?? null, selected?.origPath ?? null, diffNonce);

  const after = async (ok: boolean) => {
    if (ok) setDiffNonce((n) => n + 1);
    return ok;
  };

  const stagePaths = (paths: string[]) => run(() => window.electronAPI.gitStage(repo, paths)).then(after);
  const unstagePaths = (paths: string[]) => run(() => window.electronAPI.gitUnstage(repo, paths)).then(after);

  const doDiscard = async (rows: GitFileRow[]) => {
    const tracked = rows.filter((r) => !untrackedPaths.has(r.path)).map((r) => r.path);
    const untracked = rows.filter((r) => untrackedPaths.has(r.path)).map((r) => r.path);
    setConfirmDiscard(null);
    await run(() => window.electronAPI.gitDiscard(repo, tracked, untracked));
    setDiffNonce((n) => n + 1);
  };

  const doCommit = async () => {
    const ok = await run(() => window.electronAPI.gitCommit(repo, message, { amend }));
    if (ok) {
      setMessage('');
      setAmend(false);
      setSelected(null);
    }
  };

  const stagedActions: GitFileAction[] = [
    { key: 'unstage', label: 'Unstage', glyph: '−', run: (file) => void unstagePaths([file.path]) },
  ];
  const unstagedActions: GitFileAction[] = [
    { key: 'discard', label: 'Discard changes', glyph: '⨯', danger: true, run: (file) => setConfirmDiscard([file]) },
    { key: 'stage', label: 'Stage', glyph: '+', run: (file) => void stagePaths([file.path]) },
  ];

  const nothingToShow = !staged.length && !unstaged.length;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ width: 340, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, borderBottom: '1px solid var(--border-subtle)' }}>
          <textarea
            className="git-input"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter commits, the way every git GUI does it.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (staged.length || amend) void doCommit();
              }
              e.stopPropagation();
            }}
            placeholder={amend ? 'Amend the last commit…' : 'Commit message'}
            rows={3}
            spellCheck={false}
            style={{ resize: 'vertical', minHeight: 46, fontFamily: 'var(--font-sans)' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} style={{ margin: 0 }} />
              Amend
            </label>
            <span style={{ flex: 1 }} />
            <button
              style={smallButton()}
              disabled={busy || (!staged.length && !unstaged.length)}
              title="Stash all changes"
              onClick={() =>
                void run(() =>
                  window.electronAPI.gitStashPush(repo, { message: message.trim() || undefined, includeUntracked: true })
                ).then((ok) => ok && setMessage(''))
              }
            >
              Stash
            </button>
            <button
              style={{
                ...smallButton('var(--accent)'),
                background: staged.length || amend ? 'rgba(34,141,242,0.15)' : 'transparent',
                opacity: busy || (!staged.length && !amend) ? 0.5 : 1,
              }}
              disabled={busy || (!staged.length && !amend)}
              onClick={() => void doCommit()}
              title="Commit staged changes (⌘/Ctrl+Enter)"
            >
              Commit
            </button>
          </div>
        </div>

        {confirmDiscard && (
          <div style={{ padding: '6px 8px', background: 'rgba(241,76,76,0.12)', borderBottom: '1px solid var(--accent-red)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)' }}>
              Discard changes in {confirmDiscard.length} file{confirmDiscard.length > 1 ? 's' : ''}? This cannot be undone.
            </span>
            <button style={smallButton()} onClick={() => setConfirmDiscard(null)}>Cancel</button>
            <button style={smallButton('var(--accent-red)')} onClick={() => void doDiscard(confirmDiscard)}>Discard</button>
          </div>
        )}

        <div className="git-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div style={SECTION_HEADER}>
            <span style={{ flex: 1 }}>Staged</span>
            <span>{staged.length}</span>
            {staged.length > 0 && (
              <button
                style={{ ...smallButton(), padding: '1px 6px' }}
                onClick={() => void unstagePaths(staged.map((f) => f.path))}
                title="Unstage everything"
              >
                Unstage all
              </button>
            )}
          </div>
          <GitFileList
            files={staged}
            selected={selected?.staged ? selected.path : null}
            onSelect={(file) => setSelected({ path: file.path, staged: true, origPath: file.origPath ?? null })}
            actions={stagedActions}
            emptyMessage="Nothing staged"
          />

          <div style={SECTION_HEADER}>
            <span style={{ flex: 1 }}>Changes</span>
            <span>{unstaged.length}</span>
            {unstaged.length > 0 && (
              <>
                <button
                  style={{ ...smallButton('var(--accent-red)'), padding: '1px 6px' }}
                  onClick={() => setConfirmDiscard(unstaged)}
                  title="Discard every unstaged change"
                >
                  Discard all
                </button>
                <button
                  style={{ ...smallButton(), padding: '1px 6px' }}
                  onClick={() => void stagePaths(unstaged.map((f) => f.path))}
                  title="Stage everything"
                >
                  Stage all
                </button>
              </>
            )}
          </div>
          <GitFileList
            files={unstaged}
            selected={selected && !selected.staged ? selected.path : null}
            onSelect={(file) => setSelected({ path: file.path, staged: false, origPath: file.origPath ?? null })}
            actions={unstagedActions}
            emptyMessage={nothingToShow ? 'Working tree clean' : 'No unstaged changes'}
          />
        </div>
      </div>

      <GitDiffEditor diff={diff} loading={loading} inline={inlineDiff} fontSize={diffFontSize} />
    </div>
  );
};
