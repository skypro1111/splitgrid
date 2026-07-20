import { useEffect, useState } from 'react';

/**
 * Live map of terminal session id -> last "notify" timestamp (ms epoch),
 * sourced from notify OSC escape sequences in terminal output (detected in
 * main, broadcast on `agent:notify`). Agent-agnostic: any tool that emits such
 * a sequence pulses here, complementing the Claude/Codex-only OTel activity.
 *
 * useTerminalViewState reads this to mark a terminal "done" (needs attention)
 * until the user views it — driving the same badge + notification sound.
 */
export function useAgentNotify(): Map<string, number> {
  const [notifyAt, setNotifyAt] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    const unsub = window.electronAPI.onAgentNotify((sessionId) => {
      setNotifyAt((prev) => {
        const next = new Map(prev);
        next.set(sessionId, Date.now());
        return next;
      });
    });
    return () => unsub();
  }, []);

  return notifyAt;
}
