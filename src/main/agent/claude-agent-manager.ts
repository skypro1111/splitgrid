import { BrowserWindow } from 'electron';
import type {
  AgentApprovalDecision,
  AgentEvent,
  AgentPermissionMode,
  AgentSessionOptions,
  AgentThreadSummary,
} from '../../shared/agent-types';
import { agentDiag } from './agent-diagnostics';
import { ClaudeAgentSession } from './claude-agent-session';

// Owns every live Claude Code pane session and routes their events back to the
// window that opened them.
//
// A pane is NOT the owner of its session's lifetime: a Claude Code pane
// unmounts and remounts on every workspace switch, and killing the CLI each
// time would be both slow and lossy. So a pane detaches on unmount, the session
// keeps running for a grace period, and a remounting pane reattaches and
// replays the transcript. Only an explicit close, a closed window, or an
// expired grace period actually stops one.

/** How long a detached session survives before it is reaped. */
const DETACH_GRACE_MS = 5 * 60_000;

interface Entry {
  session: ClaudeAgentSession;
  webContentsId: number;
  detachTimer: NodeJS.Timeout | null;
  /**
   * Whether a pane is listening. A session emits from the moment it starts —
   * before `createSession` has even returned the id — and the pane drops events
   * whose session it does not yet know. Holding delivery until the pane
   * attaches (which replays the history) closes that gap: no lost `init`, and
   * therefore no pane stuck on "Starting…".
   */
  attached: boolean;
  createdAt: number;
}

/**
 * Past Claude threads for a working directory — the pane's answer to the
 * terminal's `/resume`, which the CLI does not expose to SDK hosts (it is a
 * terminal-bound command). Reads the CLI's own session store, so the list is
 * exactly what `claude --resume` would show.
 */
export async function listThreads(cwd: string, limit = 30): Promise<AgentThreadSummary[]> {
  if (!cwd) return [];
  try {
    const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
    const sessions = await listSessions({ dir: cwd });
    return sessions
      .slice()
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, limit)
      .map((session) => ({
        sessionId: session.sessionId,
        summary: session.customTitle || session.summary || session.firstPrompt || 'Untitled thread',
        lastModified: session.lastModified,
      }));
  } catch {
    // An older CLI, or no session store yet — an empty list is the honest answer.
    return [];
  }
}

export class ClaudeAgentManager {
  private readonly entries = new Map<string, Entry>();
  private binaryPath = '';

  /** Binary path override from app settings ('' = auto-detect). */
  setBinaryPath(path: string): void {
    this.binaryPath = path.trim();
  }

  async createSession(webContentsId: number, options: AgentSessionOptions): Promise<string> {
    const session = new ClaudeAgentSession(options, {
      binaryPath: this.binaryPath,
      // Routed through the entry so a reattached pane in another window still
      // receives the stream.
      emit: (event) => this.dispatch(event),
    });
    this.entries.set(session.id, {
      session,
      webContentsId,
      detachTimer: null,
      attached: false,
      createdAt: Date.now(),
    });
    agentDiag(session.id, 'manager:create', { webContentsId, cwd: options.cwd });
    try {
      await session.start();
    } catch (error) {
      // No pane ever learns this id, so nothing would detach (and reap) it.
      await this.stop(session.id, 'Failed to start.');
      throw error;
    }
    return session.id;
  }

