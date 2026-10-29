import React, { useEffect, useMemo, useState } from 'react';
import type { GitCommitDetail, GitDiffSource } from '../../../shared/git-types';
import { GitFileList, type GitFileRow } from './GitFileList';
import { GitDiffEditor } from './GitDiffEditor';
import { GitRefBadge } from './GitRefBadge';
import { useGitDiff } from './useGitDiff';
import { fullTimestamp, shortSha } from './format';
import './git-pane.css';

interface Props {
  repo: string;
  sha: string;
  /** Clicking a parent sha navigates the log there. */
  onSelectCommit: (sha: string) => void;
  inlineDiff: boolean;
  /** Diff editor font size, following the pane's zoom level. */
  diffFontSize: number;
}

const META_ROW: React.CSSProperties = { display: 'flex', gap: 6, fontSize: 11, lineHeight: '16px' };
const META_KEY: React.CSSProperties = { width: 54, flexShrink: 0, color: 'var(--text-muted)' };

/** The selected commit: message and metadata, its files, and the chosen file's diff. */
export const GitCommitView: React.FC<Props> = ({ repo, sha, onSelectCommit, inlineDiff, diffFontSize }) => {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitFileRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setSelectedFile(null);
    window.electronAPI
      .gitCommitDetail(repo, sha)
      .then((loaded) => {
        if (cancelled) return;
        setDetail(loaded);
        // Open the first file straight away — an empty diff pane next to a file
        // list is a click nobody wants to make.
        setSelectedFile(loaded.files[0] ?? null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e?.message ?? 'Failed to load commit');
      });
    return () => {
      cancelled = true;
    };
  }, [repo, sha]);

  const source = useMemo<GitDiffSource>(() => ({ kind: 'commit', sha }), [sha]);
  const { diff, loading } = useGitDiff(repo, selectedFile ? source : null, selectedFile?.path ?? null, selectedFile?.origPath ?? null);

  const files: GitFileRow[] = detail?.files ?? [];

  if (error) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-red)', fontSize: 12 }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div
        className="git-scroll"
        style={{ width: 320, flexShrink: 0, borderRight: '1px solid var(--border)', overflow: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, wordBreak: 'break-word' }}>
            {detail?.commit.subject ?? 'Loading…'}
          </div>

          {!!detail?.commit.refs.length && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {detail.commit.refs.map((ref) => (
                <GitRefBadge key={`${ref.kind}:${ref.name}`} label={ref} />
              ))}
            </div>
          )}

          {detail?.commit.body && (
            <pre
              style={{
                margin: '4px 0 8px',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 140,
                overflow: 'auto',
              }}
            >
              {detail.commit.body}
            </pre>
          )}

          {detail && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={META_ROW}>
                <span style={META_KEY}>commit</span>
                <span
                  title="Click to copy"
                  onClick={() => void navigator.clipboard.writeText(detail.commit.sha)}
                  style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', cursor: 'pointer' }}
                >
                  {shortSha(detail.commit.sha, 10)}
                </span>
              </div>
              <div style={META_ROW}>
                <span style={META_KEY}>author</span>
                <span style={{ color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {detail.commit.authorName} &lt;{detail.commit.authorEmail}&gt;
                </span>
              </div>
              <div style={META_ROW}>
                <span style={META_KEY}>date</span>
                <span style={{ color: 'var(--text-secondary)' }}>{fullTimestamp(detail.commit.authorDate)}</span>
              </div>
              {detail.commit.parents.length > 0 && (
                <div style={META_ROW}>
                  <span style={META_KEY}>{detail.commit.parents.length > 1 ? 'parents' : 'parent'}</span>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {detail.commit.parents.map((parent) => (
                      <span
                        key={parent}
                        onClick={() => onSelectCommit(parent)}
                        title={parent}
                        style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-blue)', cursor: 'pointer' }}
                      >
                        {shortSha(parent)}
                      </span>
                    ))}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          <span style={{ flex: 1 }}>Files</span>
          <span>{files.length}</span>
        </div>

        <GitFileList
          files={files}
          selected={selectedFile?.path ?? null}
          onSelect={setSelectedFile}
          emptyMessage={detail ? 'No file changes' : 'Loading…'}
        />
      </div>

      <GitDiffEditor diff={diff} loading={loading} inline={inlineDiff} fontSize={diffFontSize} />
    </div>
  );
};
