import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_COMMANDS } from '../../shared/types';
import type { Workspace, ClaudeActivityState } from '../../shared/types';

export type ActivityKind = 'working' | 'waiting' | 'done';

export interface TerminalViewState {
  /** Per terminal session: current activity kind (null = nothing to show). */
  kinds: Map<string, ActivityKind>;
  /** Sessions that are 'done' but the user hasn't viewed since they finished. */
  unviewedSessions: Set<string>;
  /** Workspaces that contain at least one unviewed-done terminal. */
  unviewedWorkspaces: Set<string>;
}

interface Inputs {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  claudeActivity: Map<string, ClaudeActivityState>;
  sessionActivity: Map<string, 'working' | 'stopped'> | undefined;
  /**
   * Per session: last time a notify OSC was seen (ms epoch). Used as a fallback
   * completion pulse for AGENT terminals without lifecycle hooks (cursor, or a
   * remote/WSL claude/codex whose hooks don't reach us) — it forces "done" until
   * viewed. Non-agent terminals ignore it: completion notifications are agent-only.
   */
  notifyAt: Map<string, number>;
  getProcCommand: (sessionId: string) => string | undefined;
  /**
   * Fired once when a terminal newly becomes "unviewed-done" — i.e. it finished
   * while the user wasn't looking (background workspace OR unfocused window).
   * This is the exact edge we play a notification sound on.
   */
  onNewUnviewed?: (sessionId: string, workspaceId: string) => void;
}

const TICK_MS = 1000;
// How long after a web keystroke a session counts as "viewed" (the user is
// present on the web viewer). Covers typing → the agent's reply landing.
const WEB_VIEW_TTL_MS = 30_000;
const EMPTY: TerminalViewState = { kinds: new Map(), unviewedSessions: new Set(), unviewedWorkspaces: new Set() };

