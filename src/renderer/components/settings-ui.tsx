import React, { useEffect, useState } from 'react';
import type { QuickChatHotkey } from '../../shared/types';
import { normalizeQuickChatHotkey, formatQuickChatHotkey } from '../../shared/quick-chat-hotkey';
import { setCapturingHotkey } from '../hotkeyCapture';
import { Select } from './Select';

// ─── Premium settings primitives ─────────────────────────────────────────────
// Shared building blocks for the settings surfaces (global Settings + Workspace
// Settings) so both look identical: layered cards, label rows, toggle switches,
// focus-ring inputs/selects, and segmented controls.

export const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', width: 130, flexShrink: 0 };

export const Card: React.FC<{ title: string; desc?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }> = ({ title, desc, right, children }) => (
  <div style={{
    background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
    padding: 18, marginBottom: 14, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
  }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
        {desc && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.55 }}>{desc}</div>}
      </div>
      {right && <div style={{ flexShrink: 0 }}>{right}</div>}
    </div>
    <div style={{ marginTop: 14 }}>{children}</div>
  </div>
);

export const Row: React.FC<{ label: string; children: React.ReactNode; align?: React.CSSProperties['alignItems'] }> = ({ label, children, align = 'center' }) => (
  <div style={{ display: 'flex', alignItems: align, gap: 12, marginBottom: 12 }}>
    <span style={labelStyle}>{label}</span>
    {children}
  </div>
);

export const Hint: React.FC<{ children: React.ReactNode; tone?: 'muted' | 'error' }> = ({ children, tone = 'muted' }) => (
  <div style={{
    fontSize: 11, lineHeight: 1.5, marginTop: -4, marginBottom: 10,
    color: tone === 'error' ? 'var(--accent-red)' : 'var(--text-muted)',
  }}>
    {children}
  </div>
);

export const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; desc?: React.ReactNode }> = ({ label, checked, onChange, disabled, desc }) => (
  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, opacity: disabled ? 0.5 : 1 }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
      {desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.55 }}>{desc}</div>}
    </div>
    <button
      type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 40, height: 23, borderRadius: 12, border: 'none', flexShrink: 0, position: 'relative', padding: 0, marginTop: 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--accent)' : 'var(--border)', transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2.5, left: checked ? 19.5 : 2.5, width: 18, height: 18, borderRadius: '50%',
        background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0, 0, 0, 0.35)',
      }} />
    </button>
  </div>
);

