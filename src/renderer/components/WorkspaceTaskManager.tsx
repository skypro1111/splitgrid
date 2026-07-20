import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TerminalProcessInfo,
  TerminalRendererMetrics,
  TerminalResourceInfo,
  TerminalResourceSnapshot,
  Workspace,
} from '../../shared/types';

interface WorkspaceTaskManagerProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  getRendererMetricsSnapshot: () => TerminalRendererMetrics[];
}

type Container = Workspace['containers'][number];

interface RateInfo {
  inputBps: number;
  outputBps: number;
  renderMsPerSec: number;
}

interface ResourceSample {
  snapshot: TerminalResourceSnapshot;
  rendererMetrics: TerminalRendererMetrics[];
  rates: Map<string, RateInfo>;
}

// One terminal container, joined with its live session metrics + rates.
interface TermRow {
  container: Container;
  workspace: Workspace;
  session: TerminalResourceInfo;
  renderer?: TerminalRendererMetrics;
  rates?: RateInfo;
}

type ViewMode = 'grouped' | 'all';
type SortKey = 'name' | 'cpu' | 'rss' | 'buffer' | 'output' | 'render';
type SortDir = 'asc' | 'desc';

const POLL_MS = 1500;

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

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function formatPercent(value?: number): string {
  if (!Number.isFinite(value ?? NaN)) return '-';
  return `${(value ?? 0).toFixed((value ?? 0) >= 10 ? 0 : 1)}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// The value a row sorts by for a given column.
function sortValue(row: TermRow, key: SortKey): number | string {
  switch (key) {
    case 'name': return row.session.label.toLowerCase();
    case 'cpu': return row.session.processCpuPercent ?? 0;
    case 'rss': return row.session.processRssBytes ?? 0;
    case 'buffer': return row.session.bufferSize ?? 0;
    case 'output': return row.rates?.outputBps ?? 0;
    case 'render': return row.rates?.renderMsPerSec ?? 0;
  }
}

function sortRows(rows: TermRow[], key: SortKey, dir: SortDir): TermRow[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * factor;
    }
    return (av - bv) * factor;
  });
}

// Horizontal usage bar. Green by default, escalating to amber/red as it fills.
const Meter: React.FC<{ value: number; max: number; height?: number }> = ({ value, max, height = 4 }) => {
  const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
  const color = pct > 85 ? '#f14c4c' : pct > 65 ? '#e5b95c' : '#15ac91';
  return (
    <div style={{ height, marginTop: 4, borderRadius: height, background: 'var(--bg-surface)', overflow: 'hidden' }}>
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          minWidth: pct > 0 ? 2 : 0,
          background: color,
          borderRadius: height,
          transition: 'width 0.3s ease, background 0.3s ease',
        }}
      />
    </div>
  );
};

// Terminal-table grid: caret | name | renderer | pid | cpu | rss | buffer | output | render
const TERM_GRID = '18px 1.4fr 74px 58px 78px 82px 74px 78px 74px';

// A clickable column header that toggles/sets the sort. Shows an arrow when active.
const SortHeader: React.FC<{
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (col: SortKey) => void;
  align?: 'left' | 'right';
}> = ({ label, col, sortKey, sortDir, onSort, align = 'left' }) => {
  const active = sortKey === col;
  return (
    <button
      onClick={() => onSort(col)}
      title={`Sort by ${label}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 3, background: 'transparent', border: 'none',
        padding: 0, cursor: 'pointer', font: 'inherit', letterSpacing: 0, textTransform: 'uppercase',
        color: active ? 'var(--text-secondary)' : 'var(--text-muted)',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
      }}
    >
      <span>{label}</span>
      <span style={{ width: 7, opacity: active ? 1 : 0 }}>{active ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
    </button>
  );
};

