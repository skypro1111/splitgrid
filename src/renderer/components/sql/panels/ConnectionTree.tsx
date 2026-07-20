import React, { useMemo } from 'react';
import {
  SqlPostgresIcon,
  SqlSchemaIcon,
  SqlSchemasGroupIcon,
  SqlTableIcon,
  SqlViewIcon,
  SqlMatViewIcon,
  SqlForeignTableIcon,
  SqlFunctionIcon,
  SqlProcedureIcon,
  SqlSequenceIcon,
  SqlTypeIcon,
  SqlForeignServerIcon,
  SqlColumnIcon,
  SqlIndexIcon,
  SqlKeyIcon,
  SqlTriggerIcon,
} from '../../Icons';
import { DialectIcon, dialectBrandColor } from '../DialectIcons';
import type {
  SavedSQLConnection,
  SQLConnectionInfo,
  SQLDatabaseInfo,
  SQLSchemaObjectKind,
  SQLSchemaTree,
  SQLColumnInfo,
  SQLIndexInfo,
  SQLKeyInfo,
  SQLTriggerInfo,
} from '../../../../shared/types';

/** Runtime-only (never persisted) cache of a table's children, keyed in the
 * workbench by `${schema}.${table}`. */
export interface TableChildren {
  columns: SQLColumnInfo[];
  indexes: SQLIndexInfo[];
  keys: SQLKeyInfo[];
  triggers: SQLTriggerInfo[];
  loading: boolean;
  error?: string;
}

const CATEGORY_ICON: Record<SQLSchemaObjectKind, React.FC<{ size?: number }>> = {
  table: SqlTableIcon, view: SqlViewIcon, materializedView: SqlMatViewIcon,
  foreignTable: SqlForeignTableIcon, function: SqlFunctionIcon, procedure: SqlProcedureIcon,
  sequence: SqlSequenceIcon, type: SqlTypeIcon,
};

