import React, { useEffect, useState } from 'react';
import type { AgentThreadSummary } from '../../../shared/agent-types';

// The pane's answer to the terminal's `/resume`.
//
// The CLI does not offer /resume to SDK hosts — it is one of the commands whose
// UX is bound to the terminal — so the pane reads the CLI's own session store
// and presents the same choice itself. Picking a thread relaunches the pane's
// session with that conversation resumed.

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString();
}

export const AgentThreadPicker: React.FC<{
  cwd: string;
  /** The thread already open in this pane, marked as current. */
  currentThreadId: string;
  onResume: (sessionId: string) => void;
  onNewThread: () => void;
  onClose: () => void;
}> = ({ cwd, currentThreadId, onResume, onNewThread, onClose }) => {
  const [threads, setThreads] = useState<AgentThreadSummary[] | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .agentListThreads(cwd)
      .then((list) => { if (!cancelled) setThreads(list); })
      .catch(() => { if (!cancelled) setThreads([]); });
    return () => { cancelled = true; };
  }, [cwd]);

  const needle = filter.trim().toLowerCase();
  const visible = (threads ?? []).filter(
    (thread) => !needle || thread.summary.toLowerCase().includes(needle),
  );

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        background: 'var(--bg-primary)',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>
          Threads
        </span>
        <input
          autoFocus
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
          placeholder="Filter…"
          style={{
            flex: 1,
            minWidth: 0,
            padding: '4px 8px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            fontSize: 11,
            outline: 'none',
          }}
        />
        <button
          onClick={onNewThread}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 11,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          New
        </button>
        <button
          onClick={onClose}
          title="Close (Esc)"
          style={{
            padding: '4px 8px',
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: 12,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {threads === null ? (
          <div style={{ padding: 20, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            Reading Claude's session history…
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 20, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.6 }}>
            {threads.length === 0
              ? 'No past threads for this folder yet. A thread is recorded once it has answered once.'
              : 'Nothing matches that filter.'}
          </div>
        ) : (
          visible.map((thread) => {
            const isCurrent = thread.sessionId === currentThreadId;
            return (
              <button
                key={thread.sessionId}
                onClick={() => (isCurrent ? onClose() : onResume(thread.sessionId))}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  width: '100%',
                  padding: '8px 12px',
                  border: 'none',
                  borderBottom: '1px solid var(--border-subtle)',
                  background: 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  minWidth: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--text-primary)',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {thread.summary}
                </span>
                {isCurrent && (
                  <span style={{ fontSize: 9, color: 'var(--accent-green)', flexShrink: 0 }}>CURRENT</span>
                )}
                <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                  {relativeTime(thread.lastModified)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
