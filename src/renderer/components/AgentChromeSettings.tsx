import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, ExtChannelStatus, ExtPairingCode } from '../../shared/types';
import { EXT_PAIRING_TTL_MS } from '../../shared/ext-protocol';
import { Toggle, ghostBtnStyle } from './settings-ui';

// ─── Settings → Agent integrations → browser control ─────────────────────────
// The two Chrome gates plus the pairing block. Split out of SettingsModal
// because, unlike every other toggle there, it owns live state: a one-time
// pairing code counting down to its expiry, and a polled view of what the
// companion extension currently exposes.

/** How often the connected/activated view is refreshed while it is on screen.
 *  The extension connects, activates and drops tabs on its own schedule, so
 *  there is nothing to subscribe to — a modest poll keeps it seconds-fresh. */
const STATUS_POLL_MS = 3000;

/** m:ss for the pairing countdown. */
function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Every electronAPI call here is optional-chained: a renderer reloaded against
// an older preload (dev) has none of the ext* methods, and one TypeError out of
// a click handler replaces the whole app with the boot-error screen.
const readStatus = (): Promise<ExtChannelStatus | undefined> | undefined =>
  window.electronAPI?.extGetStatus?.();
const cancelPairingCall = (): void => {
  void window.electronAPI?.extCancelPairing?.().catch(() => {});
};

/** What a preload with no extension support reports: it can never reach the
 *  channel, which for the user is the same situation as nothing being paired. */
const UNREACHABLE: ExtChannelStatus = { connected: false, clients: [], surfaces: [] };

const monoFont = 'var(--font-mono, ui-monospace, monospace)';
const ellipsis: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

const badgeStyle = (on: boolean): React.CSSProperties => ({
  flexShrink: 0, padding: '1px 7px', borderRadius: 999, fontSize: 10, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: 0.4,
  color: on ? 'var(--accent)' : 'var(--text-muted)',
  background: on ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'var(--bg-hover)',
});

