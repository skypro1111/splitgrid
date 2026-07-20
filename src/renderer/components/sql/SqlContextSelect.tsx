import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SQLDialect } from '../../../shared/types';
import { DialectIcon } from './DialectIcons';

interface ConnItem { id: string; label: string; dialect: SQLDialect }

interface SqlContextSelectProps {
  /** Connections currently connected (the cascade's first level). */
  connections: ConnItem[];
  /** Active/target connection id + label (label shown even when disconnected). */
  connectionId: string;
  connectionLabel: string;
  /** Whether the selected connection is currently live. */
  connected: boolean;
  showDatabase: boolean;
  showSchema: boolean;
  database: string;
  schema: string;
  /** Loaded data for the active connection (no fetch needed). */
  activeConnId: string;
  activeDatabases: string[];
  activeDatabase: string;
  activeSchemas: string[];
  /** Lazily fetch schemas for a (non-active) database on the active connection. */
  loadSchemas: (database: string) => Promise<string[]>;
  /** Apply a pick. Empty db/schema → keep the current one. */
  onPick: (connectionId: string, database: string, schema: string) => void;
  disabled?: boolean;
}

/**
 * Cascading query-context picker: connection ▸ database ▸ schema. A single
 * toolbar button shows the active context; the menu lists connected connections,
 * each flying out to its databases, each flying out to its schemas (lazily
 * loaded + cached). Portalled so it's never clipped by the toolbar overflow.
 */
