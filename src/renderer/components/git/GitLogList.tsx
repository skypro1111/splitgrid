import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { GitCommit } from '../../../shared/git-types';
import type { GraphRow } from '../../../shared/git-graph';
import { GitGraphCell, GitGraphWorkingCell, LANE_WIDTH, ROW_HEIGHT } from './GitGraphCell';
import { GitRefBadge } from './GitRefBadge';
import { authorColor, fullTimestamp, initials, relativeTime, shortSha } from './format';

/** The uncommitted-changes row is addressed by this sentinel instead of a sha. */
export const WORKING_ROW = '__working__';

interface Props {
  commits: GitCommit[];
  graph: GraphRow[];
  lanes: number;
  selected: string | null;
  onSelect: (sha: string) => void;
  onContextMenu: (sha: string, x: number, y: number) => void;
  /** Number of changed files, or 0 to hide the uncommitted row. */
  workingCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  emptyMessage?: string;
}

const COL_AUTHOR = 130;
const COL_DATE = 78;
const COL_SHA = 62;

export const GitLogList: React.FC<Props> = ({
  commits,
  graph,
  lanes,
  selected,
  onSelect,
  onContextMenu,
  workingCount,
  hasMore,
  loadingMore,
  onLoadMore,
  emptyMessage,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const showWorking = workingCount > 0;
  const offset = showWorking ? 1 : 0;
  const count = commits.length + offset;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1].index : 0;

  // Pull the next page in as the bottom comes into view.
  useEffect(() => {
    if (!hasMore || loadingMore) return;
    if (lastIndex >= count - 5) onLoadMore();
  }, [lastIndex, count, hasMore, loadingMore, onLoadMore]);

  // The uncommitted row hangs off HEAD's lane so it reads as part of the graph.
  const headLane = useMemo(() => (graph.length ? graph[0].lane : 0), [graph]);
  const headColor = useMemo(() => (graph.length ? graph[0].color : 0), [graph]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const currentIndex = selected === WORKING_ROW ? 0 : commits.findIndex((c) => c.sha === selected) + offset;
      const next = Math.max(0, Math.min(count - 1, currentIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      const sha = showWorking && next === 0 ? WORKING_ROW : commits[next - offset]?.sha;
      if (sha) {
        onSelect(sha);
        virtualizer.scrollToIndex(next, { align: 'auto' });
      }
    },
    [commits, count, offset, onSelect, selected, showWorking, virtualizer]
  );

  if (!commits.length && !showWorking) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
        {emptyMessage ?? 'No commits'}
      </div>
    );
  }

  const graphWidthPx = Math.max(lanes, 1) * LANE_WIDTH + 8;

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="git-log-scroll"
      style={{ flex: 1, minHeight: 0, overflow: 'auto', outline: 'none', position: 'relative' }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {items.map((item) => {
          const isWorkingRow = showWorking && item.index === 0;
          const commit = isWorkingRow ? null : commits[item.index - offset];
          const row = isWorkingRow ? null : graph[item.index - offset];
          if (!isWorkingRow && (!commit || !row)) return null;

          const sha = isWorkingRow ? WORKING_ROW : commit!.sha;
          const isSelected = selected === sha;

          return (
            <div
              key={sha}
              onClick={() => onSelect(sha)}
              onContextMenu={(e) => {
                e.preventDefault();
                onSelect(sha);
                onContextMenu(sha, e.clientX, e.clientY);
              }}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                transform: `translateY(${item.start}px)`,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 10px 0 4px',
                fontSize: 11.5,
                cursor: 'default',
                userSelect: 'none',
                background: isSelected ? 'var(--list-active)' : 'transparent',
                color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
              onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'var(--list-hover)';
              }}
              onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'transparent';
              }}
            >
              <div style={{ width: graphWidthPx, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                {isWorkingRow ? (
                  <GitGraphWorkingCell lane={headLane} lanes={lanes} color={headColor} />
                ) : (
                  <GitGraphCell row={row!} lanes={lanes} />
                )}
              </div>

              {isWorkingRow ? (
                <span style={{ flex: 1, color: 'var(--accent-yellow)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Uncommitted changes ({workingCount})
                </span>
              ) : (
                <>
                  {commit!.refs.length > 0 && (
                    <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0, maxWidth: '45%', overflow: 'hidden' }}>
                      {commit!.refs.map((ref) => (
                        <GitRefBadge key={`${ref.kind}:${ref.name}`} label={ref} />
                      ))}
                    </span>
                  )}
                  <span
                    title={commit!.subject}
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {commit!.subject}
                  </span>
                  <span
                    title={`${commit!.authorName} <${commit!.authorEmail}>`}
                    style={{
                      width: COL_AUTHOR,
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      color: 'var(--text-muted)',
                      overflow: 'hidden',
                    }}
                  >
                    <span
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        background: authorColor(commit!.authorEmail),
                        color: '#fff',
                        fontSize: 8,
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {initials(commit!.authorName)}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {commit!.authorName}
                    </span>
                  </span>
                  <span
                    title={fullTimestamp(commit!.authorDate)}
                    style={{ width: COL_DATE, flexShrink: 0, color: 'var(--text-muted)', textAlign: 'right' }}
                  >
                    {relativeTime(commit!.authorDate)}
                  </span>
                  <span
                    style={{
                      width: COL_SHA,
                      flexShrink: 0,
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      textAlign: 'right',
                    }}
                  >
                    {shortSha(commit!.sha)}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>

      {loadingMore && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)' }}>Loading more…</div>
      )}
    </div>
  );
};
