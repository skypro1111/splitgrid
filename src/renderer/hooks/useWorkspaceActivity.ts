import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../shared/types';

/**
 * Per-workspace output state shown in the sidebar.
 *
 * - `running`   — a NON-active workspace produced terminal output the user has
 *                 not seen, and it is still flowing (last change < IDLE_MS ago).
 * - `attention` — a NON-active workspace has unseen output but has gone quiet
 *                 for >= IDLE_MS (the task appears finished / is waiting).
 *
 * The active-and-focused workspace is always considered "seen" and never gets a
 * state. A workspace with no unseen output is absent from the map.
 */
export type WorkspaceActivity = 'running' | 'attention';

/** Per-terminal-session live state, independent of seen/unseen. */
export type SessionActivity = 'working' | 'stopped';

export interface WorkspaceActivityResult {
  workspaces: Map<string, WorkspaceActivity>;
  /** Keyed by terminal session id. 'working' = visible output changed < 5s ago. */
  sessions: Map<string, SessionActivity>;
}

const TICK_MS = 1000;
const IDLE_MS = 5000;

const EMPTY: WorkspaceActivityResult = { workspaces: new Map(), sessions: new Map() };

function wsMapsEqual(a: Map<string, WorkspaceActivity>, b: Map<string, WorkspaceActivity>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function sessionMapsEqual(a: Map<string, SessionActivity>, b: Map<string, SessionActivity>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Detects terminal working states from process CPU, not output:
 *
 *   workspace 'running'   -> background + an agent is actively working (busy)
 *   workspace 'attention' -> background + an agent worked since last seen, now idle
 *   session   'working'   -> this terminal's process tree was busy < 5s ago
 *   session   'stopped'   -> this terminal has been idle >= 5s
 *
 * Activity is driven by `getLastBusy` (last time the terminal's process tree
 * exceeded the CPU threshold). CPU ignores typing / idle TUI repaints, which is
 * what content-diff could never separate from real agent work.
 *
 * A single 1s ticker recomputes both maps and only re-renders on real change.
 */
export function useWorkspaceActivity(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  getLastBusy: (sessionId: string) => number,
): WorkspaceActivityResult {
  const [result, setResult] = useState<WorkspaceActivityResult>(EMPTY);

  // Latest inputs read by the ticker without re-subscribing it.
  const workspacesRef = useRef(workspaces);
  const activeIdRef = useRef(activeWorkspaceId);
  const getOutRef = useRef(getLastBusy);
  workspacesRef.current = workspaces;
  activeIdRef.current = activeWorkspaceId;
  getOutRef.current = getLastBusy;

  // When each workspace was last "seen". While active+focused we keep stamping
  // `now`; the moment the user switches away (or the window blurs) it freezes,
  // and any output after that point counts as unseen.
  const lastSeenAtRef = useRef<Map<string, number>>(new Map());

  const recompute = useCallback(() => {
    const now = Date.now();
    const focused = document.hasFocus();
    const wss = workspacesRef.current;
    const activeId = activeIdRef.current;
    const getOut = getOutRef.current;

    const nextWs = new Map<string, WorkspaceActivity>();
    const nextSessions = new Map<string, SessionActivity>();

    for (const ws of wss) {
      let lastOut = 0;
      for (const c of ws.containers) {
        if (c.content.type === 'terminal' && c.content.terminalId) {
          const sid = c.content.terminalId;
          const t = getOut(sid);
          if (t > lastOut) lastOut = t;
          // Per-session: was the process tree busy within the idle window?
          nextSessions.set(sid, t > 0 && now - t < IDLE_MS ? 'working' : 'stopped');
        }
      }

      const isSeen = ws.id === activeId && focused;
      if (isSeen) {
        lastSeenAtRef.current.set(ws.id, now);
        continue; // active + focused => always seen, no badge
      }

      const seenAt = lastSeenAtRef.current.get(ws.id) ?? 0;
      if (lastOut > seenAt) {
        nextWs.set(ws.id, now - lastOut < IDLE_MS ? 'running' : 'attention');
      }
    }

    setResult((prev) =>
      wsMapsEqual(prev.workspaces, nextWs) && sessionMapsEqual(prev.sessions, nextSessions)
        ? prev
        : { workspaces: nextWs, sessions: nextSessions },
    );
  }, []);

  useEffect(() => {
    recompute();
    const timer = window.setInterval(recompute, TICK_MS);
    const onFocus = () => recompute();
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onFocus);
    };
  }, [recompute]);

  // Recompute immediately when the active workspace changes so switching clears
  // / sets a badge without waiting up to a full tick.
  useEffect(() => {
    recompute();
  }, [activeWorkspaceId, recompute]);

  return result;
}