export const WorkspaceTaskManager: React.FC<WorkspaceTaskManagerProps> = ({
  workspaces,
  activeWorkspaceId,
  getRendererMetricsSnapshot,
}) => {
  const [sample, setSample] = useState<ResourceSample | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(activeWorkspaceId);
  const [viewMode, setViewMode] = useState<ViewMode>('grouped');
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [procTree, setProcTree] = useState<TerminalProcessInfo[] | null>(null);
  const [killing, setKilling] = useState<number | null>(null);
  const previousSampleRef = useRef<ResourceSample | null>(null);

  useEffect(() => {
    if (selectedWorkspaceId && workspaces.some((ws) => ws.id === selectedWorkspaceId)) return;
    setSelectedWorkspaceId(activeWorkspaceId ?? workspaces[0]?.id ?? null);
  }, [activeWorkspaceId, selectedWorkspaceId, workspaces]);

  const onSort = useCallback((col: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === col) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      // New column: numeric columns default to descending (biggest first), name ascending.
      setSortDir(col === 'name' ? 'asc' : 'desc');
      return col;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const load = async () => {
      try {
        const snapshot = await window.electronAPI.getResourceSnapshot();
        const rendererMetrics = getRendererMetricsSnapshot();
        if (cancelled) return;

        const previous = previousSampleRef.current;
        const previousSessions = new Map(
          previous?.snapshot.sessions.map((session) => [session.id, session]) ?? [],
        );
        const previousRenderers = new Map(
          previous?.rendererMetrics.map((metrics) => [metrics.sessionId, metrics]) ?? [],
        );
        const elapsedSeconds = previous
          ? Math.max(0.001, (snapshot.collectedAt - previous.snapshot.collectedAt) / 1000)
          : 0;

        const rates = new Map<string, RateInfo>();
        for (const session of snapshot.sessions) {
          const prevSession = previousSessions.get(session.id);
          const renderer = rendererMetrics.find((metrics) => metrics.sessionId === session.id);
          const prevRenderer = previousRenderers.get(session.id);
          const outputBps = prevSession && elapsedSeconds > 0
            ? Math.max(0, session.outputBytes - prevSession.outputBytes) / elapsedSeconds
            : 0;
          const inputBps = prevSession && elapsedSeconds > 0
            ? Math.max(0, session.inputBytes - prevSession.inputBytes) / elapsedSeconds
            : 0;
          const currentRenderMs =
            (renderer?.renderWriteMsTotal ?? 0) +
            (renderer?.fitMsTotal ?? 0) +
            (renderer?.refreshMsTotal ?? 0);
          const previousRenderMs =
            (prevRenderer?.renderWriteMsTotal ?? 0) +
            (prevRenderer?.fitMsTotal ?? 0) +
            (prevRenderer?.refreshMsTotal ?? 0);
          const renderMsPerSec = prevRenderer && elapsedSeconds > 0
            ? Math.max(0, currentRenderMs - previousRenderMs) / elapsedSeconds
            : 0;
          rates.set(session.id, { inputBps, outputBps, renderMsPerSec });
        }

        const next = { snapshot, rendererMetrics, rates };
        previousSampleRef.current = next;
        setSample(next);
      } catch (error) {
        console.error('Failed to load resource snapshot:', error);
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(load, POLL_MS);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [getRendererMetricsSnapshot]);

  // Live process tree for the expanded terminal — its own poll, only while open.
  useEffect(() => {
    if (!expandedSessionId) {
      setProcTree(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const load = async () => {
      try {
        const tree = await window.electronAPI.getTerminalProcessTree(expandedSessionId);
        if (!cancelled) setProcTree(tree);
      } catch {
        // best effort — keep last known tree
      } finally {
        if (!cancelled) timer = window.setTimeout(load, POLL_MS);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [expandedSessionId]);

  const handleKill = useCallback(async (sessionId: string, pid: number) => {
    setKilling(pid);
    try {
      await window.electronAPI.killProcess(sessionId, pid, 'TERM');
      // Reflect the change quickly rather than waiting for the next poll.
      const tree = await window.electronAPI.getTerminalProcessTree(sessionId);
      setProcTree(tree);
    } catch {
      // ignore — the row simply stays until the next poll
    } finally {
      setKilling(null);
    }
  }, []);

  const rendererBySessionId = useMemo(
    () => new Map(sample?.rendererMetrics.map((metrics) => [metrics.sessionId, metrics]) ?? []),
    [sample?.rendererMetrics],
  );

  const sessionById = useMemo(
    () => new Map(sample?.snapshot.sessions.map((session) => [session.id, session]) ?? []),
    [sample?.snapshot.sessions],
  );

  // Build TermRows for a set of workspaces (all containers with a live session).
  const buildRows = useCallback((wss: Workspace[]): TermRow[] => {
    const rows: TermRow[] = [];
    for (const workspace of wss) {
      for (const container of workspace.containers) {
        const sessionId = container.content.terminalId;
        if (!sessionId) continue;
        const session = sessionById.get(sessionId);
        if (!session) continue;
        rows.push({
          container,
          workspace,
          session,
          renderer: rendererBySessionId.get(sessionId),
          rates: sample?.rates.get(sessionId),
        });
      }
    }
    return rows;
  }, [rendererBySessionId, sample?.rates, sessionById]);

  const workspaceRows = useMemo(() => {
    return workspaces.map((workspace) => {
      const sessions = workspace.containers
        .map((container) => container.content.terminalId)
        .filter((id): id is string => !!id)
        .map((id) => sessionById.get(id))
        .filter((session): session is TerminalResourceInfo => !!session);
      const shellCpu = sessions.reduce((sum, session) => sum + (session.processCpuPercent ?? 0), 0);
      const rssBytes = sessions.reduce((sum, session) => sum + (session.processRssBytes ?? 0), 0);
      const outputBps = sessions.reduce(
        (sum, session) => sum + (sample?.rates.get(session.id)?.outputBps ?? 0),
        0,
      );
      const renderMsPerSec = sessions.reduce(
        (sum, session) => sum + (sample?.rates.get(session.id)?.renderMsPerSec ?? 0),
        0,
      );
      const visible = sessions.filter((session) => rendererBySessionId.get(session.id)?.visible).length;
      const hiddenActive = sessions.filter((session) => {
        const renderer = rendererBySessionId.get(session.id);
        return session.status === 'connected' && renderer && !renderer.visible;
      }).length;
      return { workspace, sessions, shellCpu, rssBytes, outputBps, renderMsPerSec, visible, hiddenActive };
    });
  }, [rendererBySessionId, sample?.rates, sessionById, workspaces]);

  const selectedWorkspace = workspaces.find((ws) => ws.id === selectedWorkspaceId) ?? workspaces[0] ?? null;

  // The rows shown in the right/main panel, sorted. In 'all' mode: every
  // terminal across every workspace; in 'grouped' mode: the selected workspace.
  const visibleRows = useMemo(() => {
    const base = viewMode === 'all'
      ? buildRows(workspaces)
      : (selectedWorkspace ? buildRows([selectedWorkspace]) : []);
    return sortRows(base, sortKey, sortDir);
  }, [viewMode, workspaces, selectedWorkspace, buildRows, sortKey, sortDir]);

  const totals = workspaceRows.reduce(
    (acc, row) => ({
      shellCpu: acc.shellCpu + row.shellCpu,
      rssBytes: acc.rssBytes + row.rssBytes,
      outputBps: acc.outputBps + row.outputBps,
      renderMsPerSec: acc.renderMsPerSec + row.renderMsPerSec,
      terminals: acc.terminals + row.sessions.length,
      hiddenActive: acc.hiddenActive + row.hiddenActive,
    }),
    { shellCpu: 0, rssBytes: 0, outputBps: 0, renderMsPerSec: 0, terminals: 0, hiddenActive: 0 },
  );

  const renderPressurePercent = clamp(totals.renderMsPerSec / 10, 0, 100);

  const wsMax = {
    output: Math.max(1, ...workspaceRows.map((row) => row.outputBps)),
    render: Math.max(1, ...workspaceRows.map((row) => row.renderMsPerSec)),
  };
  const termMax = {
    rss: Math.max(1, ...visibleRows.map((row) => row.session.processRssBytes ?? 0)),
    buffer: Math.max(1, ...visibleRows.map((row) => row.session.bufferSize ?? 0)),
    output: Math.max(1, ...visibleRows.map((row) => row.rates?.outputBps ?? 0)),
    render: Math.max(1, ...visibleRows.map((row) => row.rates?.renderMsPerSec ?? 0)),
  };

  const toggle = (mode: ViewMode) => (
    <button
      onClick={() => setViewMode(mode)}
      style={{
        padding: '4px 12px', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
        background: viewMode === mode ? 'var(--bg-hover)' : 'transparent',
        color: viewMode === mode ? 'var(--text-primary)' : 'var(--text-muted)',
        borderRadius: 5,
      }}
    >
      {mode === 'grouped' ? 'By workspace' : 'All terminals'}
    </button>
  );

  const terminalTableHeader = (
    <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'grid', gridTemplateColumns: TERM_GRID, gap: 8, padding: '9px 14px', background: 'var(--bg-titlebar)', borderBottom: '1px solid var(--border)', fontSize: 10, alignItems: 'center' }}>
      <div />
      <SortHeader label="Terminal" col="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Renderer</div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>PID</div>
      <SortHeader label="CPU" col="cpu" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      <SortHeader label="RSS" col="rss" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      <SortHeader label="Buffer" col="buffer" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      <SortHeader label="Output" col="output" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      <SortHeader label="Render" col="render" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
    </div>
  );

  const renderTerminalRow = ({ container, workspace, session, renderer, rates }: TermRow) => {
    const expanded = expandedSessionId === session.id;
    const subLabel = viewMode === 'all'
      ? workspace.name
      : session.type === 'ssh'
        ? `${session.username ?? 'ssh'}@${session.host ?? 'remote'}`
        : session.processCommand ?? session.shell ?? session.cwd ?? 'local';
    return (
      <div key={`${container.id}-${session.id}`} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div
          onClick={() => setExpandedSessionId(expanded ? null : session.id)}
          style={{
            display: 'grid', gridTemplateColumns: TERM_GRID, gap: 8, padding: '10px 14px',
            alignItems: 'center', fontSize: 12, cursor: 'pointer',
            background: expanded ? 'var(--bg-hover)' : 'transparent',
          }}
        >
          <div style={{ color: 'var(--text-muted)', fontSize: 10, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: session.status === 'connected' ? '#15ac91' : session.status === 'connecting' ? '#e5b95c' : '#f14c4c',
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 550 }}>
                {session.label}
              </span>
            </div>
            <div style={{ marginTop: 3, color: 'var(--text-muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {subLabel}{renderer && !renderer.visible ? ' | hidden live' : ''}
            </div>
          </div>
          <div style={{ color: renderer?.visible ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
            {renderer?.renderer ?? '-'}
          </div>
          <div style={{ color: 'var(--text-secondary)' }}>{session.pid ?? '-'}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: (session.processCpuPercent ?? 0) > 40 ? '#f14c4c' : 'var(--text-secondary)' }}>
              {formatPercent(session.processCpuPercent)}
            </div>
            <Meter value={session.processCpuPercent ?? 0} max={100} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: 'var(--text-secondary)' }}>{formatBytes(session.processRssBytes ?? 0)}</div>
            <Meter value={session.processRssBytes ?? 0} max={termMax.rss} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: 'var(--text-secondary)' }}>{formatBytes(session.bufferSize ?? 0)}</div>
            <Meter value={session.bufferSize ?? 0} max={termMax.buffer} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: 'var(--text-secondary)' }}>{formatRate(rates?.outputBps ?? 0)}</div>
            <Meter value={rates?.outputBps ?? 0} max={termMax.output} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: (rates?.renderMsPerSec ?? 0) > 20 ? '#e5b95c' : 'var(--text-secondary)' }}>
              {(rates?.renderMsPerSec ?? 0).toFixed(1)}
            </div>
            <Meter value={rates?.renderMsPerSec ?? 0} max={termMax.render} />
          </div>
        </div>
        {expanded && (
          <ProcessTree
            sessionId={session.id}
            tree={procTree}
            type={session.type}
            killing={killing}
            onKill={handleKill}
          />
        )}
      </div>
    );
  };

  return (
    <div style={{ flex: 1, overflow: 'hidden', background: 'var(--bg-primary)', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ borderBottom: '1px solid var(--border)', padding: '14px 18px', display: 'grid', gridTemplateColumns: 'repeat(5, minmax(120px, 1fr))', gap: 10 }}>
        {[
          ['Terminals', String(totals.terminals)],
          ['Shell CPU', formatPercent(totals.shellCpu)],
          ['Shell RSS', formatBytes(totals.rssBytes)],
          ['Output', formatRate(totals.outputBps)],
          ['Render', `${totals.renderMsPerSec.toFixed(1)} ms/s`],
        ].map(([label, value]) => (
          <div key={label} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0 }}>
              {label}
            </div>
            <div style={{ marginTop: 4, fontSize: 18, fontWeight: 650, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      <div style={{ height: 3, background: 'var(--bg-surface)' }}>
        <div
          style={{
            height: '100%',
            width: `${renderPressurePercent}%`,
            background: renderPressurePercent > 70 ? '#f14c4c' : renderPressurePercent > 35 ? '#e5b95c' : '#15ac91',
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
        {toggle('grouped')}
        {toggle('all')}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>
          Click a terminal to see its process tree
        </span>
      </div>

      {viewMode === 'grouped' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(340px, 40%) minmax(480px, 1fr)', overflow: 'hidden' }}>
          <div style={{ borderRight: '1px solid var(--border)', overflow: 'auto' }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'grid', gridTemplateColumns: '1.5fr 72px 86px 86px 86px', gap: 8, padding: '9px 14px', background: 'var(--bg-titlebar)', borderBottom: '1px solid var(--border)', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0 }}>
              <div>Workspace</div>
              <div>Terms</div>
              <div>CPU</div>
              <div>Output</div>
              <div>Render</div>
            </div>
            {workspaceRows.map((row) => {
              const selected = row.workspace.id === selectedWorkspace?.id;
              return (
                <button
                  key={row.workspace.id}
                  onClick={() => setSelectedWorkspaceId(row.workspace.id)}
                  style={{
                    width: '100%', border: 'none', borderBottom: '1px solid var(--border-subtle)',
                    background: selected ? 'var(--bg-hover)' : 'transparent', color: 'var(--text-primary)',
                    display: 'grid', gridTemplateColumns: '1.5fr 72px 86px 86px 86px', gap: 8,
                    padding: '10px 14px', textAlign: 'left', cursor: 'pointer', alignItems: 'center',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: selected ? 650 : 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.workspace.name}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.visible} visible | {row.hiddenActive} hidden active | {formatBytes(row.rssBytes)}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{row.sessions.length}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: row.shellCpu > 40 ? '#f14c4c' : 'var(--text-secondary)' }}>
                      {formatPercent(row.shellCpu)}
                    </div>
                    <Meter value={row.shellCpu} max={100} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{formatRate(row.outputBps)}</div>
                    <Meter value={row.outputBps} max={wsMax.output} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: row.renderMsPerSec > 20 ? '#e5b95c' : 'var(--text-secondary)' }}>
                      {row.renderMsPerSec.toFixed(1)}
                    </div>
                    <Meter value={row.renderMsPerSec} max={wsMax.render} />
                  </div>
                </button>
              );
            })}
          </div>

          <div style={{ overflow: 'auto' }}>
            {terminalTableHeader}
            {visibleRows.length === 0 ? (
              <div style={{ padding: 18, fontSize: 12, color: 'var(--text-muted)' }}>
                No terminal sessions in this workspace.
              </div>
            ) : (
              visibleRows.map(renderTerminalRow)
            )}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {terminalTableHeader}
          {visibleRows.length === 0 ? (
            <div style={{ padding: 18, fontSize: 12, color: 'var(--text-muted)' }}>
              No terminal sessions.
            </div>
          ) : (
            visibleRows.map(renderTerminalRow)
          )}
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--border)', padding: '7px 14px', fontSize: 10, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
        <span>{sample?.snapshot.processMetricsSupported ? 'Process metrics: enabled' : 'Process metrics: unavailable'}</span>
        <span>{sample ? new Date(sample.snapshot.collectedAt).toLocaleTimeString() : 'Loading'}</span>
      </div>
    </div>
  );
};