function kindsEqual(a: Map<string, ActivityKind>, b: Map<string, ActivityKind>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Resolves each terminal's activity kind (working / waiting / done) AND whether
 * a finished ("done") terminal has been *viewed* yet.
 *
 * - Only AGENT terminals (foreground process in AGENT_COMMANDS) get a status:
 *   claude/codex use the lifecycle-hook state map, hookless agents fall back to
 *   output content-diff ("done" only after the session has actually worked once).
 *   Every other command gets no status — the sidebar just shows its name.
 * - A terminal is "viewed" while its workspace is active AND the window is
 *   focused: we stamp viewedAt every tick, so anything that finishes while you
 *   are looking is immediately viewed, and anything that finishes in the
 *   background stays unviewed until you open that workspace.
 */
export function useTerminalViewState(inputs: Inputs): TerminalViewState {
  const [state, setState] = useState<TerminalViewState>(EMPTY);

  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  // Persistent per-session bookkeeping (no re-render).
  const everWorkedRef = useRef<Set<string>>(new Set());
  const prevKindRef = useRef<Map<string, ActivityKind | null>>(new Map());
  const doneAtRef = useRef<Map<string, number>>(new Map());
  const viewedAtRef = useRef<Map<string, number>>(new Map());
  // Last time the user typed into a session FROM THE WEB viewer. Treated as
  // "viewing" (the user is present remotely), so an agent finishing right after
  // their web input doesn't fire a desktop completion sound.
  const webInputAtRef = useRef<Map<string, number>>(new Map());
  // For firing onNewUnviewed only on the rising edge.
  const prevUnviewedRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);

  const kindFor = useCallback((sid: string): ActivityKind | null => {
    const { claudeActivity, sessionActivity, getProcCommand } = inputsRef.current;
    const cmd = getProcCommand(sid);
    // Activity status (working/waiting/done) is an AGENT-only feature. For every
    // other command we surface nothing here — the sidebar still shows the program
    // name — so plain shells and tools never get a status badge or a Done sound.
    if (!cmd || !AGENT_COMMANDS.includes(cmd)) return null;
    // claude/codex report turn state via lifecycle hooks — authoritative.
    const cs = claudeActivity.get(sid);
    if (cs === 'working') return 'working';
    if (cs === 'waiting') return 'waiting';
    if (cs === 'idle') return 'done'; // an 'idle' entry only exists post-turn
    // No hook state for this agent: either a hookless agent (cursor) or a WSL
    // claude whose hooks live in the distro's Linux ~/.claude, not the Windows one
    // splitgrid installs into. Fall through to output content-diff so it still shows
    // working/done.
    const os = sessionActivity?.get(sid);
    if (os === 'working') return 'working';
    if (os === 'stopped' && everWorkedRef.current.has(sid)) return 'done';
    return null;
  }, []);

  const recompute = useCallback(() => {
    const now = Date.now();
    const focused = document.hasFocus();
    const { workspaces, activeWorkspaceId } = inputsRef.current;

    const nextKinds = new Map<string, ActivityKind>();
    const unviewedSessions = new Set<string>();
    const unviewedWorkspaces = new Set<string>();
    const unviewedOwner = new Map<string, string>(); // sid -> workspaceId

    for (const ws of workspaces) {
      const wsViewed = ws.id === activeWorkspaceId && focused;
      for (const c of ws.containers) {
        if (c.content.type !== 'terminal' || !c.content.terminalId) continue;
        const sid = c.content.terminalId;
        // Recent web input also counts as "viewing" — the user is present on the
        // web viewer, so the desktop shouldn't fire a completion sound for it.
        const viewed = wsViewed || (now - (webInputAtRef.current.get(sid) ?? 0) < WEB_VIEW_TTL_MS);
        let kind = kindFor(sid);

        // A notify OSC pulse forces "done" (needs attention) until the terminal is
        // viewed — but ONLY for agents. Completion notifications are agent-only, so
        // a plain tool emitting a notify escape must never raise a Done. Among
        // agents, claude/codex are driven by authoritative Stop/Notification hooks,
        // so we must NOT let a notify OSC override the hook state: claude emits a
        // notify when it pauses mid-turn for a permission prompt (hook state
        // 'waiting'), and treating that as 'done' fires a false "Done" mid-work. We
        // only fall back to the OSC pulse for an agent with no hook state yet
        // (cursor, or a remote/WSL agent whose hooks don't reach us), never while
        // it's live-working.
        const cmd = inputsRef.current.getProcCommand(sid);
        const isAgent = !!cmd && AGENT_COMMANDS.includes(cmd);
        const agentHasHookState =
          (cmd === 'claude' || cmd === 'codex') && inputsRef.current.claudeActivity.get(sid) !== undefined;
        const notifiedAt = inputsRef.current.notifyAt.get(sid) ?? 0;
        if (isAgent && !agentHasHookState && kind !== 'working' && notifiedAt > (viewedAtRef.current.get(sid) ?? 0)) {
          kind = 'done';
        }

        if (kind === 'working') everWorkedRef.current.add(sid);
        // Stamp the moment it *enters* done.
        if (kind === 'done' && prevKindRef.current.get(sid) !== 'done') {
          doneAtRef.current.set(sid, now);
        }
        prevKindRef.current.set(sid, kind);
        if (viewed) viewedAtRef.current.set(sid, now);

        if (kind) nextKinds.set(sid, kind);

        const unviewed =
          kind === 'done' &&
          (doneAtRef.current.get(sid) ?? 0) > (viewedAtRef.current.get(sid) ?? 0);
        if (unviewed) {
          unviewedSessions.add(sid);
          unviewedWorkspaces.add(ws.id);
          unviewedOwner.set(sid, ws.id);
        }
      }
    }

    // Fire the rising-edge callback for sessions that just became unviewed.
    // The first pass only seeds the baseline so restored "done" state on launch
    // doesn't trigger a burst of notifications.
    const onNewUnviewed = inputsRef.current.onNewUnviewed;
    if (primedRef.current && onNewUnviewed) {
      for (const [sid, wsId] of unviewedOwner) {
        if (!prevUnviewedRef.current.has(sid)) onNewUnviewed(sid, wsId);
      }
    }
    primedRef.current = true;
    prevUnviewedRef.current = unviewedSessions;

    setState((prev) =>
      kindsEqual(prev.kinds, nextKinds) &&
      setsEqual(prev.unviewedSessions, unviewedSessions) &&
      setsEqual(prev.unviewedWorkspaces, unviewedWorkspaces)
        ? prev
        : { kinds: nextKinds, unviewedSessions, unviewedWorkspaces },
    );
  }, [kindFor]);

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

  // Snappy clear when the user switches workspace.
  useEffect(() => { recompute(); }, [inputs.activeWorkspaceId, recompute]);

  // Stamp web-input activity so a session driven from the web counts as viewed
  // (suppresses the desktop "done" sound while the user is present remotely).
  useEffect(() => {
    const off = window.electronAPI.onTerminalWebInput((sid) => {
      webInputAtRef.current.set(sid, Date.now());
      recompute();
    });
    return () => off();
  }, [recompute]);

  return state;
}
