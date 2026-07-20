import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { DIALECT_CAPABILITIES, getDialectCapabilities } from '../../../../shared/dialects';
import type { SQLConnectionConfig, SQLDialect } from '../../../../shared/types';

export interface ConnectionFormValues {
  label: string;
  dialect: SQLDialect;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  filePath: string;
}

interface ConnectionDialogProps {
  /** When set, the dialog is in edit mode (password optional). */
  editing: boolean;
  initial: ConnectionFormValues;
  onCancel: () => void;
  onSave: (values: ConnectionFormValues) => Promise<void> | void;
  error?: string;
}

const DIALECT_ORDER: SQLDialect[] = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql'];

/** Short uppercase badge per dialect for the tree/connection chip. */
export const DIALECT_BADGE: Record<SQLDialect, string> = {
  postgres: 'PG',
  mysql: 'MY',
  mariadb: 'MR',
  sqlite: 'LT',
  mssql: 'MS',
};

/** Accent color per dialect (also used by the connection tree icon). */
export const DIALECT_COLOR: Record<SQLDialect, string> = {
  postgres: '#336791',
  mysql: '#00758F',
  mariadb: '#C49A6C',
  sqlite: '#4FC1FF',
  mssql: '#CC2927',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 12,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  boxSizing: 'border-box',
};

export const ConnectionDialog: React.FC<ConnectionDialogProps> = ({
  editing,
  initial,
  onCancel,
  onSave,
  error,
}) => {
  const [form, setForm] = useState<ConnectionFormValues>(initial);
  const [testState, setTestState] = useState<{ status: 'idle' | 'testing' | 'ok' | 'fail'; message: string }>({
    status: 'idle',
    message: '',
  });

  const caps = useMemo(() => getDialectCapabilities(form.dialect), [form.dialect]);

  const set = <K extends keyof ConnectionFormValues>(key: K, value: ConnectionFormValues[K]) =>
    setForm((p) => ({ ...p, [key]: value }));

  // Switching dialect just changes the dialect; the port stays empty so its
  // placeholder reflects the new dialect's default port.
  const selectDialect = (dialect: SQLDialect) => {
    setForm((p) => ({ ...p, dialect }));
    setTestState({ status: 'idle', message: '' });
  };

  const buildConfig = (): SQLConnectionConfig => ({
    dialect: form.dialect,
    host: form.host.trim() || '127.0.0.1',
    port: form.port || caps.defaultPort || 0,
    user: form.user.trim(),
    password: form.password,
    database: caps.requiresFilePath ? form.filePath.trim() : form.database.trim(),
    ssl: form.ssl,
    connectionName: form.label.trim(),
    ...(caps.requiresFilePath ? { filePath: form.filePath.trim() } : {}),
  });

  const handleTest = async () => {
    setTestState({ status: 'testing', message: 'Connecting…' });
    try {
      const res = await window.electronAPI.sqlTestConnection(buildConfig());
      setTestState({
        status: 'ok',
        message: res.serverVersion ? `Connected — ${res.serverVersion}` : 'Connection succeeded',
      });
    } catch (err) {
      setTestState({ status: 'fail', message: (err as Error).message || 'Connection failed' });
    }
  };

  const handlePickFile = async () => {
    // selectDirectory exists; reuse selectPrivateKeyFile (an open-file dialog) so
    // the user can point at an existing .sqlite/.db file. New files can be typed.
    try {
      const picked = await window.electronAPI.selectPrivateKeyFile();
      if (picked) set('filePath', picked);
    } catch { /* ignore */ }
  };

  return createPortal(
    <div className="sql-modal-backdrop">
      <div className="sql-modal">
        <div className="sql-modal-title">
          {editing ? 'Edit Connection' : 'New Connection'}
        </div>

        {/* Dialect selector — segmented buttons */}
        <div className="sql-dialect-selector">
          {DIALECT_ORDER.map((d) => {
            const c = DIALECT_CAPABILITIES[d];
            const active = form.dialect === d;
            return (
              <button
                key={d}
                type="button"
                className={`sql-dialect-option${active ? ' active' : ''}`}
                onClick={() => selectDialect(d)}
                style={active ? { borderColor: DIALECT_COLOR[d] } : undefined}
                title={c.label}
              >
                <span className="sql-dialect-badge" style={{ background: DIALECT_COLOR[d] }}>
                  {DIALECT_BADGE[d]}
                </span>
                <span className="sql-dialect-label">{c.label}</span>
              </button>
            );
          })}
        </div>

        {/* Form fields adapt to dialect capabilities */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            style={inputStyle}
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder="Label"
          />

          {caps.requiresFilePath ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={inputStyle}
                value={form.filePath}
                onChange={(e) => set('filePath', e.target.value)}
                placeholder="Database file path (e.g. /path/to/app.sqlite)"
              />
              <button type="button" className="sql-btn" onClick={() => void handlePickFile()}>
                Browse…
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
                <input
                  style={inputStyle}
                  value={form.host}
                  onChange={(e) => set('host', e.target.value)}
                  placeholder="127.0.0.1"
                />
                <input
                  style={inputStyle}
                  type="number"
                  value={form.port || ''}
                  onChange={(e) => set('port', Number(e.target.value) || 0)}
                  placeholder={caps.defaultPort ? String(caps.defaultPort) : 'Port'}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input
                  style={inputStyle}
                  value={form.user}
                  onChange={(e) => set('user', e.target.value)}
                  placeholder="User"
                />
                <input
                  style={inputStyle}
                  type="password"
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  placeholder={editing ? 'Password (unchanged if blank)' : 'Password'}
                />
              </div>
              {caps.supportsMultipleDatabases && (
                <input
                  style={inputStyle}
                  value={form.database}
                  onChange={(e) => set('database', e.target.value)}
                  placeholder="Database"
                />
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={form.ssl} onChange={(e) => set('ssl', e.target.checked)} /> SSL
              </label>
            </>
          )}
        </div>

        {(error || testState.message) && (
          <div
            className="sql-modal-message"
            style={{
              color:
                testState.status === 'ok'
                  ? 'var(--accent-green)'
                  : error || testState.status === 'fail'
                    ? 'var(--accent-red)'
                    : 'var(--text-muted)',
            }}
          >
            {error || testState.message}
          </div>
        )}

        <div className="sql-modal-actions">
          <button type="button" className="sql-btn" onClick={() => void handleTest()} disabled={testState.status === 'testing'}>
            {testState.status === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
          <div style={{ flex: 1 }} />
          <button type="button" className="sql-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="sql-btn primary" onClick={() => void onSave(form)}>
            {editing ? 'Save Changes' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