// Expanded per-terminal process tree: the PTY root and everything it spawned,
// each with live CPU/RSS and a kill (SIGTERM) action. SSH sessions run remotely,
// so there is no local tree to show.
const ProcessTree: React.FC<{
  sessionId: string;
  tree: TerminalProcessInfo[] | null;
  type: TerminalResourceInfo['type'];
  killing: number | null;
  onKill: (sessionId: string, pid: number) => void;
}> = ({ sessionId, tree, type, killing, onKill }) => {
  if (type === 'ssh') {
    return (
      <div style={{ padding: '8px 14px 12px 40px', fontSize: 11, color: 'var(--text-muted)' }}>
        Process tree is unavailable for SSH sessions (the processes run on the remote host).
      </div>
    );
  }
  if (tree === null) {
    return <div style={{ padding: '8px 14px 12px 40px', fontSize: 11, color: 'var(--text-muted)' }}>Loading process tree…</div>;
  }
  if (tree.length === 0) {
    return <div style={{ padding: '8px 14px 12px 40px', fontSize: 11, color: 'var(--text-muted)' }}>No child processes.</div>;
  }
  const maxRss = Math.max(1, ...tree.map((p) => p.rssBytes));
  return (
    <div style={{ padding: '4px 14px 10px 14px', background: 'var(--bg-primary)' }}>
      {tree.map((proc) => (
        <div
          key={proc.pid}
          style={{
            display: 'grid', gridTemplateColumns: '1fr 60px 84px 90px 60px', gap: 8,
            alignItems: 'center', padding: '5px 6px', fontSize: 11,
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ minWidth: 0, paddingLeft: proc.depth * 14, display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)' }}>
            {proc.depth > 0 && <span style={{ color: 'var(--text-muted)' }}>└</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={proc.command}>
              {proc.command}
            </span>
          </div>
          <div style={{ color: 'var(--text-muted)' }}>{proc.pid}</div>
          <div style={{ color: proc.cpuPercent > 40 ? '#f14c4c' : 'var(--text-secondary)' }}>{formatPercent(proc.cpuPercent)}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: 'var(--text-secondary)' }}>{formatBytes(proc.rssBytes)}</div>
            <Meter value={proc.rssBytes} max={maxRss} height={3} />
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onKill(sessionId, proc.pid); }}
            disabled={killing === proc.pid}
            title="Send SIGTERM to this process"
            style={{
              justifySelf: 'end', padding: '2px 8px', fontSize: 10, fontWeight: 600,
              border: '1px solid var(--border)', borderRadius: 4, cursor: killing === proc.pid ? 'default' : 'pointer',
              background: 'transparent', color: killing === proc.pid ? 'var(--text-muted)' : '#f14c4c',
              opacity: killing === proc.pid ? 0.5 : 1,
            }}
          >
            {killing === proc.pid ? '…' : 'Kill'}
          </button>
        </div>
      ))}
    </div>
  );
};
