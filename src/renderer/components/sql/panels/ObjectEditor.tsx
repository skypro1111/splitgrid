import React, { useEffect, useState } from 'react';
import { SqlColumnIcon, SqlIndexIcon, SqlKeyIcon, SqlTriggerIcon } from '../../Icons';
import type {
  SQLColumnInfo,
  SQLIndexInfo,
  SQLKeyInfo,
  SQLTriggerInfo,
} from '../../../../shared/types';

type Section = 'columns' | 'indexes' | 'keys' | 'triggers';

interface ObjectEditorProps {
  schema: string;
  objectName: string;
  /** Resolved live connection id (null until connected). */
  connectionId: string | null;
  /** Columns already loaded in workbench state for this object. */
  columns: SQLColumnInfo[];
}

/**
 * Read-only structure view for a single table/view. Columns come from the
 * workbench's already-loaded metadata; indexes/keys/triggers are lazily fetched
 * once per mount via the new introspection channels. Editing (add/drop column,
 * add index) is a deferred follow-up — this is a v1 read-only inspector.
 */
export const ObjectEditor: React.FC<ObjectEditorProps> = ({ schema, objectName, connectionId, columns }) => {
  const [section, setSection] = useState<Section>('columns');
  const [indexes, setIndexes] = useState<SQLIndexInfo[] | null>(null);
  const [keys, setKeys] = useState<SQLKeyInfo[] | null>(null);
  const [triggers, setTriggers] = useState<SQLTriggerInfo[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!connectionId) return;
    setError('');
    setIndexes(null); setKeys(null); setTriggers(null);
    (async () => {
      try {
        const [ix, ks, tg] = await Promise.all([
          window.electronAPI.sqlListIndexes(connectionId, schema, objectName),
          window.electronAPI.sqlListKeys(connectionId, schema, objectName),
          window.electronAPI.sqlListTriggers(connectionId, schema, objectName),
        ]);
        if (cancelled) return;
        setIndexes(ix); setKeys(ks); setTriggers(tg);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [connectionId, schema, objectName]);

  const tab = (id: Section, label: string, count?: number) => (
    <button
      key={id}
      className={`sql-struct-tab${section === id ? ' active' : ''}`}
      onClick={() => setSection(id)}
    >
      {label}{typeof count === 'number' ? ` (${count})` : ''}
    </button>
  );

  return (
    <div className="sql-object-editor">
      <div className="sql-struct-header">
        <SqlColumnIcon size={14} />
        <span className="sql-struct-title">{schema}.{objectName}</span>
      </div>
      <div className="sql-struct-tabs">
        {tab('columns', 'Columns', columns.length)}
        {tab('indexes', 'Indexes', indexes?.length)}
        {tab('keys', 'Keys', keys?.length)}
        {tab('triggers', 'Triggers', triggers?.length)}
      </div>
      {error && <div className="sql-struct-error">{error}</div>}
      <div className="sql-struct-body">
        {section === 'columns' && (
          <table className="sql-struct-table">
            <thead><tr><th></th><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>PK</th></tr></thead>
            <tbody>
              {columns.length === 0 && <tr><td colSpan={6} className="sql-struct-empty">No columns</td></tr>}
              {columns.map((c) => (
                <tr key={c.column}>
                  <td><SqlColumnIcon size={12} /></td>
                  <td>{c.column}</td>
                  <td className="sql-struct-mono">{c.dataType ?? ''}</td>
                  <td>{c.isNullable === false ? 'NOT NULL' : 'NULL'}</td>
                  <td className="sql-struct-mono">{c.defaultValue ?? ''}{c.isAutoIncrement ? ' (auto)' : ''}</td>
                  <td>{c.isPrimaryKey ? '✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {section === 'indexes' && (
          indexes === null ? <div className="sql-struct-empty">Loading…</div> : (
            <table className="sql-struct-table">
              <thead><tr><th></th><th>Name</th><th>Columns</th><th>Unique</th><th>Method</th></tr></thead>
              <tbody>
                {indexes.length === 0 && <tr><td colSpan={5} className="sql-struct-empty">No indexes</td></tr>}
                {indexes.map((ix) => (
                  <tr key={ix.name}>
                    <td><SqlIndexIcon size={12} /></td>
                    <td>{ix.name}{ix.isPrimary ? ' (PK)' : ''}</td>
                    <td className="sql-struct-mono">{ix.columns.join(', ')}</td>
                    <td>{ix.isUnique ? '✓' : ''}</td>
                    <td className="sql-struct-mono">{ix.method ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
        {section === 'keys' && (
          keys === null ? <div className="sql-struct-empty">Loading…</div> : (
            <table className="sql-struct-table">
              <thead><tr><th></th><th>Name</th><th>Type</th><th>Columns</th><th>References</th></tr></thead>
              <tbody>
                {keys.length === 0 && <tr><td colSpan={5} className="sql-struct-empty">No keys</td></tr>}
                {keys.map((k) => (
                  <tr key={`${k.type}:${k.name}`}>
                    <td><SqlKeyIcon size={12} /></td>
                    <td>{k.name}</td>
                    <td>{k.type}</td>
                    <td className="sql-struct-mono">{k.columns.join(', ')}</td>
                    <td className="sql-struct-mono">
                      {k.referencedTable ? `${k.referencedTable}(${(k.referencedColumns ?? []).join(', ')})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
        {section === 'triggers' && (
          triggers === null ? <div className="sql-struct-empty">Loading…</div> : (
            <table className="sql-struct-table">
              <thead><tr><th></th><th>Name</th><th>Timing</th><th>Event</th></tr></thead>
              <tbody>
                {triggers.length === 0 && <tr><td colSpan={4} className="sql-struct-empty">No triggers</td></tr>}
                {triggers.map((t) => (
                  <tr key={t.name}>
                    <td><SqlTriggerIcon size={12} /></td>
                    <td>{t.name}</td>
                    <td>{t.timing ?? ''}</td>
                    <td>{t.event ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
};
