import { useEffect, useRef } from 'react';
import type { Workspace } from '../../shared/types';

// ─── Agent history bridge (renderer side) ────────────────────────────────────
// The history index lives in main, but only the renderer knows the live layout —
// which workspace holds a given terminal. Main asks (keyed by reqId) and we
// answer with that workspace's id and folder; main then queries the index scoped
// to it. Nothing else crosses: no search ever runs here.
//
// SCOPE: strictly the workspace that CONTAINS the calling terminal. Unlike the
// SFTP bridge there is no "only one workspace, use it" fallback — an unknown
// terminal is refused, so a stray or forged terminal id can never be answered
// with some other workspace's history.

interface BridgeDeps {
  workspaces: Workspace[];
}

type Reply = { ok: boolean; data?: Record<string, unknown>; error?: string };

/** Resolve the caller's workspace from the layout (pure; exported for tests). */
export function resolveHistoryCaller(workspaces: Workspace[], terminal: string): Reply {
  const ws = terminal
    ? workspaces.find((w) => w.containers.some((c) => c.content.terminalId === terminal))
    : undefined;
  if (!ws) {
    return { ok: false, error: 'unknown_terminal', data: { message: 'cannot locate the calling terminal\'s workspace' } };
  }
  return { ok: true, data: { workspaceId: ws.id, workingDirectory: ws.workingDirectory ?? null } };
}

export function useHistoryAgentBridge(deps: BridgeDeps): void {
  // The IPC listener is registered once; read live state through a ref so it
  // always sees the current workspaces without re-subscribing.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const unsub = window.electronAPI.onHistoryResolve(({ reqId, terminal }) => {
      let reply: Reply;
      try {
        reply = resolveHistoryCaller(depsRef.current.workspaces, terminal);
      } catch (err) {
        reply = { ok: false, error: (err as Error).message || 'internal_error' };
      }
      window.electronAPI.sendHistoryContext({ reqId, ...reply });
    });
    return unsub;
  }, []);
}
