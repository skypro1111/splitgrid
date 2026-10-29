import React from 'react';

// The composer's autocomplete popup: `/` commands and `@` paths. Sits above the
// composer, keyboard-first — the mouse is optional, since the user is typing.

export interface CompleteItem {
  /** Text inserted in place of the trigger token. */
  value: string;
  label: string;
  hint?: string;
  description?: string;
  isDirectory?: boolean;
}

export const AgentCompleteMenu: React.FC<{
  items: CompleteItem[];
  activeIndex: number;
  title: string;
  onPick: (item: CompleteItem) => void;
  onHover: (index: number) => void;
}> = ({ items, activeIndex, title, onPick, onHover }) => {
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // Keep the keyboard selection visible without stealing focus from the input.
  React.useEffect(() => {
    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    <div
      style={{
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        maxHeight: 240,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 12px 3px',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 0.6,
          color: 'var(--text-muted)',
          flexShrink: 0,
        }}
      >
        <span>{title}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontWeight: 500, letterSpacing: 0 }}>↑↓ move · ⇥ insert · esc close</span>
      </div>
      <div ref={listRef} style={{ overflowY: 'auto', minHeight: 0 }}>
        {items.map((item, index) => (
          <button
            key={item.value}
            // Mouse-down would blur the textarea before the click lands, which
            // closes the menu and loses the caret; pick on mouse-down instead.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(item);
            }}
            onMouseEnter={() => onHover(index)}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              width: '100%',
              padding: '5px 12px',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              background: index === activeIndex ? 'var(--bg-hover)' : 'transparent',
              color: 'var(--text-primary)',
              fontSize: 12,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                flexShrink: 0,
                color: item.isDirectory ? 'var(--accent-blue)' : 'var(--text-primary)',
                maxWidth: '60%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.label}
              {item.isDirectory ? '/' : ''}
            </span>
            {item.hint && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                {item.hint}
              </span>
            )}
            {item.description && (
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};
