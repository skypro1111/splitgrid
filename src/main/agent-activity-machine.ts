import type { ClaudeActivityState } from '../shared/types';
import { doneDetail, waitingDetail, type HookPayload, type PendingTool } from './agent-hook-detail';

// ─── Agent turn state from lifecycle hooks (pure) ───────────────────────────
// One terminal's agent, driven by the events its hooks report. The rule that
// keeps "Done" honest: only a real end of turn (Stop / StopFailure) with
// nothing left to wake the session is Done. Everything that merely LOOKS like
// an end — an interrupt (Esc fires no Stop), a silent gap, a session starting
// or ending — goes to 'ready': the agent sits at its prompt, nothing to
// announce.
//
// The hook input (agent-hook-detail) tells apart what the bare event names
// can't:
//   - session_id: a `claude -p` the agent runs inherits this terminal's id;
//     its events belong to another session and must not move this one.
//   - agent_id: subagents and teammates report their own tool calls (also
//     after the main turn ended, when they run in the background); they say
//     nothing about the main thread's turn.
//   - notification_type: only a permission prompt or a question is a wait;
//     idle_prompt means the turn is long over (an interrupted one never sent
//     Stop), the rest (auth_success, agent_completed, …) is noise.
//   - background_tasks on Stop: a subagent or workflow still running will
//     wake the session again, so the turn isn't finished yet.

export interface TermActivity {
  state: ClaudeActivityState;
  lastEventAt: number;
  /** The session this terminal's agent runs (first seen, or the latest SessionStart). */
  session?: string;
  /** The last main-thread tool call announced and not finished (PreToolUse → PostToolUse). */
  pending?: PendingTool;
  /** Stopped, but background agents will resume the session: still working. */
  awaitingBackground?: boolean;
}

export type HookEventName = 'prompt' | 'tool' | 'stop' | 'notification' | 'session-start' | 'session-end';

// What the helpers may send (older helpers used several aliases).
const EVENT_NAMES: Record<string, HookEventName> = {
  prompt: 'prompt', 'prompt-submit': 'prompt', 'user-prompt': 'prompt', start: 'prompt', active: 'prompt',
  tool: 'tool',
  stop: 'stop', idle: 'stop', done: 'stop', end: 'stop',
  notification: 'notification', notify: 'notification', 'needs-input': 'notification', waiting: 'notification', permission: 'notification',
  'session-start': 'session-start', 'session-end': 'session-end',
};

export function hookEventName(event: string): HookEventName | null {
  return EVENT_NAMES[event.trim().toLowerCase()] ?? null;
}

// Notification types that mean "the agent is blocked on the user". A
// notification without a type (Codex's PermissionRequest, older versions) counts too.
const WAIT_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
// Background work that finishes and reports back, waking the session. Shells
// and monitors may run forever (a dev server), so they don't hold the turn open.
const WAKING_TASKS = new Set(['subagent', 'workflow', 'teammate', 'cloud session']);

/** Silence after which a working agent without a running tool is presumed back at its prompt. */
export const SAFETY_READY_MS = 600_000;
/** The same while background agents were due to wake it: they can run far longer. */
export const BACKGROUND_READY_MS = 3_600_000;

export interface Step {
  next: TermActivity;
  /** Set when the state changed: what to broadcast. */
  emit?: { state: ClaudeActivityState; detail?: string };
}

// Move to `state`. The renderer hears about it when the state changes, and on
// a terminal's first event (so it knows hooks drive this agent, even at 'ready').
function to(cur: TermActivity, now: number, state: ClaudeActivityState, extra: Partial<TermActivity> = {}, detail?: string): Step {
  const next: TermActivity = { ...cur, ...extra, state, lastEventAt: now };
  const changed = cur.state !== state || cur.lastEventAt === 0;
  return changed ? { next, emit: { state, ...(detail ? { detail } : {}) } } : { next };
}