export const SqlContextSelect: React.FC<SqlContextSelectProps> = ({
  connections,
  connectionId,
  connectionLabel,
  connected,
  showDatabase,
  showSchema,
  database,
  schema,
  activeConnId,
  activeDatabases,
  activeDatabase,
  activeSchemas,
  loadSchemas,
  onPick,
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sub1Ref = useRef<HTMLDivElement>(null);
  const sub2Ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number } | null>(null);
  const [hoverConn, setHoverConn] = useState<string | null>(null);
  const [connPos, setConnPos] = useState<{ left: number; top: number } | null>(null);
  const [hoverDb, setHoverDb] = useState<string | null>(null);
  const [dbPos, setDbPos] = useState<{ left: number; top: number } | null>(null);
  const [cache, setCache] = useState<Record<string, string[]>>({});
  const [loadingDb, setLoadingDb] = useState<string | null>(null);

  const label = !connected
    ? (connectionLabel || 'Not connected')
    : showDatabase && showSchema ? `${database || '—'} / ${schema || '—'}`
    : showDatabase ? (database || '—')
    : (schema || '—');

  const databasesFor = (connId: string) => (connId === activeConnId ? activeDatabases : []);
  const schemasFor = (connId: string, db: string): string[] | undefined => {
    if (connId !== activeConnId) return [];
    if (db === activeDatabase) return activeSchemas;
    return cache[db];
  };

  const ensureSchemas = (connId: string, db: string) => {
    if (connId !== activeConnId) return;
    if (schemasFor(connId, db) !== undefined || loadingDb === db) return;
    setLoadingDb(db);
    void loadSchemas(db).then((list) => {
      setCache((prev) => ({ ...prev, [db]: list }));
      setLoadingDb((cur) => (cur === db ? null : cur));
    });
  };

  const openMenu = () => {
    if (disabled) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4, minWidth: Math.max(r.width, 200) });
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setHoverConn(null); setConnPos(null); setHoverDb(null); setDbPos(null);
  };

  useEffect(() => {
    if (!open) return;
    const inside = (n: Node | null) => !!(
      btnRef.current?.contains(n) || menuRef.current?.contains(n) ||
      sub1Ref.current?.contains(n) || sub2Ref.current?.contains(n));
    const onDoc = (e: MouseEvent) => { if (!inside(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onScroll = (e: Event) => { if (!inside(e.target as Node)) close(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // A connection has a flyout when there are deeper levels to choose.
  const connHasFlyout = showDatabase || showSchema;

  const hoverConnection = (connId: string, el: HTMLElement) => {
    setHoverConn(connId);
    setHoverDb(null); setDbPos(null);
    const r = el.getBoundingClientRect();
    setConnPos({ left: r.right + 2, top: r.top });
    // No-database-but-schema: prefetch the active db's schemas.
    if (!showDatabase && showSchema) ensureSchemas(connId, activeDatabase);
  };

  const hoverDatabase = (connId: string, db: string, el: HTMLElement) => {
    setHoverDb(db);
    const r = el.getBoundingClientRect();
    setDbPos({ left: r.right + 2, top: r.top });
    ensureSchemas(connId, db);
  };

  const opt = (
    key: string, lbl: string, selected: boolean, onClick: () => void,
    flyout?: boolean, onEnter?: (el: HTMLElement) => void, icon?: React.ReactNode,
  ) => (
    <button
      key={key}
      type="button"
      className={`sql-select-opt${selected ? ' sel' : ''}`}
      onClick={onClick}
      onMouseEnter={onEnter ? (e) => onEnter(e.currentTarget) : undefined}
    >
      {icon}
      <span className="sql-select-opt-label">{lbl}</span>
      {flyout
        ? <span className="sql-ctx-arrow" aria-hidden>▸</span>
        : <span className="sql-select-check" aria-hidden>{selected ? '✓' : ''}</span>}
    </button>
  );

  // First-level (connections) menu.
  const renderConnections = () => {
    if (connections.length === 0) return <div className="sql-select-empty">No active connections</div>;
    return connections.map((c) => opt(
      c.id, c.label, c.id === connectionId,
      () => { if (!connHasFlyout) { onPick(c.id, '', ''); close(); } },
      connHasFlyout,
      (el) => hoverConnection(c.id, el),
      <DialectIcon dialect={c.dialect} label={c.label} size={13} />,
    ));
  };

  // Second-level flyout: databases, or (no-db dialects) schemas directly.
  const renderConnFlyout = (connId: string) => {
    if (showDatabase) {
      const dbs = databasesFor(connId);
      if (dbs.length === 0) return <div className="sql-select-empty">No databases</div>;
      return dbs.map((db) => opt(
        db, db, connId === connectionId && db === database,
        () => { if (!showSchema) { onPick(connId, db, ''); close(); } },
        showSchema,
        (el) => hoverDatabase(connId, db, el),
      ));
    }
    // schema directly under the connection (single database)
    const list = schemasFor(connId, activeDatabase);
    if (list === undefined) return <div className="sql-select-empty">Loading…</div>;
    if (list.length === 0) return <div className="sql-select-empty">No schemas</div>;
    return list.map((s) => opt(
      s, s, connId === connectionId && s === schema,
      () => { onPick(connId, '', s); close(); },
    ));
  };

  // Third-level flyout: schemas of the hovered database.
  const renderDbFlyout = (connId: string, db: string) => {
    const list = schemasFor(connId, db);
    if (list === undefined) return <div className="sql-select-empty">Loading…</div>;
    if (list.length === 0) return <div className="sql-select-empty">No schemas</div>;
    return list.map((s) => opt(
      `${db}.${s}`, s, connId === connectionId && db === database && s === schema,
      () => { onPick(connId, db, s); close(); },
    ));
  };

  return (
    <div className="sql-select-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`sql-select${open ? ' open' : ''}${connected ? '' : ' sql-select-warn'}`}
        disabled={disabled}
        title="Query context — connection / database / schema"
        onClick={() => (open ? close() : openMenu())}
      >
        <span className="sql-select-ic" aria-hidden>{connected ? '⛁' : '⚠'}</span>
        <span className="sql-select-label">{label}</span>
        <span className="sql-select-caret" aria-hidden>▾</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="sql-select-menu sql-ctx-menu"
          style={{ left: pos.left, top: pos.top, minWidth: pos.minWidth }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {renderConnections()}
        </div>,
        document.body,
      )}
      {open && hoverConn && connPos && connHasFlyout && createPortal(
        <div
          ref={sub1Ref}
          className="sql-select-menu sql-ctx-sub"
          style={{ left: connPos.left, top: connPos.top, minWidth: 150 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="sql-ctx-section">{showDatabase ? 'Database' : 'Schema'}</div>
          {renderConnFlyout(hoverConn)}
        </div>,
        document.body,
      )}
      {open && hoverConn && hoverDb && dbPos && showDatabase && showSchema && createPortal(
        <div
          ref={sub2Ref}
          className="sql-select-menu sql-ctx-sub"
          style={{ left: dbPos.left, top: dbPos.top, minWidth: 150 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="sql-ctx-section">{hoverDb}</div>
          {renderDbFlyout(hoverConn, hoverDb)}
        </div>,
        document.body,
      )}
    </div>
  );
};
