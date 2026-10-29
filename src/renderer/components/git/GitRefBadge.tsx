import React from 'react';
import type { GitRefLabel } from '../../../shared/git-types';

const STYLES: Record<string, { bg: string; fg: string; border: string }> = {
  head: { bg: 'rgba(34,141,242,0.22)', fg: '#7fc0ff', border: 'rgba(34,141,242,0.55)' },
  branch: { bg: 'rgba(21,172,145,0.16)', fg: '#3fd0b3', border: 'rgba(21,172,145,0.45)' },
  remote: { bg: 'rgba(122,121,122,0.18)', fg: '#a9a8a9', border: 'rgba(122,121,122,0.45)' },
  tag: { bg: 'rgba(229,185,92,0.16)', fg: '#e5b95c', border: 'rgba(229,185,92,0.45)' },
  stash: { bg: 'rgba(91,81,236,0.18)', fg: '#9d94ff', border: 'rgba(91,81,236,0.5)' },
  other: { bg: 'rgba(122,121,122,0.18)', fg: '#a9a8a9', border: 'rgba(122,121,122,0.45)' },
};

/** One ref decoration pill next to a commit's subject. */
export const GitRefBadge: React.FC<{ label: GitRefLabel }> = React.memo(({ label }) => {
  const tone = STYLES[label.isHead && label.kind !== 'tag' ? 'head' : label.kind] ?? STYLES.other;
  return (
    <span
      title={label.kind === 'tag' ? `tag: ${label.name}` : label.name}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        maxWidth: 180,
        padding: '0 5px',
        height: 15,
        borderRadius: 3,
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
        fontSize: 10,
        fontWeight: 600,
        lineHeight: '13px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 0,
      }}
    >
      {label.kind === 'tag' && <span style={{ opacity: 0.7 }}>#</span>}
      {label.isHead && label.kind !== 'tag' && <span style={{ opacity: 0.9 }}>◉</span>}
      {label.name}
    </span>
  );
});
GitRefBadge.displayName = 'GitRefBadge';