/**
 * Apply one hook event. `prev` undefined = nothing heard from this terminal
 * yet. Returns null for an event that is ignored outright.
 */
export function applyHookEvent(prev: TermActivity | undefined, event: HookEventName, payload: HookPayload | null, now: number): Step | null {
  const cur: TermActivity = prev ?? { state: 'ready', lastEventAt: 0 };
  const sid = payload?.session_id;

  if (event === 'session-start') {
    // A different session starting while this one works is one it spawned
    // (`claude -p` from a Bash call). A new one otherwise replaces it (/clear,
    // a restart). The same session again (compaction, resume) keeps its state.
    if (sid && cur.session && sid !== cur.session) {
      if (cur.state === 'working') return null;
      return to(cur, now, 'ready', { session: sid, pending: undefined, awaitingBackground: false });
    }
    if (prev && cur.session === sid) return { next: { ...cur, lastEventAt: now } };
    return to(cur, now, 'ready', { session: sid ?? cur.session, pending: undefined, awaitingBackground: false });
  }

  if (sid) {
    if (cur.session && sid !== cur.session) return null;
  }
  const owned: TermActivity = sid && !cur.session ? { ...cur, session: sid } : cur;

  if (event === 'session-end') {
    return to(owned, now, 'ready', { session: undefined, pending: undefined, awaitingBackground: false });
  }

  // Subagents' and teammates' own events: alive, but not the main thread's turn.
  if (payload?.agent_id) {
    return { next: { ...owned, lastEventAt: owned.state === 'working' ? now : owned.lastEventAt } };
  }

  switch (event) {
    case 'prompt':
      return to(owned, now, 'working', { pending: undefined, awaitingBackground: false });

    case 'tool': {
      if (payload?.hook_event_name === 'PreToolUse' && payload.tool_name) {
        const pending = { tool_name: payload.tool_name, tool_input: payload.tool_input };
        // A question to the user arrives as a tool call, but the agent now waits on them.
        if (payload.tool_name === 'AskUserQuestion') {
          return to(owned, now, 'waiting', { pending, awaitingBackground: false }, waitingDetail(payload));
        }
        return to(owned, now, 'working', { pending, awaitingBackground: false });
      }
      if (payload?.hook_event_name === 'PostToolUse') {
        return to(owned, now, 'working', { pending: undefined, awaitingBackground: false });
      }
      return to(owned, now, 'working', { awaitingBackground: false });
    }

    case 'stop': {
      const waking = (payload?.background_tasks ?? []).some((t) => !!t.type && WAKING_TASKS.has(t.type));
      if (waking) return to(owned, now, 'working', { pending: undefined, awaitingBackground: true });
      return to(owned, now, 'idle', { pending: undefined, awaitingBackground: false }, doneDetail(payload));
    }

    case 'notification': {
      const type = payload?.notification_type;
      // The prompt has sat idle a while: whatever turn was "working" ended
      // without a Stop (an interrupt). Quietly back at the prompt.
      if (type === 'idle_prompt') {
        return owned.state === 'working' && !owned.awaitingBackground
          ? to(owned, now, 'ready', { pending: undefined })
          : { next: owned };
      }
      if (type && !WAIT_TYPES.has(type)) return { next: owned };
      // A wait only counts mid-turn: the same notifications arrive after a turn.
      if (owned.state !== 'working') return { next: owned };
      return to(owned, now, 'waiting', {}, waitingDetail(payload, owned.pending));
    }
  }
}

/**
 * The safety net for a turn that went silent: no Stop, no tool running, no
 * background agents to wait for. It never claims Done — only that the agent
 * is presumably back at its prompt.
 */
export function sweep(cur: TermActivity, now: number): Step | null {
  if (cur.state !== 'working' || cur.pending) return null;
  if (now - cur.lastEventAt <= (cur.awaitingBackground ? BACKGROUND_READY_MS : SAFETY_READY_MS)) return null;
  return to(cur, now, 'ready', { awaitingBackground: false });
}
