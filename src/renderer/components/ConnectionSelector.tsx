import React, { useMemo, useState } from 'react';
import type { SavedConnection } from '../../shared/types';

// Shared saved-connection picker used by BOTH embedded pickers — the SSH
// connect pane (SSHConnectPanel) and the SFTP connection chooser — so they look
// and behave identically: a search box over label / user@host:port, a "Recently
// used here" section on top (per-workspace recency), then "All connections",
// all in a scrollable premium list. The parent owns the empty state (no saved
// connections) and any surrounding chrome — this component assumes there is at
// least one saved connection and fills its flex container.

interface ConnectionSelectorProps {
  savedConnections: SavedConnection[];
  /** Connection ids used in this workspace, most-recent-first. */
  recentConnectionIds: string[];
  onSelect: (conn: SavedConnection) => void;
  /** When set, that row shows "Connecting…" and all rows are disabled. */
  connectingId?: string | null;
  /** Ids floated to the top of "All" (e.g. a freshly created connection). */
  pinnedIds?: string[];
  /** When provided, a delete affordance appears on row hover. */
  onDelete?: (conn: SavedConnection) => void;
  autoFocus?: boolean;
}

export const ConnectionSelector: React.FC<ConnectionSelectorProps> = ({
  savedConnections,
  recentConnectionIds,
  onSelect,
  connectingId,
  pinnedIds,
  onDelete,
  autoFocus = true,
}) => {
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  const byId = useMemo(() => new Map(savedConnections.map((c) => [c.id, c])), [savedConnections]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return () => true;
    return (c: SavedConnection) =>
      c.label.toLowerCase().includes(q) ||
      `${c.username}@${c.host}:${c.port}`.toLowerCase().includes(q);
  }, [query]);

  const recent = useMemo(
    () => recentConnectionIds
      .map((id) => byId.get(id))
      .filter((c): c is SavedConnection => !!c && matches(c)),
    [recentConnectionIds, byId, matches]
  );
  const recentSet = useMemo(() => new Set(recent.map((c) => c.id)), [recent]);

  const others = useMemo(() => {
    const pinned = (pinnedIds ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is SavedConnection => !!c && !recentSet.has(c.id) && matches(c));
    const pinnedSet = new Set(pinned.map((c) => c.id));
    const remaining = savedConnections.filter((c) => !recentSet.has(c.id) && !pinnedSet.has(c.id) && matches(c));
    return [...pinned, ...remaining];
  }, [savedConnections, recentSet, pinnedIds, byId, matches]);

  const noMatches = recent.length === 0 && others.length === 0;
  const disabled = connectingId != null;

  const renderRow = (c: SavedConnection) => (
    <ConnRow
      key={c.id}
      conn={c}
      connecting={connectingId === c.id}
      disabled={disabled}
      onSelect={() => onSelect(c)}
      onDelete={onDelete ? () => onDelete(c) : undefined}
    />
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Search */}
      <div style={{ padding: '0 16px 10px', flexShrink: 0 }}>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--text-muted)', pointerEvents: 'none' }}>⌕</span>
          <input
            autoFocus={autoFocus}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search connections…"
            style={{
              width: '100%', padding: '9px 32px 9px 30px', borderRadius: 9,
              background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, outline: 'none',
              border: `1px solid ${searchFocused ? 'var(--accent)' : 'var(--border)'}`,
              boxShadow: searchFocused ? '0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)' : 'none',
              transition: 'border-color 0.12s, box-shadow 0.12s',
            }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              title="Clear"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 20, height: 20, borderRadius: 5, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >×</button>
          )}
        </div>
      </div>

      {/* Scrollable list */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 16px 14px' }}>
        {noMatches ? (
          <div style={{ padding: '26px 12px', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
            No connections match “{query.trim()}”.
          </div>
        ) : (
          <>
            {recent.length > 0 && <Section title="Recently used here">{recent.map(renderRow)}</Section>}
            {others.length > 0 && (
              <Section title={recent.length > 0 ? 'All connections' : 'Saved connections'}>
                {others.map(renderRow)}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '4px 8px 8px' }}>
      {title}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
  </div>
);

const ConnRow: React.FC<{
  conn: SavedConnection;
  connecting: boolean;
  disabled: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}> = ({ conn, connecting, disabled, onSelect, onDelete }) => {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={disabled ? undefined : onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 11, padding: '9px 11px', borderRadius: 9,
        cursor: disabled ? 'default' : 'pointer',
        background: hovered && !disabled ? 'var(--bg-hover)' : 'var(--bg-primary)',
        border: `1px solid ${hovered && !disabled ? 'color-mix(in srgb, var(--accent) 40%, var(--border))' : 'var(--border)'}`,
        transition: 'background 0.1s, border-color 0.1s', opacity: disabled && !connecting ? 0.5 : 1,
      }}
    >
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {conn.label}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {conn.username}@{conn.host}{conn.port && conn.port !== 22 ? `:${conn.port}` : ''}
        </div>
      </div>
      {connecting ? (
        <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, flexShrink: 0 }}>Connecting…</span>
      ) : onDelete && hovered ? (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete connection"
          style={{ width: 22, height: 22, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-red)'; e.currentTarget.style.color = 'var(--bg-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >×</button>
      ) : null}
    </div>
  );
};
