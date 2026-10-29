import React from 'react';
import { splitPath, statusLabel } from './format';
import './git-pane.css';

export interface GitFileRow {
  path: string;
  origPath?: string | null;
  /** Status letter as git reports it: A, M, D, R, C, T, U, ?. */
  status: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitFileAction {
  key: string;
  label: string;
  glyph: string;
  danger?: boolean;
  run: (file: GitFileRow) => void;
}

interface Props {
  files: GitFileRow[];
  selected: string | null;
  onSelect: (file: GitFileRow) => void;
  /** Buttons revealed on row hover — stage, unstage, discard. */
  actions?: GitFileAction[];
  emptyMessage?: string;
  onContextMenu?: (file: GitFileRow, x: number, y: number) => void;
}

/** The file list shared by the commit detail and the working-copy panel. */
export const GitFileList: React.FC<Props> = ({ files, selected, onSelect, actions, emptyMessage, onContextMenu }) => {
  if (!files.length) {
    return (
      <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
        {emptyMessage ?? 'No files'}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {files.map((file) => {
        const isSelected = selected === file.path;
        const { dir, name } = splitPath(file.path);
        const status = statusLabel(file.status);
        return (
          <div
            key={file.path}
            className="git-file-row"
            onClick={() => onSelect(file)}
            onContextMenu={(e) => {
              if (!onContextMenu) return;
              e.preventDefault();
              onSelect(file);
              onContextMenu(file, e.clientX, e.clientY);
            }}
            title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 22,
              padding: '0 8px',
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
            <span
              title={status.title}
              style={{
                width: 12,
                flexShrink: 0,
                textAlign: 'center',
                color: status.color,
                fontFamily: 'var(--font-mono)',
                fontWeight: 700,
                fontSize: 10.5,
              }}
            >
              {status.text}
            </span>

            <span style={{ display: 'flex', minWidth: 0, alignItems: 'baseline', gap: 5, flex: 1 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
              {dir && (
                <span
                  style={{
                    color: 'var(--text-muted)',
                    fontSize: 10.5,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    direction: 'rtl',
                    minWidth: 0,
                  }}
                >
                  {dir}
                </span>
              )}
            </span>

            {file.binary ? (
              <span style={{ color: 'var(--text-muted)', fontSize: 10, flexShrink: 0 }}>bin</span>
            ) : (
              Boolean(file.additions || file.deletions) && (
                <span style={{ display: 'flex', gap: 5, flexShrink: 0, fontSize: 10, fontFamily: 'var(--font-mono)' }}>
                  {!!file.additions && <span style={{ color: 'var(--accent-green)' }}>+{file.additions}</span>}
                  {!!file.deletions && <span style={{ color: 'var(--accent-red)' }}>−{file.deletions}</span>}
                </span>
              )
            )}

            {actions && actions.length > 0 && (
              <span className="git-file-actions" style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                {actions.map((action) => (
                  <button
                    key={action.key}
                    title={action.label}
                    onClick={(e) => {
                      e.stopPropagation();
                      action.run(file);
                    }}
                    style={{
                      width: 18,
                      height: 18,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 3,
                      border: 'none',
                      background: 'transparent',
                      color: action.danger ? 'var(--accent-red)' : 'var(--text-muted)',
                      cursor: 'pointer',
                      fontSize: 12,
                      lineHeight: 1,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--bg-hover)';
                      if (!action.danger) e.currentTarget.style.color = 'var(--text-primary)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      if (!action.danger) e.currentTarget.style.color = 'var(--text-muted)';
                    }}
                  >
                    {action.glyph}
                  </button>
                ))}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};
