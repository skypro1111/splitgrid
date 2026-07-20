import React, { useState } from 'react';
import type { SQLExportFormat, SQLDialect } from '../../../../shared/types';
import { Select } from '../../Select';

export interface ExportScopeInfo {
  /** Inline rows currently loaded (the grid page). */
  columns: string[];
  rowCount: number;
  /** Source table for a full-table export (table tabs only). */
  table?: { schema: string; name: string };
  /** Live connection id (required for a full-table export). */
  connectionId: string | null;
  dialect: SQLDialect;
}

export interface ExportRequest {
  format: SQLExportFormat;
  scope: 'current' | 'full';
  includeHeaders: boolean;
  delimiter: string;
  nullText: string;
  sqlTableName: string;
}

interface ExportDialogProps {
  info: ExportScopeInfo;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (req: ExportRequest) => void;
}

const FORMATS: { id: SQLExportFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL (INSERT)' },
  { id: 'xlsx', label: 'Excel (.xlsx)' },
];

const DELIMITERS: { id: string; label: string }[] = [
  { id: ',', label: 'Comma (,)' },
  { id: ';', label: 'Semicolon (;)' },
  { id: '\t', label: 'Tab' },
  { id: '|', label: 'Pipe (|)' },
];

const inputStyle: React.CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-primary)',
  color: 'var(--text-primary)', boxSizing: 'border-box',
};

export const ExportDialog: React.FC<ExportDialogProps> = ({ info, busy, error, onCancel, onConfirm }) => {
  const [format, setFormat] = useState<SQLExportFormat>('csv');
  const [scope, setScope] = useState<'current' | 'full'>('current');
  const [includeHeaders, setIncludeHeaders] = useState(true);
  const [delimiter, setDelimiter] = useState(',');
  const [nullText, setNullText] = useState('');
  const [sqlTableName, setSqlTableName] = useState(info.table?.name ?? 'exported_data');

  const canFull = !!info.table && !!info.connectionId;

  return (
    <div className="sql-modal-backdrop" onClick={onCancel}>
      <div className="sql-modal" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="sql-modal-title">Export data</div>

        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Format</label>
        <div className="sql-dialect-selector">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className={`sql-dialect-option${format === f.id ? ' active' : ''}`}
              onClick={() => setFormat(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Scope</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="radio" checked={scope === 'current'} onChange={() => setScope('current')} />
            Current view ({info.rowCount} loaded rows)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: canFull ? 1 : 0.45 }}>
            <input type="radio" checked={scope === 'full'} disabled={!canFull} onChange={() => setScope('full')} />
            Full table{info.table ? ` (${info.table.schema ? info.table.schema + '.' : ''}${info.table.name})` : ''}
          </label>
        </div>

        {format === 'csv' && (
          <>
            <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Delimiter</label>
            <Select block value={delimiter} onChange={setDelimiter}
              options={DELIMITERS.map((d) => ({ value: d.id, label: d.label }))} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={includeHeaders} onChange={(e) => setIncludeHeaders(e.target.checked)} />
              Include header row
            </label>
            <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>NULL as</label>
            <input style={inputStyle} value={nullText} placeholder="(empty)" onChange={(e) => setNullText(e.target.value)} />
          </>
        )}

        {format === 'sql' && (
          <>
            <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Target table name</label>
            <input style={inputStyle} value={sqlTableName} onChange={(e) => setSqlTableName(e.target.value)} />
          </>
        )}

        {error && <div style={{ color: 'var(--accent-red)', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="sql-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="sql-btn primary"
            disabled={busy}
            onClick={() => onConfirm({ format, scope, includeHeaders, delimiter, nullText, sqlTableName })}
          >
            {busy ? 'Exporting…' : 'Export…'}
          </button>
        </div>
      </div>
    </div>
  );
};
