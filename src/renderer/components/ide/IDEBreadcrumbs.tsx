import React from 'react';

interface Props {
  rootPath: string;
  filePath: string | null;
}

export const IDEBreadcrumbs: React.FC<Props> = ({ rootPath, filePath }) => {
  if (!filePath) return null;

  // Show path relative to root
  let relative = filePath;
  if (filePath.startsWith(rootPath)) {
    relative = filePath.slice(rootPath.length).replace(/^\//, '');
  }

  const segments = relative.split('/').filter(Boolean);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 26,
        minHeight: 26,
        padding: '0 12px',
        fontSize: 12,
        color: 'var(--text-muted)',
        background: 'var(--bg-editor)',
        borderBottom: '1px solid var(--border)',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        gap: 2,
        userSelect: 'none',
      }}
    >
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span style={{ margin: '0 2px', opacity: 0.5, fontSize: 10 }}>›</span>
          )}
          <span
            style={{
              color: i === segments.length - 1 ? 'var(--text-primary)' : undefined,
              fontWeight: i === segments.length - 1 ? 500 : undefined,
            }}
          >
            {seg}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
};
