import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SSHConnectionConfig, SavedConnection } from '../../shared/types';
import { TEMP_DISABLE_INPUT_INTERCEPTS } from '../../shared/runtime-flags';

// ─── Connection editor ───────────────────────────────────────────────────────
// The single, canonical "create / edit an SSH connection" surface. Used by the
// Settings → SSH manager (Add / Edit) and by the connect dialog's "+ New
// connection" button, so the form looks and behaves identically everywhere.
// It only ever SAVES (or updates) a stored connection — it never connects. The
// caller decides what to do with the returned SavedConnection via onDone.

interface ConnectionEditorModalProps {
  /** When present, the modal edits this connection; otherwise it creates one. */
  connection?: SavedConnection | null;
  onSave: (config: Omit<SSHConnectionConfig, 'id'>) => Promise<SavedConnection>;
  onUpdate?: (id: string, config: Omit<SSHConnectionConfig, 'id'>) => Promise<SavedConnection>;
  /** Called with the freshly saved/updated connection after a successful submit. */
  onDone: (saved: SavedConnection) => void;
  onCancel: () => void;
}

export const ConnectionEditorModal: React.FC<ConnectionEditorModalProps> = ({
  connection,
  onSave,
  onUpdate,
  onDone,
  onCancel,
}) => {
  const editing = !!connection;
  const [label, setLabel] = useState(connection?.label ?? '');
  const [host, setHost] = useState(connection?.host ?? '');
  const [port, setPort] = useState(String(connection?.port ?? 22));
  const [username, setUsername] = useState(connection?.username ?? '');
  const [authMethod, setAuthMethod] = useState<'password' | 'privateKey'>(connection?.authMethod ?? 'password');
  const [password, setPassword] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState(connection?.privateKeyPath ?? '');
  const [passphrase, setPassphrase] = useState('');
  const [offerSavedPassword, setOfferSavedPassword] = useState(connection?.offerSavedPassword ?? false);
  const [sudoPassword, setSudoPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (TEMP_DISABLE_INPUT_INTERCEPTS) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!host.trim() || !username.trim()) {
      setError('Host and username are required');
      return;
    }
    if (authMethod === 'password' && !password && !editing) {
      setError('Password is required');
      return;
    }
    if (authMethod === 'privateKey' && !privateKeyPath) {
      setError('Private key file is required');
      return;
    }

    const config: Omit<SSHConnectionConfig, 'id'> = {
      label: label.trim() || `${username.trim()}@${host.trim()}`,
      host: host.trim(),
      port: parseInt(port, 10) || 22,
      username: username.trim(),
      authMethod,
      password: authMethod === 'password' && password ? password : undefined,
      privateKeyPath: authMethod === 'privateKey' ? privateKeyPath : undefined,
      passphrase: authMethod === 'privateKey' && passphrase ? passphrase : undefined,
      offerSavedPassword,
      // Empty leaves the stored sudo password untouched on edit.
      sudoPassword: sudoPassword || undefined,
    };

    setSaving(true);
    try {
      const saved = editing && onUpdate
        ? await onUpdate(connection!.id, config)
        : await onSave(config);
      onDone(saved);
    } catch (err) {
      setError((err as Error).message || 'Failed to save connection');
      setSaving(false);
    }
  };

  const handleBrowseKey = async () => {
    const path = await window.electronAPI.selectPrivateKeyFile();
    if (path) setPrivateKeyPath(path);
  };

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1400,
        background: 'rgba(0, 0, 0, 0.55)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px',
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: 480, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto',
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 16, boxShadow: '0 24px 70px rgba(0, 0, 0, 0.55)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Premium header with a tinted SSH glyph */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '20px 24px 16px',
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 11, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in srgb, var(--accent) 16%, transparent)',
            color: 'var(--accent)', fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)',
          }}>~</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              {editing ? 'Edit connection' : 'New SSH connection'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {editing ? 'Update the saved connection details' : 'Save a reusable SSH connection'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 24px' }}>
          <Field label="Label">
            <Input value={label} onChange={setLabel} placeholder="My Server" autoFocus />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 96px', gap: 12 }}>
            <Field label="Host">
              <Input value={host} onChange={setHost} placeholder="192.168.1.1" />
            </Field>
            <Field label="Port">
              <Input value={port} onChange={setPort} type="number" placeholder="22" />
            </Field>
          </div>

          <Field label="Username">
            <Input value={username} onChange={setUsername} placeholder="root" />
          </Field>

          <Field label="Authentication">
            <div style={{ display: 'flex', gap: 8 }}>
              <Segment active={authMethod === 'password'} onClick={() => setAuthMethod('password')}>Password</Segment>
              <Segment active={authMethod === 'privateKey'} onClick={() => setAuthMethod('privateKey')}>Private key</Segment>
            </div>
          </Field>

          {authMethod === 'password' ? (
            <Field label={`Password${editing ? ' — leave empty to keep current' : ''}`}>
              <Input value={password} onChange={setPassword} type="password" placeholder={editing ? '••••••••' : 'Enter password'} />
            </Field>
          ) : (
            <>
              <Field label="Private key file">
                <div style={{ display: 'flex', gap: 8 }}>
                  <Input value={privateKeyPath} onChange={setPrivateKeyPath} readOnly placeholder="~/.ssh/id_rsa" style={{ flex: 1 }} />
                  <button type="button" onClick={handleBrowseKey} style={ghostButtonStyle}>Browse</button>
                </div>
              </Field>
              <Field label={`Passphrase${editing ? ' — leave empty to keep current' : ' (optional)'}`}>
                <Input value={passphrase} onChange={setPassphrase} type="password" placeholder={editing ? '••••••••' : 'Key passphrase'} />
              </Field>
            </>
          )}

          {/* Saved-password auto-fill at sudo/password prompts (confirm-to-send). */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={offerSavedPassword} onChange={(e) => setOfferSavedPassword(e.target.checked)} />
            Offer saved password at prompts (sudo / password)
          </label>
          {offerSavedPassword && (
            <Field
              label={`Sudo password${editing ? ' — leave empty to keep current' : (authMethod === 'password' ? ' (optional — otherwise login password)' : ' (required for key-auth)')}`}
            >
              <Input value={sudoPassword} onChange={setSudoPassword} type="password" placeholder={editing ? '••••••••' : 'sudo password'} />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                Encrypted in the OS keychain; only sent after your confirmation (Enter). Never entered automatically.
              </div>
            </Field>
          )}

          {error && (
            <div style={{
              padding: '9px 12px', background: 'rgba(241,76,76,0.10)', border: '1px solid var(--accent-red)',
              borderRadius: 8, color: 'var(--accent-red)', fontSize: 12,
            }}>
              {error}
            </div>
          )}
        </div>

        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 10,
          padding: '14px 24px 20px', borderTop: '1px solid var(--border)',
        }}>
          <button type="button" onClick={onCancel} style={ghostButtonStyle}>Cancel</button>
          <button type="submit" disabled={saving} style={{ ...primaryButtonStyle, opacity: saving ? 0.7 : 1, cursor: saving ? 'default' : 'pointer' }}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Save connection'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
};

