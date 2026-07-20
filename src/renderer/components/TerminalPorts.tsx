import React, { useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { PortsIcon } from './Icons';
import type { TerminalListenPort } from '../../shared/types';

// Per-terminal ports control: a small icon (with a count) shown next to the
// terminal's process in the sidebar. Click → a popover listing every port the
// terminal's process tree is LISTENing on, each openable in the browser and
// with a "kill" action that terminates the holding process (cross-platform:
// host kill / taskkill / wsl kill, routed in main by session context).

const POPOVER_W = 240;
const POPOVER_EST_H = 240;

export function openPort(port: number): void {
  void window.electronAPI.openExternal(`http://localhost:${port}`);
}

function anchor(el: HTMLElement): { left: number; top: number } {
  const r = el.getBoundingClientRect();
  const top = Math.max(8, Math.min(r.top, window.innerHeight - POPOVER_EST_H - 8));
  return { left: r.right + 8, top };
}

interface Props {
  sessionId: string;
  ports: TerminalListenPort[];
  /** Workspace/terminal label shown in the popover header. */
  label?: string;
}

export const TerminalPortsButton: React.FC<Props> = ({ sessionId, ports, label }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  // PIDs currently being killed (optimistic disable until the next poll drops them).
  const [killing, setKilling] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const el = e.currentTarget;
    setOpen((cur) => {
      if (!cur) { setPos(anchor(el)); setError(null); }
      return !cur;
    });
  }, []);

  const kill = useCallback(async (pids: number[]) => {
    setError(null);
    setKilling((prev) => { const next = new Set(prev); pids.forEach((p) => next.add(p)); return next; });
    try {
      const results = await Promise.all(pids.map((pid) => window.electronAPI.killProcess(sessionId, pid, 'KILL')));
      const failed = results.find((r) => !r.ok);
      if (failed) setError(failed.error ?? 'Failed to terminate');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setKilling((prev) => { const next = new Set(prev); pids.forEach((p) => next.delete(p)); return next; });
    }
  }, [sessionId]);

  if (ports.length === 0) return null;

  const popover = open && ReactDOM.createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9050 }} onClick={() => setOpen(false)} onMouseDown={() => setOpen(false)} />
      <div
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', left: pos.left, top: pos.top, zIndex: 9100, width: POPOVER_W,
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '8px 12px', fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)',
          borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 8,
        }}>
          <span>Ports</span>
          {label && <span style={{ color: 'var(--text-muted)', fontWeight: 400, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>}
        </div>
        <div style={{ maxHeight: 240, overflowY: 'auto' }}>
          {ports.map((p) => {
            const busy = p.pids.some((pid) => killing.has(pid));
            return (
              <div key={p.port} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px' }}>
                <span
                  onClick={() => openPort(p.port)}
                  title={`Open http://localhost:${p.port}`}
                  style={{
                    fontSize: 12, fontVariantNumeric: 'tabular-nums', cursor: 'pointer',
                    color: 'var(--accent, #4ea1ff)', fontWeight: 600,
                  }}
                >
                  :{p.port}
                </span>
                <span style={{ flex: 1, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  pid {p.pids.join(', ')}
                </span>
                <button
                  onClick={() => kill(p.pids)}
                  disabled={busy}
                  title={`Kill the process holding :${p.port}`}
                  style={{
                    flexShrink: 0, fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 4,
                    border: '1px solid color-mix(in srgb, var(--accent-red, #f14c4c) 40%, transparent)',
                    background: 'transparent',
                    color: busy ? 'var(--text-muted)' : 'var(--accent-red, #f14c4c)',
                    cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
                  }}
                >
                  {busy ? '…' : 'Kill'}
                </button>
              </div>
            );
          })}
        </div>
        {error && (
          <div style={{ padding: '6px 12px', fontSize: 10, color: 'var(--accent-red, #f14c4c)', borderTop: '1px solid var(--border)' }}>
            {error}
          </div>
        )}
      </div>
    </>,
    document.body,
  );

  return (
    <span style={{ flexShrink: 0 }} onMouseDown={(e) => e.stopPropagation()}>
      <button
        onClick={toggle}
        title={`${ports.length} port${ports.length > 1 ? 's' : ''} — click to open / kill`}
        style={{
          display: 'flex', alignItems: 'center', gap: 2, padding: '0 3px', height: 16,
          border: 'none', borderRadius: 4, cursor: 'pointer',
          background: open ? 'var(--bg-hover)' : 'transparent',
          color: open ? 'var(--text-primary)' : 'var(--accent, #4ea1ff)',
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = 'transparent'; }}
      >
        <PortsIcon size={11} />
        <span style={{ fontSize: 9, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{ports.length}</span>
      </button>
      {popover}
    </span>
  );
};
