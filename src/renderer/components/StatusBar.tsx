import React, { useEffect, useState } from 'react';
import type {
  Workspace,
  TerminalSessionInfo,
  TerminalRendererMetrics,
} from '../../shared/types';
import { basename, detectLanguage } from './ide/utils';
import { ActivityIcon } from './Icons';
import { subscribeTerminalProcesses, getLastResourceSnapshot } from '../hooks/useTerminalProcesses';

interface Props {
  activeWorkspace: Workspace | null;
  sessionById: Map<string, TerminalSessionInfo>;
  getRendererMetricsSnapshot: () => TerminalRendererMetrics[];
  onOpenResources: () => void;
  onOpenSyncSettings: () => void;
}

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

type SyncStatus = 'off' | 'idle' | 'synced' | 'error';

function deriveSync(ws: Workspace | null): { status: SyncStatus; lastAt?: number } {
  const sync = ws?.sync;
  if (!sync?.enabled) return { status: 'off' };
  const enabled = sync.targets.filter((t) => t.enabled);
  if (enabled.length === 0) return { status: 'off' };
  if (enabled.some((t) => t.lastSyncStatus === 'error')) return { status: 'error' };
  const times = enabled.map((t) => t.lastSyncAt ?? 0).filter((t) => t > 0);
  if (times.length > 0) return { status: 'synced', lastAt: Math.max(...times) };
  return { status: 'idle' };
}

const STATUS_DOT: Record<string, string> = {
  connected: '#15ac91',
  connecting: '#e5b95c',
  disconnected: 'var(--text-muted)',
  error: '#f14c4c',
  synced: '#15ac91',
  idle: '#888',
};

const Segment: React.FC<{
  onClick?: () => void;
  title?: string;
  children: React.ReactNode;
}> = ({ onClick, title, children }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      display: 'flex', alignItems: 'center', gap: 5,
      height: '100%', padding: '0 6px',
      background: 'transparent', border: 'none', cursor: onClick ? 'pointer' : 'default',
      color: 'inherit', font: 'inherit', whiteSpace: 'nowrap',
    }}
    onMouseEnter={(e) => { if (onClick) e.currentTarget.style.background = 'var(--bg-hover)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
  >
    {children}
  </button>
);

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
);

export const StatusBar: React.FC<Props> = ({
  activeWorkspace,
  sessionById,
  getRendererMetricsSnapshot,
  onOpenResources,
  onOpenSyncSettings,
}) => {
  const [totals, setTotals] = useState({ terminals: 0, cpu: 0, rss: 0, hidden: 0 });
  const [cursor, setCursor] = useState<{ filePath: string; line: number; column: number } | null>(null);

  // Aggregate resource usage (all sessions across workspaces). Reuses the shared
  // resource poll from useTerminalProcesses rather than running a second
  // getResourceSnapshot loop — each snapshot shells out `ps` across every
  // terminal, so sharing one poll avoids doubling that cost.
  useEffect(() => {
    const recompute = () => {
      const snap = getLastResourceSnapshot();
      if (!snap) return;
      const metrics = getRendererMetricsSnapshot();
      const visibleById = new Map(metrics.map((m) => [m.sessionId, m.visible]));
      let cpu = 0, rss = 0, hidden = 0;
      for (const s of snap.sessions) {
        cpu += s.processCpuPercent ?? 0;
        rss += s.processRssBytes ?? 0;
        if (s.status === 'connected' && visibleById.get(s.id) === false) hidden += 1;
      }
      setTotals({ terminals: snap.sessions.length, cpu, rss, hidden });
    };
    const unsub = subscribeTerminalProcesses(recompute);
    recompute();
    return unsub;
  }, [getRendererMetricsSnapshot]);

  // IDE editors broadcast their cursor position so we can show Ln/Col here.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d && typeof d.filePath === 'string') {
        setCursor({ filePath: d.filePath, line: d.line, column: d.column });
      }
    };
    window.addEventListener('splitgrid:ide-cursor', handler);
    return () => window.removeEventListener('splitgrid:ide-cursor', handler);
  }, []);

  const ws = activeWorkspace;
  const sync = deriveSync(ws);

  // Context of the focused pane.
  const focus = (() => {
    if (!ws) return null;
    const container =
      ws.containers.find((c) => c.id === ws.focusedContainerId) ?? ws.containers[0];
    if (!container) return null;
    const content = container.content;

    if (content.type === 'terminal') {
      const s = content.terminalId ? sessionById.get(content.terminalId) : undefined;
      if (s?.type === 'ssh' || content.terminalType === 'ssh') {
        const who = s ? `${s.username ?? 'ssh'}@${s.host ?? 'remote'}` : (content.label ?? 'SSH');
        return { text: who, status: s?.status };
      }
      const shell = s?.shell ?? content.shell;
      const cwd = s?.cwd ?? ws.workingDirectory ?? content.cwd;
      return {
        text: `${shell ? basename(shell) : 'shell'}${cwd ? ` · ${cwd}` : ''}`,
        status: s?.status,
      };
    }
    if (content.type === 'ide') {
      const file = content.ideState?.activeTabId;
      if (!file) return { text: 'IDE' };
      const lang = detectLanguage(file);
      const lc = cursor && cursor.filePath === file ? ` · Ln ${cursor.line}, Col ${cursor.column}` : '';
      return { text: `${basename(file)} · ${lang.charAt(0).toUpperCase()}${lang.slice(1)}${lc}` };
    }
    if (content.type === 'sql') {
      const st = content.sqlState;
      return { text: st ? `${st.database || 'db'} @ ${st.connectionName || 'postgres'}` : 'SQL' };
    }
    if (content.type === 'browser') {
      return { text: content.browserUrl ?? 'Browser' };
    }
    return null;
  })();

  const cpuLabel = `${totals.cpu >= 10 ? totals.cpu.toFixed(0) : totals.cpu.toFixed(1)}%`;

  return (
    <div
      style={{
        height: 22, minHeight: 22, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, padding: '0 6px',
        background: 'var(--bg-titlebar)', borderTop: '1px solid var(--border)',
        fontSize: 11, color: 'var(--text-muted)', userSelect: 'none',
      }}
    >
      {/* Left — context of focus */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1, paddingLeft: 4 }}>
        {ws && (
          <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {ws.name}{ws.frozen ? ' ❄' : ''}
          </span>
        )}
        {focus && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', minWidth: 0 }}>
            {focus.status && <Dot color={STATUS_DOT[focus.status] ?? 'var(--text-muted)'} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {focus.text}
            </span>
          </span>
        )}
      </div>

      {/* Right — global status (clickable) */}
      <div style={{ display: 'flex', alignItems: 'center', height: '100%', flexShrink: 0 }}>
        {sync.status !== 'off' && (
          <Segment onClick={onOpenSyncSettings} title="SFTP sync — open settings">
            <Dot color={STATUS_DOT[sync.status === 'error' ? 'error' : sync.status === 'synced' ? 'synced' : 'idle']} />
            <span>
              {sync.status === 'error'
                ? 'Sync error'
                : sync.status === 'synced' && sync.lastAt
                  ? `Sync ${new Date(sync.lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : 'Sync ready'}
            </span>
          </Segment>
        )}
        <Segment onClick={onOpenResources} title="Open Resources">
          <ActivityIcon size={12} style={{ opacity: 0.8 }} />
          <span>CPU {cpuLabel}</span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>{formatBytes(totals.rss)}</span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>⎓ {totals.terminals}{totals.hidden > 0 ? ` (${totals.hidden} bg)` : ''}</span>
        </Segment>
      </div>
    </div>
  );
};
