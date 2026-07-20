import React, { useEffect, useMemo, useState } from 'react';
import { parseCsv, detectCsvDelimiter } from '../../../../shared/sql-serialize';
import type { SQLColumnInfo } from '../../../../shared/types';
import { Select } from '../../Select';

interface ImportDialogProps {
  connectionId: string;
  schema: string;
  table: string;
  /** Target table columns (from sql:list-columns, filtered to schema.table). */
  targetColumns: SQLColumnInfo[];
  onCancel: () => void;
  /** Called after a successful import (so the grid can reload). */
  onDone: (imported: number) => void;
}

const inputStyle: React.CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-primary)',
  color: 'var(--text-primary)', boxSizing: 'border-box',
};

const DELIMS: { id: string; label: string }[] = [
  { id: ',', label: 'Comma (,)' },
  { id: ';', label: 'Semicolon (;)' },
  { id: '\t', label: 'Tab' },
  { id: '|', label: 'Pipe (|)' },
];

/** Light per-target-type coercion: numbers, booleans, empty → NULL (nullable). */
function coerce(raw: string, col: SQLColumnInfo | undefined): unknown {
  if (raw === '') return col?.isNullable !== false ? null : '';
  const t = (col?.dataType ?? '').toLowerCase();
  if (/bool/.test(t)) {
    const v = raw.trim().toLowerCase();
    if (['true', 't', '1', 'yes', 'y'].includes(v)) return true;
    if (['false', 'f', '0', 'no', 'n'].includes(v)) return false;
    return raw;
  }
  if (/int|serial|numeric|decimal|real|double|float|money|number/.test(t)) {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

export const ImportDialog: React.FC<ImportDialogProps> = ({
  connectionId, schema, table, targetColumns, onCancel, onDone,
}) => {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [rawText, setRawText] = useState('');
  const [delimiter, setDelimiter] = useState(',');
  const [hasHeader, setHasHeader] = useState(true);
  const [truncate, setTruncate] = useState(false);
  const [batchSize, setBatchSize] = useState(200);
  // mapping: target column name → source CSV column index (or -1 = skip).
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  // Pick a file on mount.
  useEffect(() => {
    void (async () => {
      const picked = await window.electronAPI.sqlPickImportFile();
      if (!picked) { onCancel(); return; }
      setFilePath(picked);
      try {
        const text = await window.electronAPI.readFile(picked);
        setRawText(text);
        setDelimiter(detectCsvDelimiter(text));
      } catch (err) {
        setError((err as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const matrix = useMemo(() => (rawText ? parseCsv(rawText, delimiter) : []), [rawText, delimiter]);
  const headerRow = matrix[0] ?? [];
  const sourceHeaders = hasHeader
    ? headerRow
    : headerRow.map((_c, i) => `Column ${i + 1}`);
  const dataRows = hasHeader ? matrix.slice(1) : matrix;

  // Auto-map target columns by case-insensitive name match whenever headers change.
  useEffect(() => {
    const next: Record<string, number> = {};
    for (const col of targetColumns) {
      const idx = sourceHeaders.findIndex((h) => h.trim().toLowerCase() === col.column.toLowerCase());
      next[col.column] = idx;
    }
    setMapping(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawText, delimiter, hasHeader, targetColumns.length]);

  const mappedCols = targetColumns.filter((c) => (mapping[c.column] ?? -1) >= 0);

  const runImport = async () => {
    if (mappedCols.length === 0) { setError('Map at least one column.'); return; }
    setBusy(true); setError(''); setProgress('Preparing…');
    try {
      const columns = mappedCols.map((c) => c.column);
      const colByName = new Map(targetColumns.map((c) => [c.column, c]));
      const rows: unknown[][] = dataRows.map((srcRow) =>
        mappedCols.map((c) => coerce(srcRow[mapping[c.column]] ?? '', colByName.get(c.column)))
      );
      setProgress(`Importing ${rows.length} rows…`);
      const res = await window.electronAPI.sqlImportRows(connectionId, {
        schema, table, columns, rows, truncate, batchSize,
      });
      setProgress(`Imported ${res.imported} rows.`);
      onDone(res.imported);
    } catch (err) {
      setError((err as Error).message || 'Import failed (rolled back).');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sql-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="sql-modal" style={{ minWidth: 460, maxHeight: '82vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="sql-modal-title">Import CSV → {schema ? `${schema}.` : ''}{table}</div>
        {filePath && <div style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-all' }}>{filePath}</div>}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Delimiter
            <Select value={delimiter} onChange={setDelimiter} disabled={busy} minWidth={120}
              options={DELIMS.map((d) => ({ value: d.id, label: d.label }))} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} disabled={busy} />
            First row is header
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={truncate} onChange={(e) => setTruncate(e.target.checked)} disabled={busy} />
            Truncate before import
          </label>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Batch{' '}
            <input type="number" min={1} max={1000} style={{ ...inputStyle, width: 70 }} value={batchSize}
              onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || 1))} disabled={busy} />
          </label>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {dataRows.length} data rows · {sourceHeaders.length} source columns
        </div>

        {/* Column mapping */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
            <span>Target column</span><span>CSV column</span>
          </div>
          {targetColumns.map((col) => (
            <div key={col.column} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }} title={col.dataType}>
                {col.column}
                {col.isPrimaryKey && <span style={{ marginLeft: 4 }}>🔑</span>}
                {col.dataType && <span style={{ marginLeft: 6, color: 'var(--text-muted)', fontSize: 10 }}>{col.dataType}</span>}
              </span>
              <Select
                block
                disabled={busy}
                value={String(mapping[col.column] ?? -1)}
                onChange={(v) => setMapping((m) => ({ ...m, [col.column]: Number(v) }))}
                options={[
                  { value: '-1', label: '— skip —' },
                  ...sourceHeaders.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` })),
                ]}
              />
            </div>
          ))}
        </div>

        {progress && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{progress}</div>}
        {error && <div style={{ color: 'var(--accent-red)', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="sql-btn" onClick={onCancel} disabled={busy}>Close</button>
          <button className="sql-btn primary" onClick={() => void runImport()} disabled={busy || !rawText}>
            {busy ? 'Importing…' : `Import ${dataRows.length} rows`}
          </button>
        </div>
      </div>
    </div>
  );
};
