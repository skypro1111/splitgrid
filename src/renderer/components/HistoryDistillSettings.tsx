import React, { useEffect, useRef, useState } from 'react';
import type { HistoryDistillEstimate, HistoryDistillStatus } from '../../shared/types';
import { Row, Toggle, ghostBtnStyle, primaryBtnStyle } from './settings-ui';

// ─── Settings → Workspace history → Decision notes ───────────────────────────
// The one part of workspace history that can cost money. Shown only while
// history is on. The estimate (history:distill-estimate, which reads the index
// and runs no model) is on screen BEFORE the switch can be turned on, and the
// switch only opens a confirm step; history:distill-enable is called from that
// step alone. Turning it off is immediate and keeps the notes; deleting them is
// a separate, confirmed action that is offered only while it is off (deleting
// while on would just pay to distill everything again).

/** $0 / $0.0042 / $0.37 / $12. Sub-cent amounts keep four decimals so a real spend never reads as $0.00. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** 950 / 12k / 3.4M tokens. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

const count = (n: number) => n.toLocaleString('en-US');
const STALE_PRELOAD = 'This build cannot do that — restart SplitGrid and try again.';
const errText = (err: unknown) => (err as Error)?.message || String(err);

type Phase = 'idle' | 'confirm' | 'enabling' | 'confirmDelete' | 'deleting';

const panelStyle: React.CSSProperties = {
  marginTop: 12, padding: 12, borderRadius: 10,
  border: '1px solid var(--border)', background: 'var(--bg-primary)',
};
const noteStyle: React.CSSProperties = { fontSize: 11, lineHeight: 1.55, color: 'var(--text-muted)' };
const valueStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5 };

function stateLine(s: HistoryDistillStatus): string {
  switch (s.state) {
    case 'running': return 'Distilling a session with Claude Haiku…';
    case 'paused': return 'Paused with workspace history.';
    case 'waiting': return 'Waiting to retry.';
    case 'error': return 'Stopped with an error.';
    case 'idle': return s.groupsPending ? 'Waiting for the next pass.' : 'Up to date.';
    default: return '';
  }
}

export const HistoryDistillSettings: React.FC<{
  /** Persisted consent (AppSettings.historyDistill) — only main writes it. */
  distill: boolean;
  status?: HistoryDistillStatus;
  /** Workspace history is paused (its Pause pauses this too). */
  paused: boolean;
}> = ({ distill, status, paused }) => {
  const [estimate, setEstimate] = useState<HistoryDistillEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const on = distill || phase === 'enabling';

  // The cost is shown before the switch can do anything, so fetch it as soon
  // as the section is visible with distillation off.
  useEffect(() => {
    if (distill) return;
    const call = window.electronAPI?.historyDistillEstimate;
    if (!call) return;
    setEstimating(true);
    Promise.resolve(call())
      .then((e) => { if (alive.current) setEstimate(e); })
      .catch((err: unknown) => { if (alive.current) setError(`Could not estimate the cost: ${errText(err)}`); })
      .finally(() => { if (alive.current) setEstimating(false); });
  }, [distill]);

  useEffect(() => {
    if (distill && phase === 'enabling') setPhase('idle');
  }, [distill, phase]);

  const confirmEnable = () => {
    const call = window.electronAPI?.historyDistillEnable;
    if (!call) { setError(STALE_PRELOAD); setPhase('idle'); return; }
    setError('');
    setPhase('enabling');
    call()
      .then((r) => { if (alive.current && !r.ok) { setError(r.error); setPhase('idle'); } })
      .catch((err: unknown) => { if (alive.current) { setError(errText(err)); setPhase('idle'); } });
  };

  const turnOff = () => {
    const call = window.electronAPI?.historyDistillDisable;
    if (!call) { setError(STALE_PRELOAD); return; }
    setError('');
    void call()
      .then((r) => { if (alive.current && !r.ok) setError(r.error); })
      .catch((err: unknown) => { if (alive.current) setError(errText(err)); });
  };

  const confirmDelete = () => {
    const call = window.electronAPI?.historyDeleteNotes;
    if (!call) { setError(STALE_PRELOAD); setPhase('idle'); return; }
    setError('');
    setPhase('deleting');
    call()
      .then((r) => { if (alive.current && !r.ok) setError(r.error); })
      .catch((err: unknown) => { if (alive.current) setError(errText(err)); })
      .finally(() => { if (alive.current) setPhase('idle'); });
  };

  const onToggle = () => {
    if (on) { turnOff(); return; }
    setPhase((p) => (p === 'confirm' ? 'idle' : 'confirm'));
  };

  const pauseOrResume = () => {
    const call = paused ? window.electronAPI?.historyResume : window.electronAPI?.historyPause;
    if (!call) { setError(STALE_PRELOAD); return; }
    void call().catch((err: unknown) => setError(errText(err)));
  };

  const spent = status?.spentUsd ?? estimate?.spentUsd ?? 0;
  const notes = status?.notes ?? estimate?.notes ?? 0;
  const done = status?.groupsDistilled ?? 0;
  const total = done + (status?.groupsPending ?? 0);
  const failedMsg = status && (status.state === 'error' || status.state === 'waiting') ? status.error : '';

  return (
    <div style={panelStyle} role="group" aria-label="Decision notes">
      <Toggle
        label="Decision notes (uses Claude Haiku)"
        checked={on}
        disabled={phase === 'enabling' || phase === 'deleting'}
        onChange={onToggle}
        desc={
          <>Distills finished sessions into short notes — what was decided and why, alternatives that were
          rejected, gotchas, conventions — which agents find through <code>sg-history</code> next to the
          turns they came from. Runs Claude Haiku through your Claude Code login: on a subscription that
          uses your plan limits rather than money; with an API key it is billed at the rates below. A
          session is distilled once it has been idle for 30 minutes, and never twice for the same content.
          Off by default.</>
        }
      />

      {!on && (
        <div style={{ marginTop: 10 }} aria-live="polite">
          {estimating && !estimate && <div style={noteStyle}>Estimating the cost from your index…</div>}
          {estimate && (
            <>
              <Row label="Backlog">
                <span style={valueStyle}>
                  {estimate.pendingGroups
                    ? <>{count(estimate.pendingGroups)} group{estimate.pendingGroups === 1 ? '' : 's'} of settled sessions,
                      ~{formatTokens(estimate.pendingInputTokens)} input + {formatTokens(estimate.pendingOutputTokens)} output
                      tokens ≈ <strong>{formatUsd(estimate.backlogUsd)}</strong> once</>
                    : 'Nothing to distill yet'}
                </span>
              </Row>
              <Row label="Ongoing">
                <span style={valueStyle}>
                  ≈ <strong>{formatUsd(estimate.monthlyUsd)}</strong> / month at your last 30 days' pace
                  ({count(estimate.monthlyGroups)} group{estimate.monthlyGroups === 1 ? '' : 's'},
                  ~{formatTokens(estimate.monthlyInputTokens)} input tokens)
                </span>
              </Row>
              {estimate.spentUsd > 0 && (
                <Row label="Spent so far">
                  <span style={valueStyle}>{formatUsd(estimate.spentUsd)} ({count(estimate.notes)} notes)</span>
                </Row>
              )}
              <div style={noteStyle}>
                {estimate.model} list price: ${estimate.priceInputPerMTok.toFixed(2)} per million input tokens,
                ${estimate.priceOutputPerMTok.toFixed(2)} per million output tokens. Claude Code writes each prompt to
                its 1-hour prompt cache, billed at twice the input price, and the estimate includes that. Tokens are
                estimated at about 3 characters each, so the real figure can differ.
                {estimate.unsettledGroups > 0 && ` ${count(estimate.unsettledGroups)} more group${estimate.unsettledGroups === 1 ? ' is' : 's are'} from sessions active in the last 30 minutes and will be counted once they settle.`}
              </div>
            </>
          )}
        </div>
      )}

      {phase === 'confirm' && (
        <div style={{ marginTop: 12 }} role="group" aria-label="Confirm decision notes">
          <div style={{ ...valueStyle, fontWeight: 600 }}>
            Run Claude Haiku on {estimate ? `${count(estimate.pendingGroups)} group${estimate.pendingGroups === 1 ? '' : 's'}` : 'your settled sessions'}
            {estimate ? ` (≈ ${formatUsd(estimate.backlogUsd)} at API rates)` : ''}?
          </div>
          <div style={{ ...noteStyle, marginTop: 4 }}>
            Excerpts of your past sessions (secrets already redacted) are sent to Anthropic through Claude Code,
            one group at a time in the background. You can pause or turn it off at any time; notes already
            written are kept.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={confirmEnable} style={primaryBtnStyle(true)}>Enable decision notes</button>
            <button type="button" onClick={() => setPhase('idle')} style={ghostBtnStyle}>Cancel</button>
          </div>
        </div>
      )}

      {on && status && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ ...valueStyle, flex: 1, minWidth: 0 }} aria-live="polite">
              {count(done)} of {count(total)} groups distilled · {count(notes)} notes · {stateLine(status)}
            </span>
            <button type="button" onClick={pauseOrResume} style={ghostBtnStyle}>{paused ? 'Resume' : 'Pause'}</button>
          </div>
          {total > 0 && (
            <div
              role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((done / total) * 100)}
              style={{ marginTop: 8, height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}
            >
              <div style={{ height: '100%', width: `${(done / total) * 100}%`, background: paused ? 'var(--text-muted)' : 'var(--accent)' }} />
            </div>
          )}
          <div style={{ ...noteStyle, marginTop: 6 }}>
            Spent so far: {formatUsd(spent)}, as reported by Claude Code (on a subscription this is plan usage, not a charge).
            {status.groupsUnsettled > 0 && ` ${count(status.groupsUnsettled)} group${status.groupsUnsettled === 1 ? '' : 's'} wait for their session to settle.`}
            {status.groupsFailed > 0 && ` ${count(status.groupsFailed)} gave unusable output and were skipped.`}
          </div>
        </div>
      )}

      {!on && notes > 0 && phase !== 'confirmDelete' && phase !== 'deleting' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <span style={{ ...noteStyle, flex: 1 }}>{count(notes)} decision notes are kept and still searchable.</span>
          <button type="button" onClick={() => setPhase('confirmDelete')} style={ghostBtnStyle}>Delete notes</button>
        </div>
      )}

      {phase === 'confirmDelete' && (
        <div style={{ marginTop: 10 }} role="group" aria-label="Delete decision notes">
          <div style={noteStyle}>
            Delete all {count(notes)} decision notes? Your sessions stay indexed; turning notes on again would
            distill (and pay for) them again.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" onClick={confirmDelete} style={primaryBtnStyle(true)}>Delete {count(notes)} notes</button>
            <button type="button" onClick={() => setPhase('idle')} style={ghostBtnStyle}>Cancel</button>
          </div>
        </div>
      )}

      {(error || failedMsg) && (
        <div style={{ fontSize: 11, lineHeight: 1.5, marginTop: 10, color: 'var(--accent-red)' }} role="alert">
          {error || failedMsg}
        </div>
      )}
    </div>
  );
};