export const AgentChromeSettings: React.FC<{
  /** Master opt-in — every sub-toggle is dead while it is off. */
  integrations: boolean;
  control: boolean;
  write: boolean;
  /** Persisted value of the control gate. The draft one only takes effect on
   *  Save, and the channel reads the persisted file on every command. */
  savedControl: boolean;
  onChange: (patch: Partial<AppSettings>) => void;
}> = ({ integrations, control, write, savedControl, onChange }) => {
  const on = integrations && control;

  const [status, setStatus] = useState<ExtChannelStatus | null>(null);
  const [pairing, setPairing] = useState<ExtPairingCode | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // A code the user can no longer see is only a widened guessing budget, so a
  // live pairing window is closed when this block goes away. Tracked in a ref:
  // the cleanup must not fire when the code is merely REPLACED by a newer one.
  const codeIsLive = useRef(false);
  const closePairing = useCallback(() => {
    if (!codeIsLive.current) return;
    codeIsLive.current = false;
    cancelPairingCall();
  }, []);
  useEffect(() => () => closePairing(), [closePairing]);

  // Poll only while the block is visible. Hiding it (control OR the master
  // integrations switch going off) also closes a live pairing window — the code
  // is no longer on screen.
  useEffect(() => {
    if (!on) { setStatus(null); closePairing(); setPairing(null); return; }
    let alive = true;
    const read = () => {
      Promise.resolve(readStatus())
        .then((s) => { if (alive) setStatus(s ?? UNREACHABLE); })
        // A one-off IPC failure keeps the previous view rather than claiming the
        // extension went away; the next tick corrects it either way.
        .catch(() => { if (alive) setStatus((cur) => cur ?? UNREACHABLE); });
    };
    read();
    const timer = setInterval(read, STATUS_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [on, closePairing]);

  // 1s tick, only while a code is on screen — this is what moves the countdown.
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      // Window is dead: stop re-rendering once a second for nothing.
      if (t >= pairing.expiresAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  const remaining = pairing ? pairing.expiresAt - now : 0;
  const expired = !!pairing && remaining <= 0;

  // The code is single-use and main drops the window the instant it is accepted;
  // the renderer can't observe that directly, so a newly connected client is the
  // signal that this code has done its job.
  const clientCount = status?.clients.length ?? 0;
  const clientsAtPairStart = useRef(0);
  useEffect(() => {
    if (pairing && clientCount > clientsAtPairStart.current) {
      codeIsLive.current = false;
      setPairing(null);
    }
  }, [pairing, clientCount]);

  const beginPair = () => {
    setError('');
    clientsAtPairStart.current = clientCount;
    Promise.resolve(window.electronAPI?.extBeginPairing?.())
      .then((code) => {
        if (!code) { setError('This build cannot pair — restart SplitGrid and try again.'); return; }
        codeIsLive.current = true;
        setNow(Date.now());
        setPairing(code);
      })
      .catch((err: unknown) => setError((err as Error).message || 'Could not start pairing.'));
  };

  const cancelPair = () => {
    closePairing();
    setPairing(null);
  };

  const setControl = (v: boolean) => {
    // Turning the gate off also closes any pairing window it opened.
    if (!v) { closePairing(); setPairing(null); }
    onChange({ agentChromeControl: v, ...(v ? {} : { agentChromeWrite: false }) });
  };

  return (
    <div style={{ marginLeft: 22, marginTop: 14 }}>
      <Toggle
        label="Let agents inspect a tab in your real browser (read-only)"
        checked={on}
        disabled={!integrations}
        onChange={setControl}
        desc={
          <>Lets an agent read a tab you hand over from the companion browser extension — its text,
          HTML and screenshots. Unlike the built-in browser pane, which has its own isolated session,
          this is your real profile with your real logins. Off by default.</>
        }
      />
      <div style={{ marginLeft: 22, marginTop: 14 }}>
        <Toggle
          label="Allow agents to interact with pages (write)"
          checked={on && write}
          disabled={!on}
          onChange={(v) => onChange({ agentChromeWrite: v })}
          desc={
            <>Also permit <code>eval</code>, navigation and reloads in that tab. Arbitrary JS runs
            inside your logged-in session, so it can act as you. Off by default.</>
          }
        />
      </div>

      {on && (
        <div style={{
          marginTop: 14, padding: 12, borderRadius: 10,
          border: '1px solid var(--border)', background: 'var(--bg-primary)',
        }}>
          {pairing && !expired ? (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Type this code into the extension's popup:
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                {/* Spaced digits as the accessible name, so a screen reader
                    dictates "4 8 2 9 1 3" and not "four hundred eighty-two…". */}
                <span
                  aria-label={pairing.code.split('').join(' ')}
                  style={{
                    fontFamily: monoFont, fontSize: 22, fontWeight: 700, letterSpacing: 4,
                    color: 'var(--accent)',
                  }}
                >
                  {pairing.code}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }} aria-live="off">
                  expires in {mmss(remaining)}
                </span>
                <button type="button" onClick={cancelPair} style={{ ...ghostBtnStyle, marginLeft: 'auto' }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" onClick={beginPair} style={ghostBtnStyle}>
                {status?.connected ? 'Pair another browser' : 'Pair browser extension'}
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {expired
                  ? 'That code expired before the extension used it.'
                  : `Shows a one-time code, valid for ${Math.round(EXT_PAIRING_TTL_MS / 60000)} minutes.`}
              </span>
            </div>
          )}

          {/* Connection view. "No extension paired" and "paired but nothing
              activated" are different problems with different fixes, so they get
              different sentences. aria-live so the change is announced. */}
          <div style={{ marginTop: 12, fontSize: 11, lineHeight: 1.55, color: 'var(--text-muted)' }} aria-live="polite">
            {status === null ? (
              'Checking for a paired extension…'
            ) : !status.connected ? (
              'No extension paired. Install it in your browser, then pair it here.'
            ) : (
              <>
                <div style={{ color: 'var(--accent-green)', fontWeight: 600 }}>
                  Connected: {status.clients.map((c) => `${c.browser} (${c.clientId})`).join(', ')}
                </div>
                {status.surfaces.length === 0 ? (
                  <div style={{ marginTop: 6 }}>
                    Paired, but no tab is activated. Click the extension's toolbar icon and activate
                    the tab you want an agent to see.
                  </div>
                ) : (
                  <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {status.surfaces.map((s) => {
                      // Interaction needs BOTH gates: the extension's per-tab
                      // switch and agentChromeWrite here.
                      const interactive = s.writable && write;
                      return (
                        <li key={s.surface} style={{
                          padding: '7px 9px', borderRadius: 8, minWidth: 0,
                          border: '1px solid var(--border)', background: 'var(--bg-surface)',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ ...ellipsis, flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                              {s.title || 'Untitled tab'}
                            </span>
                            <span
                              style={badgeStyle(interactive)}
                              title={
                                interactive
                                  ? 'Both switches are on — an agent may act in this tab.'
                                  : s.writable
                                    ? 'Interaction is on for this tab in the extension, but off here.'
                                    : 'Interaction is off for this tab in the extension.'
                              }
                            >
                              {interactive ? 'interactive' : 'read-only'}
                            </span>
                          </div>
                          <div style={{ ...ellipsis, marginTop: 2 }}>{s.url}</div>
                          <div style={{ ...ellipsis, marginTop: 2, fontFamily: monoFont, opacity: 0.75 }}>{s.surface}</div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>

          {error && (
            <div style={{ fontSize: 11, marginTop: 8, color: 'var(--accent-red)' }}>{error}</div>
          )}

          <div style={{ fontSize: 11, marginTop: 10, color: 'var(--text-muted)' }}>
            Don't have the extension yet? <code>extension/README.md</code> has the build and
            load-unpacked steps.
          </div>
        </div>
      )}

      {on && !savedControl && (
        <div style={{ fontSize: 11, marginTop: 8, color: 'var(--text-muted)' }}>
          Pairing works right away; agents can only use the tab once you press Save.
        </div>
      )}
    </div>
  );
};