// --- Small premium primitives, local to this modal ---

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div style={{
      marginBottom: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
      textTransform: 'uppercase', letterSpacing: '0.4px',
    }}>
      {label}
    </div>
    {children}
  </div>
);

const Input: React.FC<{
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  style?: React.CSSProperties;
}> = ({ value, onChange, type = 'text', placeholder, readOnly, autoFocus, style }) => {
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  return (
    <input
      ref={ref}
      type={type}
      value={value}
      readOnly={readOnly}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: '100%', padding: '9px 12px', borderRadius: 9,
        background: 'var(--bg-primary)', color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)', fontSize: 13, outline: 'none',
        border: `1px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
        boxShadow: focused ? '0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)' : 'none',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        ...style,
      }}
    />
  );
};

const Segment: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      flex: 1, padding: '8px 12px', borderRadius: 9, fontSize: 12, fontWeight: 600, cursor: 'pointer',
      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
      background: active ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'var(--bg-primary)',
      color: active ? 'var(--accent)' : 'var(--text-secondary)',
      transition: 'all 0.12s',
    }}
  >
    {children}
  </button>
);

const ghostButtonStyle: React.CSSProperties = {
  padding: '9px 16px', borderRadius: 9, border: '1px solid var(--border)',
  background: 'var(--bg-primary)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600,
  cursor: 'pointer', whiteSpace: 'nowrap',
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '9px 18px', borderRadius: 9, border: 'none',
  background: 'var(--accent)', color: 'var(--bg-primary)', fontSize: 12, fontWeight: 700,
};