  /**
   * Re-bind a still-running session to a (re)mounted pane and hand back
   * everything it has emitted. Null when the session is gone — the pane then
   * starts a fresh one.
   */
  attach(webContentsId: number, sessionId: string): AgentEvent[] | null {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      agentDiag(sessionId, 'manager:attach-miss', { webContentsId });
      return null;
    }
    if (entry.detachTimer) {
      clearTimeout(entry.detachTimer);
      entry.detachTimer = null;
    }
    entry.webContentsId = webContentsId;
    entry.attached = true;
    const replay = entry.session.replay();
    agentDiag(sessionId, 'manager:attach', { webContentsId, replayed: replay.length });
    return replay;
  }

  /** The pane went away. Keep the session warm for the grace period. */
  detach(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.attached = false;
    agentDiag(sessionId, 'manager:detach');
    if (entry.detachTimer) return;
    entry.detachTimer = setTimeout(() => {
      void this.stop(sessionId, 'Session idle with no pane attached.');
    }, DETACH_GRACE_MS);
    entry.detachTimer.unref?.();
  }

  send(sessionId: string, text: string): void {
    this.entries.get(sessionId)?.session.send(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.entries.get(sessionId)?.session.interrupt();
  }

  respondToApproval(sessionId: string, requestId: string, decision: AgentApprovalDecision): void {
    this.entries.get(sessionId)?.session.respondToApproval(requestId, decision);
  }

  respondToQuestion(
    sessionId: string,
    requestId: string,
    answers: Record<string, string> | null,
  ): void {
    this.entries.get(sessionId)?.session.respondToQuestion(requestId, answers);
  }

  async setPermissionMode(sessionId: string, mode: AgentPermissionMode): Promise<void> {
    await this.entries.get(sessionId)?.session.setPermissionMode(mode);
  }

  note(sessionId: string, text: string): void {
    this.entries.get(sessionId)?.session.note(text);
  }

  async contextUsage(sessionId: string) {
    return (await this.entries.get(sessionId)?.session.contextUsage()) ?? null;
  }

  async supportedModels(sessionId: string) {
    return (await this.entries.get(sessionId)?.session.supportedModels()) ?? [];
  }

  async setModel(sessionId: string, model: string | undefined): Promise<void> {
    await this.entries.get(sessionId)?.session.setModel(model);
  }

  /** Claude's session id for this pane, for persisting a resume cursor. */
  resumeId(sessionId: string): string | null {
    return this.entries.get(sessionId)?.session.resumeId ?? null;
  }

  async stop(sessionId: string, reason?: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.detachTimer) clearTimeout(entry.detachTimer);
    entry.detachTimer = null;
    agentDiag(sessionId, 'manager:stop', { reason: reason ?? '' });
    // Stop BEFORE forgetting the entry: the session's final `session.closed`
    // is routed through it, and an attached pane (e.g. one stopped from the
    // /agent bridge) must hear it or it keeps showing a live session.
    try {
      await entry.session.stop(reason);
    } finally {
      if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
    }
  }

  /** Tear down every session owned by a window that is going away. */
  async stopForWebContents(webContentsId: number): Promise<void> {
    const doomed = [...this.entries.entries()].filter(
      ([, entry]) => entry.webContentsId === webContentsId,
    );
    await Promise.all(doomed.map(([sessionId]) => this.stop(sessionId, 'Window closed.')));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((sessionId) => this.stop(sessionId)));
  }

  /** Live snapshots of every session, for the /agent debug bridge. */
  list(): Record<string, unknown>[] {
    return [...this.entries.values()].map((entry) => ({
      ...entry.session.snapshot(),
      webContentsId: entry.webContentsId,
      attached: entry.attached,
      detachPending: entry.detachTimer !== null,
      ageMs: Date.now() - entry.createdAt,
    }));
  }

  /** One session's snapshot, or null when the id is unknown. */
  snapshot(sessionId: string): Record<string, unknown> | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    return {
      ...entry.session.snapshot(),
      webContentsId: entry.webContentsId,
      attached: entry.attached,
      detachPending: entry.detachTimer !== null,
      ageMs: Date.now() - entry.createdAt,
    };
  }

  /** The transcript events a session has emitted, for the debug bridge. */
  replay(sessionId: string): AgentEvent[] | null {
    return this.entries.get(sessionId)?.session.replay() ?? null;
  }

  private dispatch(event: AgentEvent): void {
    const entry = this.entries.get(event.sessionId);
    if (!entry) return;
    // Buffered until the pane attaches; `attach` replays the backlog.
    if (!entry.attached) return;
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && candidate.webContents.id === entry.webContentsId,
    );
    if (!win || win.webContents.isDestroyed()) {
      agentDiag(event.sessionId, 'manager:dispatch-no-window', {
        webContentsId: entry.webContentsId,
        eventType: event.type,
      });
      return;
    }
    win.webContents.send('agent:event', event);
  }
}

export const claudeAgentManager = new ClaudeAgentManager();
