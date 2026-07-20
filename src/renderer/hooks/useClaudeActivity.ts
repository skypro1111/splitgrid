import { useEffect, useState } from 'react';
import type { ClaudeActivityState } from '../../shared/types';

/**
 * Live map of terminal session id -> agent working state, sourced from the
 * activity receiver in main (fed by lifecycle hooks). Only terminals running a
 * hooked agent appear, so absence simply means "no agent / not reporting".
 */
export function useClaudeActivity(): Map<string, ClaudeActivityState> {
  const [states, setStates] = useState<Map<string, ClaudeActivityState>>(new Map());

  useEffect(() => {
    let cancelled = false;

    window.electronAPI.getClaudeActivity().then((initial) => {
      if (cancelled) return;
      setStates(new Map(Object.entries(initial)));
    }).catch(() => {});

    const unsub = window.electronAPI.onClaudeActivity(({ terminalId, state }) => {
      setStates((prev) => {
        if (prev.get(terminalId) === state) return prev;
        const next = new Map(prev);
        next.set(terminalId, state);
        return next;
      });
    });

    return () => { cancelled = true; unsub(); };
  }, []);

  return states;
}