const CATEGORY_LABEL: Partial<Record<SQLSchemaObjectKind, string>> = {
  function: 'Functions', procedure: 'Stored Procedures', sequence: 'Sequences',
  type: 'Types', foreignTable: 'External Tables',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${Math.round(bytes / (1024 * 1024 * 1024))}GB`;
}

function formatRowCount(count: number): string {
  const n = Math.max(0, Math.round(count));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
  return `${Math.round(n / 1_000_000_000)}B`;
}

function TreeArrow({ open }: { open: boolean }) {
  return <span className="tree-arrow">{open ? '▾' : '▸'}</span>;
}

/** Small inline refresh affordance shown on hover at the right of a tree row.
 * Rendered as a span (the row itself is a <button>, so no nested buttons) with
 * stopPropagation so clicking it never toggles/selects the row. */
function TreeRefresh({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      className="tree-refresh"
      title={title}
      aria-label={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
        <path d="M13.5 2.5V5H11" />
      </svg>
    </span>
  );
}

export interface ConnectionTreeProps {
  savedConnections: SavedSQLConnection[];
  selectedSavedId: string | null;
  connectedSavedId: string | null;
  connection: SQLConnectionInfo | null;
  databases: SQLDatabaseInfo[];
  schemas: SQLSchemaTree[];
  expandedNodes: string[];
  loadingSchemas: boolean;
  treeFilter: string;
  failedConnectionIds: Set<string>;
  connError: string;
  /** Connection → database → schema → table backing the on-screen result;
   * highlighted in the tree. `table` is set only for table/structure tabs. */
  activePath: { savedId: string; database: string | null; schema: string | null; table: string | null } | null;
  treeListRef: React.RefObject<HTMLDivElement | null>;
  onFilterChange: (v: string) => void;
  onAddConnection: () => void;
  onRefresh: () => void;
  /** Reload the live tree (schemas/databases/columns) — connection/database/schema buttons. */
  onReloadTree?: () => void;
  /** Force-reload one table's children (columns/indexes/keys/triggers). */
  onReloadTable?: (schema: string, table: string) => void;
  setSelectedSavedId: (id: string | null) => void;
  toggle: (id: string) => void;
  setExpandedNodes: React.Dispatch<React.SetStateAction<string[]>>;
  onContextMenu: (x: number, y: number, connectionId: string) => void;
  onConnectSelected: (id: string) => void;
  onDisconnect: () => void;
  onObjectClick: (schema: string, objectName: string, kind: SQLSchemaObjectKind) => void;
  /** Right-click on a schema object (table/view/etc.) → object context menu. */
  onObjectContextMenu: (x: number, y: number, schema: string, objectName: string, kind: SQLSchemaObjectKind) => void;
  /** Per-table children cache (columns/indexes/keys/triggers), keyed by `schema.table`. */
  tableChildren: Record<string, TableChildren>;
  /** Lazily load a table's children on first expand (no-op if already cached/loading). */
  onExpandTable: (schema: string, table: string) => void;
}

export const ConnectionTree: React.FC<ConnectionTreeProps> = (props) => {
  const {
    savedConnections, selectedSavedId, connectedSavedId, connection, databases, schemas,
    expandedNodes, loadingSchemas, treeFilter, failedConnectionIds, connError, activePath, treeListRef,
    onFilterChange, onAddConnection, onRefresh, onReloadTree, onReloadTable, setSelectedSavedId, toggle, setExpandedNodes,
    onContextMenu, onConnectSelected, onDisconnect, onObjectClick,
    onObjectContextMenu, tableChildren, onExpandTable,
  } = props;

  const isX = (id: string) => expandedNodes.includes(id);
  // Highlight the path backing the on-screen result. Each deeper level checks its
  // ancestors too; pass `undefined` to skip a level (connection-only match, etc.).
  const isActive = (savedId: string, database?: string | null, schema?: string | null, table?: string | null) => {
    if (!activePath || activePath.savedId !== savedId) return false;
    if (database !== undefined && activePath.database !== database) return false;
    if (schema !== undefined && activePath.schema !== schema) return false;
    if (table !== undefined && activePath.table !== table) return false;
    return true;
  };
  const expand = (id: string) => setExpandedNodes((p) => (p.includes(id) ? p : [...p, id]));
  const indent = (level: number) => ({ paddingLeft: level * 16 });

  const [objectSearch, setObjectSearch] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);

  // Global object search over already-loaded schemas (covers loaded schemas only).
  const objectMatches = useMemo(() => {
    const q = objectSearch.trim().toLowerCase();
    if (!q || !connection) return [];
    const out: { schema: string; name: string; kind: SQLSchemaObjectKind }[] = [];
    for (const s of schemas) {
      for (const cat of s.categories) {
        for (const obj of cat.objects) {
          if (obj.name.toLowerCase().includes(q) || s.schema.toLowerCase().includes(q)) {
            out.push({ schema: s.schema, name: obj.name, kind: cat.kind });
            if (out.length >= 200) return out;
          }
        }
      }
    }
    return out;
  }, [objectSearch, schemas, connection]);

  const filteredConnections = useMemo(() => {
    const q = treeFilter.trim().toLowerCase();
    if (!q) return savedConnections;
    return savedConnections.filter((c) =>
      `${c.label} ${c.host} ${c.database} ${c.user} ${c.dialect}`.toLowerCase().includes(q));
  }, [savedConnections, treeFilter]);

  // Table-like kinds get expandable child groups (Columns/Indexes/Keys/Triggers).
  const isExpandableKind = (kind: SQLSchemaObjectKind) =>
    kind === 'table' || kind === 'view' || kind === 'materializedView' || kind === 'foreignTable';

  const renderTableChildren = (savedId: string, dbName: string, schema: string, table: string) => {
    const key = `${schema}.${table}`;
    const data = tableChildren[key];
    if (!data || data.loading) {
      return <div className="sql-tree-node" style={{ ...indent(7), cursor: 'default', color: 'var(--text-muted)', fontSize: 11 }}><span className="tree-arrow-spacer" /> Loading…</div>;
    }
    if (data.error) {
      return <div className="sql-tree-node" style={{ ...indent(7), cursor: 'default', color: 'var(--accent-red)', fontSize: 11 }}><span className="tree-arrow-spacer" /> {data.error}</div>;
    }
    const group = (
      gId: string, GIcon: React.FC<{ size?: number }>, label: string, count: number,
      rows: React.ReactNode,
    ) => {
      const open = isX(gId);
      return (
        <div key={gId}>
          <button className="sql-tree-node" style={{ ...indent(6), cursor: count ? 'pointer' : 'default' }} onClick={() => count && toggle(gId)}>
            {count ? <TreeArrow open={open} /> : <span className="tree-arrow-spacer" />}
            <GIcon size={13} /><span className="tree-label">{label}</span><span className="tree-meta">{count}</span>
          </button>
          {open && count > 0 && rows}
        </div>
      );
    };
    const base = `tbl:${savedId}:${dbName}:${schema}:${table}`;
    return (
      <div>
        {group(`${base}:columns`, SqlColumnIcon, 'Columns', data.columns.length,
          data.columns.map((c) => (
            <div key={c.column} className="sql-tree-node" style={{ ...indent(7), cursor: 'default' }}>
              <span className="tree-arrow-spacer" /><SqlColumnIcon size={12} />
              <span className="tree-label">{c.column}{c.isPrimaryKey ? ' 🔑' : ''}</span>
              <span className="tree-meta">{c.dataType ?? ''}{c.isNullable === false ? ' NN' : ''}</span>
            </div>
          )))}
        {group(`${base}:indexes`, SqlIndexIcon, 'Indexes', data.indexes.length,
          data.indexes.map((ix) => (
            <div key={ix.name} className="sql-tree-node" style={{ ...indent(7), cursor: 'default' }}>
              <span className="tree-arrow-spacer" /><SqlIndexIcon size={12} />
              <span className="tree-label">{ix.name}</span>
              <span className="tree-meta">{ix.isUnique ? 'unique ' : ''}{ix.method ?? ''}</span>
            </div>
          )))}
        {group(`${base}:keys`, SqlKeyIcon, 'Keys', data.keys.length,
          data.keys.map((k) => (
            <div key={`${k.type}:${k.name}`} className="sql-tree-node" style={{ ...indent(7), cursor: 'default' }}>
              <span className="tree-arrow-spacer" /><SqlKeyIcon size={12} />
              <span className="tree-label">{k.name}</span>
              <span className="tree-meta">{k.type}{k.referencedTable ? ` → ${k.referencedTable}` : ''}</span>
            </div>
          )))}
        {group(`${base}:triggers`, SqlTriggerIcon, 'Triggers', data.triggers.length,
          data.triggers.map((t) => (
            <div key={t.name} className="sql-tree-node" style={{ ...indent(7), cursor: 'default' }}>
              <span className="tree-arrow-spacer" /><SqlTriggerIcon size={12} />
              <span className="tree-label">{t.name}</span>
              <span className="tree-meta">{[t.timing, t.event].filter(Boolean).join(' ')}</span>
            </div>
          )))}
      </div>
    );
  };

  const renderCategory = (savedId: string, dbName: string, schema: SQLSchemaTree, cat: SQLSchemaTree['categories'][number]) => {
    const catId = `cat:${savedId}:${dbName}:${schema.schema}:${cat.id}`;
    const catOpen = isX(catId);
    const has = cat.objects.length > 0;
    const Icon = CATEGORY_ICON[cat.kind] ?? SqlTableIcon;
    const label = CATEGORY_LABEL[cat.kind] ?? cat.label;
    const expandable = isExpandableKind(cat.kind);
    return (
      <div key={cat.id}>
        <button className="sql-tree-node" style={{ ...indent(4), cursor: has ? 'pointer' : 'default' }} onClick={() => has && toggle(catId)}>
          {has ? <TreeArrow open={catOpen} /> : <span className="tree-arrow-spacer" />}
          <Icon size={14} /><span className="tree-label">{label}</span>
          {has && <span className="tree-meta">{cat.objects.length}</span>}
        </button>
        {catOpen && has && cat.objects.map((obj) => {
          const objNodeId = `obj:${savedId}:${dbName}:${schema.schema}:${cat.id}:${obj.name}`;
          const objOpen = isX(objNodeId);
          return (
            <div key={obj.name}>
              <button className={`sql-tree-node${isActive(savedId, dbName, schema.schema, obj.name) ? ' active-path' : ''}`} style={indent(5)}
                onClick={() => onObjectClick(schema.schema, obj.name, cat.kind)}
                onContextMenu={(e) => { e.preventDefault(); onObjectContextMenu(e.clientX, e.clientY, schema.schema, obj.name, cat.kind); }}>
                {expandable ? (
                  <span onClick={(e) => { e.stopPropagation(); toggle(objNodeId); if (!objOpen) onExpandTable(schema.schema, obj.name); }} style={{ display: 'inline-flex' }}>
                    <TreeArrow open={objOpen} />
                  </span>
                ) : <TreeArrow open={false} />}
                <Icon size={14} />
                <span className="tree-label">{obj.name}</span>
                {typeof obj.rowEstimate === 'number' && typeof obj.totalBytes === 'number' && (
                  <span className="tree-meta">{formatRowCount(obj.rowEstimate)} rows, {formatBytes(obj.totalBytes)}</span>
                )}
                {expandable && onReloadTable && (
                  <TreeRefresh title="Refresh table" onClick={() => { onReloadTable(schema.schema, obj.name); if (!objOpen) { expand(objNodeId); } }} />
                )}
              </button>
              {expandable && objOpen && renderTableChildren(savedId, dbName, schema.schema, obj.name)}
            </div>
          );
        })}
      </div>
    );
  };

  const renderSchema = (savedId: string, dbName: string, schema: SQLSchemaTree) => {
    const sId = `schema:${savedId}:${dbName}:${schema.schema}`;
    const sOpen = isX(sId);
    return (
      <div key={schema.schema}>
        <button className={`sql-tree-node${isActive(savedId, dbName, schema.schema) ? ' active-path' : ''}`} style={indent(3)} onClick={() => toggle(sId)}>
          <TreeArrow open={sOpen} /><SqlSchemaIcon size={14} />
          <span className="tree-label" style={{ fontWeight: schema.isDefault ? 600 : 400 }}>{schema.schema}</span>
          {schema.isDefault && <span className="tree-meta">Default</span>}
          {onReloadTree && <TreeRefresh title="Refresh schema" onClick={onReloadTree} />}
        </button>
        {sOpen && schema.categories.map((cat) => renderCategory(savedId, dbName, schema, cat))}
      </div>
    );
  };

  const renderDatabase = (savedId: string, db: SQLDatabaseInfo) => {
    const dbId = `db:${savedId}:${db.name}`;
    const dbOpen = isX(dbId);
    const sGroupId = `schemas:${savedId}:${db.name}`;
    const sGroupOpen = isX(sGroupId);
    return (
      <div key={db.name}>
        <button className={`sql-tree-node${isActive(savedId, db.name) ? ' active-path' : ''}`} style={indent(1)} onClick={() => toggle(dbId)}>
          <TreeArrow open={dbOpen} />
          <SqlPostgresIcon size={14} />
          <span style={{ fontWeight: db.isCurrent ? 600 : 400, flexShrink: 0 }}>{db.name}</span>
          <span className="tree-meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {formatBytes(db.sizeBytes)}{db.isCurrent ? ', Default' : db.description ? `, ${db.description}` : ''}
          </span>
          {db.isCurrent && onReloadTree && <TreeRefresh title="Refresh database" onClick={onReloadTree} />}
        </button>
        {dbOpen && db.isCurrent && (
          <div>
            <button className="sql-tree-node" style={indent(2)} onClick={() => toggle(sGroupId)}>
              <TreeArrow open={sGroupOpen} /><SqlSchemasGroupIcon size={14} />
              <span className="tree-label">Schemas</span><span className="tree-meta">{schemas.length}</span>
            </button>
            {sGroupOpen && schemas.map((schema) => renderSchema(savedId, db.name, schema))}
            <div className="sql-tree-node" style={{ ...indent(2), cursor: 'default', color: 'var(--text-muted)' }}>
              <span className="tree-arrow-spacer" /><SqlForeignServerIcon size={14} /><span className="tree-label">Foreign Servers</span>
            </div>
          </div>
        )}
        {dbOpen && !db.isCurrent && (
          <div className="sql-tree-node" style={{ ...indent(2), cursor: 'default', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 11 }}>
            <span className="tree-arrow-spacer" /> Connect to browse
          </div>
        )}
      </div>
    );
  };

  const renderTree = () => {
    if (filteredConnections.length === 0) {
      return <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>No saved connections</div>;
    }
    return filteredConnections.map((saved) => {
      const cId = `conn:${saved.id}`;
      const sel = selectedSavedId === saved.id;
      const live = connectedSavedId === saved.id && !!connection;
      const failed = failedConnectionIds.has(saved.id);
      const open = isX(cId);
      // Brand logo stays in its own colour; status shows via the green label and
      // the "reconnect failed" meta. Dim a failed connection's logo slightly.
      const iconColor = failed ? '#f14c4c' : dialectBrandColor(saved.dialect, saved.label);
      return (
        <div key={saved.id}>
          <button
            id={`conn-node-${saved.id}`}
            className={`sql-tree-node${sel ? ' selected' : ''}${isActive(saved.id) ? ' active-path' : ''}`}
            onClick={() => { setSelectedSavedId(saved.id); toggle(cId); }}
            onContextMenu={(e) => { e.preventDefault(); setSelectedSavedId(saved.id); onContextMenu(e.clientX, e.clientY, saved.id); }}
            onDoubleClick={() => live ? onDisconnect() : onConnectSelected(saved.id)}
          >
            <TreeArrow open={open} />
            <DialectIcon dialect={saved.dialect} label={saved.label} size={14} color={iconColor} />
            <span className="tree-label" style={{ fontWeight: live ? 600 : 500, color: live ? 'var(--accent-green, #15ac91)' : undefined }}>{saved.label}</span>
            <span className="tree-meta">
              {failed ? 'reconnect failed' : saved.dialect === 'sqlite' ? (saved.filePath || saved.database || '') : `${saved.host}:${saved.port}`}
            </span>
            {live && onReloadTree && <TreeRefresh title="Refresh connection" onClick={onReloadTree} />}
          </button>
          {open && (
            <div>
              {!live ? (
                <div className="sql-tree-node" style={{ ...indent(2), cursor: 'default', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 11 }}>
                  <span className="tree-arrow-spacer" /> Not connected
                </div>
              ) : loadingSchemas ? (
                <div className="sql-tree-node" style={{ ...indent(2), cursor: 'default', color: 'var(--text-muted)', fontSize: 11 }}>
                  <span className="tree-arrow-spacer" /> Loading…
                </div>
              ) : databases.map((db) => renderDatabase(saved.id, db))}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6, height: 26, boxSizing: 'content-box' }}>
        {searchOpen ? (
          <input autoFocus value={objectSearch} onChange={(e) => setObjectSearch(e.target.value)}
            onBlur={() => { if (!objectSearch.trim()) setSearchOpen(false); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setObjectSearch(''); setSearchOpen(false); } }}
            placeholder="Search objects"
            style={{ flex: 1, minWidth: 0, height: 26, fontSize: 11, padding: '0 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)', boxSizing: 'border-box' }} />
        ) : (
          <button onClick={() => setSearchOpen(true)} className="sql-btn icon" title="Search objects" aria-label="Search objects"
            style={{ height: 26, width: 26, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="7" cy="7" r="4.5" /><line x1="10.5" y1="10.5" x2="14" y2="14" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={onAddConnection} className="sql-btn icon" title="New connection" style={{ height: 26, width: 26, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>+</button>
          <button onClick={onRefresh} className="sql-btn icon" title="Refresh" style={{ height: 26, width: 26, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>↻</button>
        </div>
      </div>
      {connection && objectSearch.trim() && (
        <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
            {objectMatches.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 8px' }}>No matches</div>
            ) : objectMatches.map((m) => {
              const Icon = CATEGORY_ICON[m.kind] ?? SqlTableIcon;
              return (
                <button key={`${m.schema}.${m.name}.${m.kind}`} className="sql-tree-node" style={{ width: '100%' }}
                  onClick={() => { onObjectClick(m.schema, m.name, m.kind); setObjectSearch(''); }}
                  onContextMenu={(e) => { e.preventDefault(); onObjectContextMenu(e.clientX, e.clientY, m.schema, m.name, m.kind); }}>
                  <span className="tree-arrow-spacer" /><Icon size={13} />
                  <span className="tree-label">{m.name}</span>
                  <span className="tree-meta">{m.schema}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div ref={treeListRef} tabIndex={0}
        onKeyDown={(e) => {
          if (filteredConnections.length === 0) return;
          const idx = filteredConnections.findIndex((c) => c.id === selectedSavedId);
          const cur = idx >= 0 ? idx : 0;
          if (e.key === 'ArrowDown') { e.preventDefault(); const n = filteredConnections[Math.min(filteredConnections.length - 1, cur + 1)]; if (n) setSelectedSavedId(n.id); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); const n = filteredConnections[Math.max(0, cur - 1)]; if (n) setSelectedSavedId(n.id); }
          else if (e.key === 'ArrowRight' && selectedSavedId) { e.preventDefault(); expand(`conn:${selectedSavedId}`); }
          else if (e.key === 'ArrowLeft' && selectedSavedId) { e.preventDefault(); setExpandedNodes((p) => p.filter((x) => x !== `conn:${selectedSavedId}`)); }
          else if (e.key === 'Enter' && selectedSavedId) { e.preventDefault(); connectedSavedId === selectedSavedId ? onDisconnect() : onConnectSelected(selectedSavedId); }
        }}
        style={{ flex: 1, overflow: 'auto', padding: '4px 0', outline: 'none' }}
      >
        {renderTree()}
      </div>
      {connError && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--accent-red)', borderTop: '1px solid var(--border)' }}>{connError}</div>
      )}
    </div>
  );
};
