import React, { useEffect, useRef, useState } from 'react';
import type { HistoryEstimate, HistoryProgress, HistoryStatus } from '../../shared/types';
import { Row, Toggle, ghostBtnStyle, primaryBtnStyle } from './settings-ui';
import { HistoryDistillSettings } from './HistoryDistillSettings';

// ─── Settings → Workspace history ────────────────────────────────────────────
// Opt-in local search over past Claude Code sessions. Unlike the draft toggles
// around it, this acts immediately through the history:* IPC: turning it on is
// consent to a download, so it goes through a confirm step that first shows
// what it costs (history:estimate), and main persists historyEnabled only once
// the install succeeded. Turning it off asks whether to also delete what it put
// on disk — deleting is the suggested choice.

/** 1.2 GB / 310 MB / 48 KB. Binary units, one decimal below 10. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  if (i === 0) return `${Math.round(v)} B`;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "under a minute" / "about 25 minutes" / "about 2 h 10 min". */
export function formatMinutes(min: number): string {
  if (!Number.isFinite(min) || min < 1) return 'under a minute';
  const total = Math.round(min);
  if (total < 60) return `about ${total} minute${total === 1 ? '' : 's'}`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `about ${h} h ${m} min` : `about ${h} h`;
}

const count = (n: number) => n.toLocaleString('en-US');

// Every electronAPI call is optional-chained: a renderer reloaded against an
// older preload (dev) has none of the history* methods, and a TypeError out of a
// click handler replaces the whole app with the boot-error screen.
const STALE_PRELOAD = 'This build cannot do that — restart SplitGrid and try again.';
const errText = (err: unknown) => (err as Error)?.message || String(err);

const ACTIVE: ReadonlyArray<HistoryProgress['state']> = ['installing', 'indexing', 'paused'];

type Phase = 'idle' | 'estimating' | 'confirm' | 'enabling' | 'confirmOff' | 'disabling';

const panelStyle: React.CSSProperties = {
  marginTop: 14, padding: 12, borderRadius: 10,
  border: '1px solid var(--border)', background: 'var(--bg-primary)',
};
const noteStyle: React.CSSProperties = { fontSize: 11, lineHeight: 1.55, color: 'var(--text-muted)' };
const valueStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5 };

/** Download bytes while installing, embedded/total chunks while indexing. A
 *  paused state carries whichever counters the paused phase was reporting. */
function progressLine(p: HistoryProgress): { text: string; fraction?: number } {
  const paused = p.state === 'paused';
  if (p.state === 'indexing' || (paused && p.totalChunks !== undefined)) {
    const done = p.embeddedChunks ?? 0;
    const total = p.totalChunks ?? 0;
    return {
      text: `${paused ? 'Indexing paused —' : 'Indexing sessions…'} ${count(done)}${total ? ` of ${count(total)}` : ''} chunks embedded`,
      fraction: total ? done / total : undefined,
    };
  }
  const done = p.downloadedBytes ?? 0;
  const total = p.totalBytes ?? 0;
  return {
    text: `${paused ? 'Download paused —' : 'Downloading the runtime and model…'} ${formatBytes(done)}${total ? ` of ${formatBytes(total)}` : ''}`,
    fraction: total ? done / total : undefined,
  };
}

