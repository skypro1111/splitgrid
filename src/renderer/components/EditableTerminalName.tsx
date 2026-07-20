import React, { useState } from 'react';

// The terminal's name in its pane header: shows the user-set custom name when
// present, otherwise the auto-derived label. Click to rename inline (Enter
// saves, Escape cancels, empty resets to the auto name). Read-only when no
// onRename is provided. Replaces the old LOCAL/SSH type badge.

interface EditableTerminalNameProps {
  customName?: string;
  autoLabel: string;
  onRename?: (name: string | null) => void;
}

export const EditableTerminalName: React.FC<EditableTerminalNameProps> = ({ customName, autoLabel, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const display = customName?.trim() || autoLabel;

  const start = () => {
    if (!onRename) return;
    setValue(customName ?? '');
    setEditing(true);
  };
  const finish = () => {
    if (editing) {
      const name = value.trim();
      onRename?.(name.length > 0 ? name : null);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        value={value}
        placeholder={autoLabel}
        onChange={(e) => setValue(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); finish(); }
          else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={{
          fontSize: '11px', fontWeight: 600, padding: '1px 5px', borderRadius: 3,
          background: 'var(--bg-primary)', border: '1px solid var(--accent)',
          color: 'var(--text-primary)', outline: 'none', minWidth: 60, maxWidth: 180,
        }}
      />
    );
  }

  return (
    <span
      onMouseDown={onRename ? (e) => e.stopPropagation() : undefined}
      onClick={onRename ? (e) => { e.stopPropagation(); start(); } : undefined}
      title={onRename ? `${display} — click to rename` : display}
      style={{
        fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        cursor: onRename ? 'text' : 'default', flexShrink: 1, minWidth: 0,
        padding: '1px 4px', borderRadius: 3, transition: 'background 0.1s',
      }}
      onMouseEnter={onRename ? (e) => { e.currentTarget.style.background = 'var(--bg-hover)'; } : undefined}
      onMouseLeave={onRename ? (e) => { e.currentTarget.style.background = 'transparent'; } : undefined}
    >
      {display}
    </span>
  );
};
