import React, { useState, useEffect, useCallback, useRef } from 'react';

export type ToastType = 'info' | 'success' | 'error' | 'loading';

// An optional inline action button (e.g. "Cancel" on a long-running sync toast).
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastEntry {
  id: number;
  type: ToastType;
  message: string;
  detail?: string;
  dismissAt?: number; // 0 = manual dismiss
  action?: ToastAction; // inline button; cleared by passing action:null to update
}

let nextId = 1;

// Every mounted ToastContainer registers here. A new toast goes to the most
// recently mounted host that is currently visible (IDE panes in background
// workspaces stay mounted but hidden), else to the app-level `fixed` fallback.
// Ids are global, so update/dismiss fan out and each host ignores unknown ids.
interface ToastHost {
  add: (t: Omit<ToastEntry, 'id'>) => number;
  update: (id: number, patch: Partial<Omit<ToastEntry, 'id'>>) => void;
  dismiss: (id: number) => void;
  fallback: boolean;
  isVisible: () => boolean;
}
const hosts: ToastHost[] = [];

function pickHost(): ToastHost | undefined {
  for (let i = hosts.length - 1; i >= 0; i--) {
    if (!hosts[i].fallback && hosts[i].isVisible()) return hosts[i];
  }
  return hosts.find((h) => h.fallback) ?? hosts[hosts.length - 1];
}

const AUTO_DISMISS_MS = 1000;

/** Show a toast. Returns an id for updating/dismissing. */
export function toast(message: string, opts?: { type?: ToastType; detail?: string; duration?: number; action?: ToastAction }): number {
  const type = opts?.type ?? 'info';
  const duration = opts?.duration ?? (type === 'loading' ? 0 : AUTO_DISMISS_MS);
  return pickHost()?.add({ type, message, detail: opts?.detail, action: opts?.action, dismissAt: duration > 0 ? Date.now() + duration : 0 }) ?? 0;
}

toast.success = (message: string, detail?: string) => toast(message, { type: 'success', detail });
toast.error = (message: string, detail?: string) => toast(message, { type: 'error', detail, duration: 3000 });
toast.loading = (message: string, detail?: string, action?: ToastAction) => toast(message, { type: 'loading', detail, action });
toast.update = (id: number, patch: { message?: string; detail?: string; type?: ToastType; duration?: number; action?: ToastAction | null }) => {
  const update: Partial<Omit<ToastEntry, 'id'>> = {};
  if (patch.message !== undefined) update.message = patch.message;
  if (patch.detail !== undefined) update.detail = patch.detail;
  if (patch.type !== undefined) update.type = patch.type;
  // action:null explicitly clears the button (e.g. once a sync finishes).
  if (patch.action !== undefined) update.action = patch.action ?? undefined;
  if (patch.duration !== undefined) {
    update.dismissAt = patch.duration > 0 ? Date.now() + patch.duration : 0;
  } else if (patch.type && patch.type !== 'loading') {
    update.dismissAt = Date.now() + AUTO_DISMISS_MS;
  }
  for (const h of hosts) h.update(id, update);
};
toast.dismiss = (id: number) => { for (const h of hosts) h.dismiss(id); };

const ICONS: Record<ToastType, React.ReactNode> = {
  info: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--accent-blue)" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.5" /><path d="M8 7v4" /><circle cx="8" cy="5" r="0.5" fill="var(--accent-blue)" stroke="none" />
    </svg>
  ),
  success: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--accent-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" /><path d="M5.5 8.5l2 2 3.5-4" />
    </svg>
  ),
  error: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--accent-red)" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.5" /><path d="M6 6l4 4M10 6l-4 4" />
    </svg>
  ),
  loading: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--accent-blue)" strokeWidth="1.5" strokeLinecap="round" style={{ animation: 'toast-spin 0.8s linear infinite' }}>
      <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" />
    </svg>
  ),
};

/** Renders inside the IDE container (not a portal). Place it as last child of a position:relative parent.
 *  `fixed` makes it the app-wide fallback host, pinned to the window corner. */
export const ToastContainer: React.FC<{ fixed?: boolean }> = ({ fixed = false }) => {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const remove = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
  }, []);

  const scheduleRemoval = useCallback((id: number, dismissAt: number) => {
    if (dismissAt <= 0) return;
    const existing = timersRef.current.get(id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, dismissAt - Date.now());
    const timer = setTimeout(() => remove(id), delay);
    timersRef.current.set(id, timer);
  }, [remove]);

  const add = useCallback((entry: Omit<ToastEntry, 'id'>): number => {
    const id = nextId++;
    const t = { ...entry, id };
    setToasts(prev => [...prev, t]);
    if (t.dismissAt && t.dismissAt > 0) scheduleRemoval(id, t.dismissAt);
    return id;
  }, [scheduleRemoval]);

  const update = useCallback((id: number, patch: Partial<Omit<ToastEntry, 'id'>>) => {
    setToasts(prev => prev.map(t => {
      if (t.id !== id) return t;
      const updated = { ...t, ...patch };
      if (updated.dismissAt && updated.dismissAt > 0) {
        scheduleRemoval(id, updated.dismissAt);
      }
      return updated;
    }));
  }, [scheduleRemoval]);

  useEffect(() => {
    const host: ToastHost = {
      add,
      update,
      dismiss: remove,
      fallback: fixed,
      // offsetParent is null when an ancestor is display:none (hidden workspace).
      isVisible: () => !!rootRef.current?.offsetParent,
    };
    hosts.push(host);
    return () => {
      const i = hosts.indexOf(host);
      if (i >= 0) hosts.splice(i, 1);
    };
  }, [add, update, remove, fixed]);

  // The (empty) wrapper always renders so visibility can be checked from it.
  return (
    <div ref={rootRef} style={{
      position: fixed ? 'fixed' : 'absolute', bottom: 12, right: 12, zIndex: fixed ? 3000 : 100,
      display: 'flex', flexDirection: 'column-reverse', gap: 6, maxWidth: 300,
      pointerEvents: 'none',
    }}>
      {toasts.map(t => (
        <div
          key={t.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 10px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
            color: 'var(--text-primary)',
            fontSize: 11,
            fontFamily: 'var(--font-sans)',
            animation: 'toast-in 0.15s ease-out',
            pointerEvents: 'auto',
          }}
        >
          <span style={{ flexShrink: 0 }}>{ICONS[t.type]}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.message}
            {t.detail && <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>{t.detail}</span>}
          </span>
          {t.action && (
            <button
              onClick={t.action.onClick}
              style={{
                flexShrink: 0, marginLeft: 2,
                padding: '2px 8px', borderRadius: 4,
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--accent-blue)', fontSize: 11, fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
};
