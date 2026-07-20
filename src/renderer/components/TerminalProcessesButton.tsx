import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { TerminalProcessInfo, TerminalType } from '../../shared/types';
import { subscribeTerminalProcesses, getTerminalProcInfo } from '../hooks/useTerminalProcesses';

interface Props {
  sessionId: string;
  sessionType: TerminalType;
}

const POLL_MS = 2000;
const POPOVER_WIDTH = 460;

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
}

export const TerminalProcessesButton: React.FC<Props> = ({ sessionId, sessionType }) => {
  const [open, setOpen] = useState(false);
  const [procs, setProcs] = useState<TerminalProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [childCount, setChildCount] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Background activity: light up the icon when the terminal has spawned
  // children (processCount counts the root shell, so subtract 1).
  useEffect(() => {
    const update = () => setChildCount(Math.max(0, (getTerminalProcInfo(sessionId)?.processCount ?? 0) - 1));
    const unsub = subscribeTerminalProcesses(update);
    update();
    return unsub;
  }, [sessionId]);

  const hasChildren = sessionType !== 'ssh' && childCount > 0;

  const refresh = useCallback(async () => {
    try {
      const tree = await window.electronAPI.getTerminalProcessTree(sessionId);
      setProcs(tree);
    } catch {
      setProcs([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Poll while open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: number | null = null;
    const loop = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(loop, POLL_MS);
    };
    setLoading(true);
    void loop();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [open, refresh]);

  // Close on outside click / Escape / scroll.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(8, Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - 8));
      setPos({ left, top: rect.bottom + 6 });
    }
    setOpen(true);
  };

  // Root PTY shell is depth 0; everything deeper is what it spawned.
  const spawned = procs.filter((p) => p.depth > 0).length;

  const popover = open ? ReactDOM.createPortal(
    <div
      ref={popRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', left: pos.left, top: pos.top, width: POPOVER_WIDTH,
        maxHeight: '60vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        zIndex: 10000, overflow: 'hidden', fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 11,
        color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px',
      }}>
        <span>Processes — {spawned} spawned</span>
        <button
          onClick={refresh}
          title="Refresh"
          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 2 }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          ↻
        </button>
      </div>

      <div style={{ overflow: 'auto' }}>
        {sessionType === 'ssh' ? (
          <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>
            Process list is only available for local terminals (SSH runs on the remote host).
          </div>
        ) : procs.length === 0 ? (
          <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>
            {loading ? 'Loading…' : 'No processes.'}
          </div>
        ) : (
          procs.map((p) => (
            <div
              key={p.pid}
              title={p.command}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 56px 64px 64px',
                gap: 8, alignItems: 'center',
                padding: '6px 12px',
                borderBottom: '1px solid var(--border-subtle)',
                fontSize: 12,
              }}
            >
              <div style={{
                minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                paddingLeft: Math.min(p.depth, 6) * 12,
                color: p.depth === 0 ? 'var(--text-muted)' : 'var(--text-primary)',
                fontFamily: 'var(--font-mono, monospace)',
              }}>
                {p.depth > 0 && <span style={{ color: 'var(--text-muted)' }}>└ </span>}
                {p.command}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, textAlign: 'right' }}>{p.pid}</div>
              <div style={{ color: p.cpuPercent > 40 ? '#f14c4c' : 'var(--text-secondary)', textAlign: 'right' }}>
                {formatPercent(p.cpuPercent)}
              </div>
              <div style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>{formatBytes(p.rssBytes)}</div>
            </div>
          ))
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  // Only surface the icon when the terminal actually has background activity
  // (spawned children). Stay mounted while the popover is open so it doesn't
  // disappear from under the user if the last child exits mid-view.
  if (!hasChildren && !open) return null;

  return (
    <>
      <button
        ref={btnRef}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
        title={hasChildren ? `${childCount} child process${childCount === 1 ? '' : 'es'} running` : 'Processes running in this terminal'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 20, height: 20, borderRadius: 4, flexShrink: 0,
          background: open ? 'var(--bg-hover)' : 'transparent', border: 'none', cursor: 'pointer',
          color: open ? 'var(--text-primary)' : hasChildren ? '#15ac91' : 'var(--text-muted)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={(e) => { if (!open) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = hasChildren ? '#15ac91' : 'var(--text-muted)'; } }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M5 6l1.5 1.5L5 9M8.5 9.5h2.5" />
        </svg>
      </button>
      {popover}
    </>
  );
};