export const HistorySettings: React.FC<{
  /** Persisted consent (AppSettings.historyEnabled) — only main writes it. */
  enabled: boolean;
  /** Agent integrations (draft) — the sg-history skill is dead while it is off. */
  integrations: boolean;
  /** Workspace id → name, for the per-workspace stats. */
  workspaceNames?: Record<string, string>;
  /** Persisted decision-notes consent (AppSettings.historyDistill) — only main writes it. */
  distill?: boolean;
}> = ({ enabled, integrations, workspaceNames, distill = false }) => {
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [estimate, setEstimate] = useState<HistoryEstimate | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    Promise.resolve(window.electronAPI?.historyGetStatus?.())
      .then((s) => { if (alive.current && s) setStatus(s); })
      .catch(() => {});
    return window.electronAPI?.onHistoryStatus?.((s) => { if (alive.current) setStatus(s); });
  }, []);

  // A successful enable ends when main's app-settings broadcast flips `enabled`,
  // which may land before or after the invoke reply — wait for it here.
  useEffect(() => {
    if (enabled && phase === 'enabling') setPhase('idle');
  }, [enabled, phase]);

  const progress = status?.progress;
  const active = !!progress && ACTIVE.includes(progress.state);
  // An install/index still running (e.g. started before Settings was reopened)
  // counts as on even though consent is persisted only once it completes.
  const on = phase === 'disabling' ? false : enabled || !!status?.enabled || phase === 'enabling' || active;
  const busy = phase === 'enabling' || phase === 'disabling';

  const startEnable = () => {
    setError('');
    const call = window.electronAPI?.historyEstimate;
    if (!call) { setError(STALE_PRELOAD); return; }
    setPhase('estimating');
    call()
      .then((e) => { if (alive.current) { setEstimate(e); setPhase('confirm'); } })
      .catch((err: unknown) => { if (alive.current) { setError(`Could not check your transcripts: ${errText(err)}`); setPhase('idle'); } });
  };

  const confirmEnable = () => {
    const call = window.electronAPI?.historyEnable;
    if (!call) { setError(STALE_PRELOAD); setPhase('idle'); return; }
    setError('');
    setPhase('enabling');
    call()
      .then((r) => {
        if (!alive.current) return;
        if (!r.ok) { setError(r.error); setPhase('idle'); }
      })
      .catch((err: unknown) => { if (alive.current) { setError(errText(err)); setPhase('idle'); } });
  };

  const confirmDisable = (deleteData: boolean) => {
    const call = window.electronAPI?.historyDisable;
    if (!call) { setError(STALE_PRELOAD); setPhase('idle'); return; }
    setError('');
    setPhase('disabling');
    call({ deleteData })
      .then((r) => { if (alive.current && !r.ok) setError(r.error); })
      .catch((err: unknown) => { if (alive.current) setError(errText(err)); })
      .finally(() => { if (alive.current) setPhase('idle'); });
  };

  const onToggle = () => {
    if (on) { setPhase((p) => (p === 'confirmOff' ? 'idle' : 'confirmOff')); return; }
    if (phase === 'estimating' || phase === 'confirm') { setPhase('idle'); return; }
    startEnable();
  };

  const pauseOrResume = () => {
    const call = progress?.state === 'paused' ? window.electronAPI?.historyResume : window.electronAPI?.historyPause;
    if (!call) { setError(STALE_PRELOAD); return; }
    void call().catch((err: unknown) => setError(errText(err)));
  };

  const workspaces = status?.workspaces ?? [];
  const indexBytes = workspaces.reduce((sum, w) => sum + w.dbBytes, 0);
  const failed = progress?.state === 'error' ? progress.error || 'Workspace history stopped with an error.' : '';
  const line = progress && active ? progressLine(progress) : null;

  return (
    <div>
      <Toggle
        label="Enable workspace history"
        checked={on}
        disabled={busy}
        onChange={onToggle}
        desc={
          <>Indexes the Claude Code sessions that ran in each workspace's folder so agents can search
          past decisions through the <code>sg-history</code> skill (requires Agent integrations). It is
          local and private: a local embedding model does the work and nothing is uploaded. Off by
          default — turning it on downloads the llama.cpp runtime and a ~310&nbsp;MB model, after you
          confirm. Applies immediately, not on Save.</>
        }
      />

      {!integrations && (
        <div style={{ ...noteStyle, marginTop: 10 }}>
          Agent integrations is off, so agents cannot use the <code>sg-history</code> skill yet —
          indexing still works. Turn on Agent integrations above to let agents search it.
        </div>
      )}

      {phase === 'estimating' && (
        <div style={{ ...noteStyle, marginTop: 10 }} aria-live="polite">Checking your Claude Code transcripts…</div>
      )}

      {phase === 'confirm' && estimate && (
        <div style={panelStyle} role="group" aria-label="What enabling workspace history costs">
          <div style={{ ...valueStyle, fontWeight: 600, marginBottom: 10 }}>
            {estimate.transcriptFiles > 0
              ? `Found ${count(estimate.transcriptFiles)} transcript file${estimate.transcriptFiles === 1 ? '' : 's'} (${formatBytes(estimate.transcriptBytes)}) from Claude Code sessions in your workspace folders.`
              : 'No Claude Code transcripts found in your workspace folders yet — new sessions are indexed as they happen.'}
          </div>
          <Row label="Download">
            <span style={valueStyle}>
              {formatBytes(estimate.downloadBytes)} once — the llama.cpp runtime plus the EmbeddingGemma model (~310 MB)
            </span>
          </Row>
          <Row label="Disk use">
            <span style={valueStyle}>about {formatBytes(estimate.diskBytes)} — runtime, model and the workspace indexes</span>
          </Row>
          <Row label="First import">
            <span style={valueStyle}>{formatMinutes(estimate.firstImportMinutes)} in the background; you can pause it</span>
          </Row>
          <div style={noteStyle}>
            Everything stays on this machine: transcripts are read and embedded locally and the indexes
            never leave it. The only network access is this download.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" onClick={confirmEnable} style={primaryBtnStyle(true)}>Download and enable</button>
            <button type="button" onClick={() => setPhase('idle')} style={ghostBtnStyle}>Cancel</button>
          </div>
        </div>
      )}

      {phase === 'enabling' && !line && (
        <div style={{ ...noteStyle, marginTop: 10 }} aria-live="polite">Setting up workspace history…</div>
      )}

      {line && phase !== 'disabling' && (
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ ...valueStyle, flex: 1, minWidth: 0 }} aria-live="polite">{line.text}</span>
            <button type="button" onClick={pauseOrResume} style={ghostBtnStyle}>
              {progress?.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
          </div>
          {line.fraction !== undefined && (
            <div
              role="progressbar" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(1, line.fraction) * 100)}
              style={{ marginTop: 8, height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}
            >
              <div style={{
                height: '100%', width: `${Math.min(1, line.fraction) * 100}%`,
                background: progress?.state === 'paused' ? 'var(--text-muted)' : 'var(--accent)',
                transition: 'width 0.3s',
              }} />
            </div>
          )}
        </div>
      )}

      {enabled && phase !== 'confirmOff' && phase !== 'disabling' && (
        <div style={panelStyle}>
          {workspaces.length === 0 ? (
            <div style={noteStyle}>No workspace sessions indexed yet.</div>
          ) : (
            <>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {workspaces.map((w) => (
                  <li key={w.workspaceId} style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
                    <span style={{
                      ...valueStyle, fontWeight: 600, flex: 1, minWidth: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {workspaceNames?.[w.workspaceId] || `Other workspace (${w.workspaceId.slice(0, 8)})`}
                    </span>
                    <span style={{ ...noteStyle, flexShrink: 0 }}>
                      {count(w.sessions)} session{w.sessions === 1 ? '' : 's'} · {count(w.chunks)} chunks
                      {w.embeddedChunks < w.chunks ? ` (${count(w.embeddedChunks)} embedded)` : ''} · {formatBytes(w.dbBytes)}
                    </span>
                  </li>
                ))}
              </ul>
              <div style={{ ...noteStyle, marginTop: 8 }}>Indexes use {formatBytes(indexBytes)} in total.</div>
            </>
          )}
        </div>
      )}

      {/* Decision notes: a second, separately confirmed opt-in that only
          means something while history itself is on. */}
      {enabled && phase !== 'confirmOff' && phase !== 'disabling' && (
        <HistoryDistillSettings distill={distill} status={status?.distill} paused={progress?.state === 'paused'} />
      )}

      {phase === 'confirmOff' && (
        <div style={panelStyle} role="group" aria-label="Turn off workspace history">
          <div style={{ ...valueStyle, fontWeight: 600 }}>Turn off workspace history?</div>
          <div style={{ ...noteStyle, marginTop: 6 }}>
            Indexing stops and agents can no longer search past sessions. Deleting also removes the
            llama.cpp runtime, the embedding model and every workspace index
            {indexBytes ? ` (indexes: ${formatBytes(indexBytes)})` : ''}. Keeping them lets you turn it
            back on without downloading again; nothing runs while it is off.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {/* Deleting is the suggested choice: no resources left behind. */}
            <button type="button" autoFocus onClick={() => confirmDisable(true)} style={primaryBtnStyle(true)}>
              Turn off and delete data
            </button>
            <button type="button" onClick={() => confirmDisable(false)} style={ghostBtnStyle}>
              Turn off, keep data
            </button>
            <button type="button" onClick={() => setPhase('idle')} style={{ ...ghostBtnStyle, color: 'var(--text-muted)' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'disabling' && (
        <div style={{ ...noteStyle, marginTop: 10 }} aria-live="polite">Turning off workspace history…</div>
      )}

      {(error || failed) && (
        <div style={{ fontSize: 11, lineHeight: 1.5, marginTop: 10, color: 'var(--accent-red)' }} role="alert">
          {error || failed}
        </div>
      )}

      {/* A failed enable may leave a partial download behind; let the user
          clear it rather than leaving it on disk. */}
      {!on && (error || failed) && phase === 'idle' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={startEnable} style={ghostBtnStyle}>Try again</button>
          <button type="button" onClick={() => confirmDisable(true)} style={ghostBtnStyle}>Remove downloaded files</button>
        </div>
      )}
    </div>
  );
};
