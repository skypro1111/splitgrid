import { useState, useEffect, useRef, useCallback } from 'react';

// Tabby-style "press Enter to paste saved password" affordance. When main
// detects a password/sudo prompt on an opted-in SSH session it fires
// `ssh:password-prompt` (carrying NO password — just sessionId/label/source).
// This hook tracks that offer for one terminal and exposes:
//   - `offer`        → render the inline hint when non-null
//   - `apply`        → inject the saved password (main resolves + writes it)
//   - `activeRef`/`applyRef`/`dismissRef` → stable refs the terminal's
//     once-created xterm/ghostty key handler reads to intercept Enter.

export interface SshPasswordOffer {
  label: string;
  source: 'sudo' | 'login';
}

const OFFER_TTL_MS = 30_000;

export function useSshPasswordOffer(sessionId: string) {
  const [offer, setOffer] = useState<SshPasswordOffer | null>(null);
  const sidRef = useRef(sessionId);
  sidRef.current = sessionId;
  const activeRef = useRef(false);
  useEffect(() => { activeRef.current = offer !== null; }, [offer]);

  useEffect(() => {
    const unsub = window.electronAPI.onSshPasswordPrompt((p) => {
      if (p.sessionId !== sidRef.current) return;
      setOffer({ label: p.label, source: p.source });
    });
    return unsub;
  }, []);

  // Never let a stale hint linger if the user ignores the prompt.
  useEffect(() => {
    if (!offer) return;
    const t = window.setTimeout(() => setOffer(null), OFFER_TTL_MS);
    return () => window.clearTimeout(t);
  }, [offer]);

  const apply = useCallback(() => {
    window.electronAPI.applySshPassword(sidRef.current);
    setOffer(null);
  }, []);
  const dismiss = useCallback(() => setOffer(null), []);

  // Stable handles for the terminal key handler (created once, must see latest).
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  return { offer, activeRef, applyRef, dismissRef, apply, dismiss };
}