export function controlStyle(focused: boolean, extra?: React.CSSProperties): React.CSSProperties {
  return {
    padding: '8px 11px', borderRadius: 9, fontSize: 12,
    background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none',
    border: `1px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
    boxShadow: focused ? '0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent)' : 'none',
    transition: 'border-color 0.12s, box-shadow 0.12s',
    ...extra,
  };
}

export const PInput: React.FC<{
  value: string;
  onValue: (v: string) => void;
  type?: string;
  placeholder?: string;
  grow?: boolean;
  min?: number;
  max?: number;
  step?: number;
  style?: React.CSSProperties;
}> = ({ value, onValue, type = 'text', placeholder, grow, min, max, step, style }) => {
  const [focused, setFocused] = useState(false);
  return (
    <input
      type={type} value={value} placeholder={placeholder} min={min} max={max} step={step}
      onChange={(e) => onValue(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={controlStyle(focused, { ...(grow ? { flex: 1, minWidth: 0 } : {}), ...style })}
    />
  );
};

export const PSelect: React.FC<{
  value: string;
  onValue: (v: string) => void;
  children: React.ReactNode;
  grow?: boolean;
  style?: React.CSSProperties;
}> = ({ value, onValue, children, grow }) => {
  // Render the app-styled dropdown instead of a native <select>; options are read
  // from the <option> children so existing call sites keep working unchanged.
  const options = React.Children.toArray(children)
    .filter((c): c is React.ReactElement<{ value?: unknown; children?: React.ReactNode }> =>
      React.isValidElement(c) && c.type === 'option')
    .map((c) => {
      const v = String(c.props.value ?? '');
      const kids = c.props.children;
      return { value: v, label: typeof kids === 'string' ? kids : String(kids ?? v) };
    });
  return (
    <Select value={value} onChange={onValue} options={options} block={grow} minWidth={grow ? undefined : 170} />
  );
};

export const PTextarea: React.FC<{
  value: string;
  onValue: (v: string) => void;
  rows?: number;
  placeholder?: string;
  grow?: boolean;
}> = ({ value, onValue, rows = 3, placeholder, grow }) => {
  const [focused, setFocused] = useState(false);
  return (
    <textarea
      rows={rows} value={value} placeholder={placeholder}
      onChange={(e) => onValue(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={controlStyle(focused, { resize: 'vertical', fontFamily: 'inherit', ...(grow ? { flex: 1, minWidth: 0 } : {}) })}
    />
  );
};

export const Segmented: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}> = ({ value, onChange, options }) => (
  <div style={{ display: 'flex', gap: 8 }}>
    {options.map((o) => {
      const active = value === o.value;
      return (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          style={{
            padding: '8px 14px', borderRadius: 9, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
            background: active ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'var(--bg-primary)',
            color: active ? 'var(--accent)' : 'var(--text-secondary)',
            transition: 'all 0.12s',
          }}
        >
          {o.label}
        </button>
      );
    })}
  </div>
);

// Neutral/ghost button used across settings (Browse, Select directory, etc.).
export const ghostBtnStyle: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 9, border: '1px solid var(--border)',
  background: 'var(--bg-primary)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
};

// Accent primary button (Save), matching the SSH editor's primary action.
export const primaryBtnStyle = (enabled: boolean): React.CSSProperties => ({
  padding: '9px 20px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 700,
  cursor: enabled ? 'pointer' : 'default',
  background: enabled ? 'var(--accent)' : 'var(--bg-hover)',
  color: enabled ? 'var(--bg-primary)' : 'var(--text-muted)',
});

const chordEq = (a: QuickChatHotkey, b: QuickChatHotkey) =>
  a.key === b.key && !!a.meta === !!b.meta && !!a.control === !!b.control && !!a.alt === !!b.alt && !!a.shift === !!b.shift;

// Records a keyboard chord for a settings hotkey. While recording it suspends
// both the renderer shortcut handlers (setCapturingHotkey) and the main-process
// before-input matcher (quickChatSetCapturing) so the chord reaches us to be
// captured instead of firing. `onChange(undefined)` resets to the default.
export const HotkeyRecorder: React.FC<{
  value: QuickChatHotkey;
  defaultValue: QuickChatHotkey;
  onChange: (h: QuickChatHotkey | undefined) => void;
  platform: string;
}> = ({ value, defaultValue, onChange, platform }) => {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState('');

  const stop = () => {
    setRecording(false);
    setCapturingHotkey(false);
    window.electronAPI.quickChatSetCapturing?.(false);
  };
  const start = () => {
    setHint('');
    setRecording(true);
    setCapturingHotkey(true);
    window.electronAPI.quickChatSetCapturing?.(true);
  };
  // Safety net: never leave matching suspended if the modal unmounts mid-record.
  useEffect(() => () => { setCapturingHotkey(false); window.electronAPI.quickChatSetCapturing?.(false); }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { stop(); return; }
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
    const candidate = normalizeQuickChatHotkey({
      key: e.key.toLowerCase(), meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
    });
    if (!candidate) {
      setHint(`Add a modifier (${platform === 'darwin' ? '⌘ / ⌃ / ⌥' : 'Ctrl / Alt'}).`);
      return;
    }
    onChange(candidate);
    stop();
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onKeyDown={recording ? onKeyDown : undefined}
          onClick={() => (recording ? stop() : start())}
          style={{
            minWidth: 140, padding: '8px 12px', borderRadius: 9, cursor: 'pointer', fontSize: 12,
            border: `1px solid ${recording ? 'var(--accent)' : 'var(--border)'}`,
            background: 'var(--bg-primary)',
            color: recording ? 'var(--text-secondary)' : 'var(--text-primary)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontWeight: 600,
            boxShadow: recording ? '0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent)' : 'none',
          }}
        >
          {recording ? 'Press keys… (Esc)' : formatQuickChatHotkey(value, platform)}
        </button>
        {!recording && !chordEq(value, defaultValue) && (
          <button
            onClick={() => onChange(undefined)}
            title="Reset to default"
            style={{ ...ghostBtnStyle, color: 'var(--text-muted)' }}
          >
            Reset
          </button>
        )}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--accent-red)', marginTop: 6 }}>{hint}</div>}
    </div>
  );
};
