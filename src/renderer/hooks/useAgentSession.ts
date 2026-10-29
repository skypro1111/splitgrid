import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentApprovalDecision,
  AgentActivity,
  AgentApprovalRequest,
  AgentEvent,
  AgentPermissionMode,
  AgentQuestionRequest,
  AgentSessionOptions,
  AgentSessionStatus,
  AgentSlashCommand,
  AgentTranscriptItem,
} from '../../shared/agent-types';

// Renderer-side state of one Claude Code pane: it starts a session in the main
// process, folds the event stream into a transcript, and exposes the actions
// the pane's UI needs. Everything the agent does arrives as events — the hook
// never talks to the SDK itself.
//
// Delivery is deliberately gated on `attach`: the session emits from the moment
// it starts, before this hook even knows its id, so the main process holds the
// stream until the pane attaches and then replays it. Events that arrive while
// the replay is still in flight are buffered here and applied after it, so the
// transcript is built exactly once, in order.

/** Live counters for the turn in flight, for the pane's activity line. */
export interface AgentTurnProgress {
  /** When the current turn started, for the elapsed clock. */
  startedAt: number;
  outputTokens: number;
  thinkingTokens: number;
  tool: { name: string; elapsedSeconds: number } | null;
  /** Which kind of content is streaming right now. */
  phase: 'thinking' | 'responding' | null;
}

export interface AgentSessionInfo {
  claudeSessionId: string;
  model: string;
  cwd: string;
  account?: { email?: string; subscriptionType?: string; apiProvider?: string };
  slashCommands: AgentSlashCommand[];
}

export interface UseAgentSession {
  sessionId: string | null;
  status: AgentSessionStatus;
  /** What the CLI is busy with inside the turn (compacting, requesting). */
  activity: AgentActivity;
  /** Live counters while a turn runs; null between turns. */
  progress: AgentTurnProgress | null;
  info: AgentSessionInfo | null;
  permissionMode: AgentPermissionMode;
  transcript: AgentTranscriptItem[];
  approval: AgentApprovalRequest | null;
  question: AgentQuestionRequest | null;
  send: (text: string) => void;
  interrupt: () => void;
  respondApproval: (decision: AgentApprovalDecision) => void;
  respondQuestion: (answers: Record<string, string> | null) => void;
  setPermissionMode: (mode: AgentPermissionMode) => void;
  /** Switch the model for the rest of the session ('' / undefined = default). */
  setModel: (model: string | undefined) => void;
  /** End the session for good (the pane is closing, not just unmounting). */
  stop: () => void;
}

/** Append or update the transcript item an event belongs to. */
function reduce(items: AgentTranscriptItem[], event: AgentEvent): AgentTranscriptItem[] {
  switch (event.type) {
    case 'user.message':
      return [...items, { id: event.itemId, kind: 'user', text: event.text }];
    case 'text.delta': {
      const index = items.findIndex((item) => item.id === event.itemId);
      if (index === -1) {
        return [
          ...items,
          { id: event.itemId, kind: event.kind, text: event.text, streaming: true },
        ];
      }
      const existing = items[index];
      if (existing.kind !== 'assistant' && existing.kind !== 'thinking') return items;
      const next = items.slice();
      next[index] = { ...existing, text: existing.text + event.text };
      return next;
    }
    case 'text.end': {
      const index = items.findIndex((item) => item.id === event.itemId);
      if (index === -1) return items;
      const existing = items[index];
      if (existing.kind !== 'assistant' && existing.kind !== 'thinking') return items;
      const next = items.slice();
      next[index] = { ...existing, streaming: false };
      return next;
    }
    case 'tool.start':
      return [
        ...items,
        {
          id: event.itemId,
          kind: 'tool',
          toolUseId: event.toolUseId,
          name: event.name,
          summary: event.summary,
          input: event.input,
          running: true,
        },
      ];
    case 'tool.end': {
      const index = items.findIndex((item) => item.id === event.itemId);
      if (index === -1) return items;
      const existing = items[index];
      if (existing.kind !== 'tool') return items;
      const next = items.slice();
      next[index] = { ...existing, running: false, output: event.output, isError: event.isError };
      return next;
    }
    case 'plan.proposed':
      return [...items, { id: event.itemId, kind: 'plan', plan: event.plan }];
    case 'pane.note':
      return [...items, { id: event.itemId, kind: 'note', text: event.text }];
    case 'context.compacted':
      return [
        ...items,
        {
          id: event.itemId,
          kind: 'compaction',
          trigger: event.trigger,
          preTokens: event.preTokens,
          ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        },
      ];
    case 'turn.end':
      return [
        ...items,
        {
          id: `${event.turnId}:end`,
          kind: 'turn-end',
          status: event.status,
          ...(event.message ? { message: event.message } : {}),
          ...(event.usage ? { usage: event.usage } : {}),
        },
      ];
    case 'session.error':
      return [...items, { id: `error:${items.length}`, kind: 'error', message: event.message }];
    default:
      return items;
  }
}

export interface UseAgentSessionInput {
  /** Options for a brand-new session. Null while the pane can't start one. */
  options: AgentSessionOptions | null;
  /** A session this pane was bound to before it unmounted (workspace switch). */
  existingSessionId?: string;
  /** Called once the pane owns a session id, so the container can persist it. */
  onSessionId?: (sessionId: string) => void;
}

export function useAgentSession(input: UseAgentSessionInput): UseAgentSession {
  const { options, existingSessionId } = input;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<AgentSessionStatus>('starting');
  const [activity, setActivity] = useState<AgentActivity>(null);
  const [progress, setProgress] = useState<AgentTurnProgress | null>(null);
  const [info, setInfo] = useState<AgentSessionInfo | null>(null);
  const [permissionMode, setPermissionModeState] = useState<AgentPermissionMode>(
    options?.permissionMode ?? 'default',
  );
  const [transcript, setTranscript] = useState<AgentTranscriptItem[]>([]);
  const [approval, setApproval] = useState<AgentApprovalRequest | null>(null);
  const [question, setQuestion] = useState<AgentQuestionRequest | null>(null);

  // The live session id, readable from the event handler without re-subscribing.
  const sessionIdRef = useRef<string | null>(null);
  // Non-null while the replay is in flight: live events queue here instead of
  // being applied out of order.
  const bootBuffer = useRef<AgentEvent[] | null>([]);

  const started = useRef(false);
  const onSessionIdRef = useRef(input.onSessionId);
  onSessionIdRef.current = input.onSessionId;

  /** Fold one event into every piece of pane state it touches. */
  const applyEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'session.init':
        setInfo({
          claudeSessionId: event.claudeSessionId,
          model: event.model,
          cwd: event.cwd,
          slashCommands: event.slashCommands,
          ...(event.account ? { account: event.account } : {}),
        });
        setPermissionModeState(event.permissionMode);
        break;
      case 'session.status':
        setStatus(event.status);
        // Leaving a turn ends whatever it was busy with.
        if (event.status !== 'running') setActivity(null);
        break;
      case 'session.activity':
        setActivity(event.activity);
        break;
      case 'turn.start':
        setProgress({
          startedAt: Date.now(),
          outputTokens: 0,
          thinkingTokens: 0,
          tool: null,
          phase: null,
        });
        break;
      case 'turn.progress':
        setProgress((current) => {
          // A patch outside a turn (a replayed one, say) has nothing to update.
          if (!current) return current;
          return {
            ...current,
            ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
            ...(event.thinkingTokens !== undefined
              ? { thinkingTokens: event.thinkingTokens }
              : {}),
            ...(event.tool !== undefined ? { tool: event.tool } : {}),
          };
        });
        break;
      case 'text.delta':
        // Which kind of content is streaming is the difference between
        // "Thinking…" and a reply appearing.
        setProgress((current) =>
          current && current.phase !== (event.kind === 'thinking' ? 'thinking' : 'responding')
            ? { ...current, phase: event.kind === 'thinking' ? 'thinking' : 'responding' }
            : current,
        );
        break;
      case 'tool.end':
        setProgress((current) => (current?.tool ? { ...current, tool: null } : current));
        break;
      case 'turn.end':
        setProgress(null);
        break;
      case 'approval.request':
        setApproval(event.request);
        break;
      case 'approval.resolved':
        setApproval((current) => (current?.requestId === event.requestId ? null : current));
        break;
      case 'question.request':
        setQuestion(event.request);
        break;
      case 'question.resolved':
        setQuestion((current) => (current?.requestId === event.requestId ? null : current));
        break;
      case 'session.closed':
        setStatus('closed');
        setApproval(null);
        setQuestion(null);
        break;
      default:
        break;
    }
    setTranscript((items) => reduce(items, event));
  }, []);

  useEffect(() => {
    if (!options || started.current) return;
    started.current = true;
    let disposed = false;

    const fail = (error: unknown) => {
      if (disposed) return;
      setStatus('error');
      setTranscript((items) => [
        ...items,
        {
          id: `error:${items.length}`,
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
    };

    /** Bind to `id` and rebuild state from the session's own history. */
    const adopt = (id: string, history: AgentEvent[]) => {
      if (disposed) {
        void window.electronAPI.agentDetachSession(id);
        return;
      }
      sessionIdRef.current = id;
      setSessionId(id);
      onSessionIdRef.current?.(id);

      // Queued events can predate the id being known, so filter them here.
      const queued = (bootBuffer.current ?? []).filter((event) => event.sessionId === id);
      bootBuffer.current = null;
      for (const event of [...history, ...queued]) applyEvent(event);
    };

    // Attaching is what opens the stream, for a fresh session as much as for a
    // reattach — the main process holds every event until a pane is listening.
    const attach = (id: string) =>
      window.electronAPI.agentAttachSession(id).then((result) => {
        if (!result.ok) return false;
        adopt(id, result.events);
        return true;
      });

    const startFresh = () =>
      window.electronAPI
        .agentStartSession(options)
        .then((created) => attach(created.sessionId))
        .then((ok) => {
          if (!ok && !disposed) fail(new Error('Claude Code session vanished while starting.'));
        })
        .catch(fail);

    if (existingSessionId) {
      // A workspace switch left a live session behind; prefer it.
      attach(existingSessionId)
        .then((ok) => (ok ? undefined : startFresh()))
        .catch(() => startFresh());
    } else {
      void startFresh();
    }

    return () => {
      disposed = true;
      const id = sessionIdRef.current;
      if (id) void window.electronAPI.agentDetachSession(id);
    };
    // Intentionally starts once per pane — a pane's session is pinned to the
    // options it opened with.
  }, []);

  useEffect(() => {
    return window.electronAPI.onAgentEvent((event) => {
      // Still booting: queue everything, including events that arrive before
      // this pane even learns its session id (the attach reply is one IPC hop
      // behind the events it unblocks). `adopt` filters and orders them.
      if (bootBuffer.current) {
        bootBuffer.current.push(event);
        return;
      }
      // One channel serves every pane, so ignore other panes' events.
      if (!sessionIdRef.current || event.sessionId !== sessionIdRef.current) return;
      applyEvent(event);
    });
  }, [applyEvent]);

  const send = useCallback((text: string) => {
    const id = sessionIdRef.current;
    if (!id || !text.trim()) return;
    // The bubble comes back as a `user.message` event, so it is recorded in the
    // session's history and survives a remount. Only the status is optimistic.
    setStatus('running');
    void window.electronAPI.agentSend(id, text);
  }, []);

  const interrupt = useCallback(() => {
    const id = sessionIdRef.current;
    if (id) void window.electronAPI.agentInterrupt(id);
  }, []);

  const respondApproval = useCallback(
    (decision: AgentApprovalDecision) => {
      const id = sessionIdRef.current;
      if (!id || !approval) return;
      setApproval(null);
      void window.electronAPI.agentRespondApproval(id, approval.requestId, decision);
    },
    [approval],
  );

  const respondQuestion = useCallback(
    (answers: Record<string, string> | null) => {
      const id = sessionIdRef.current;
      if (!id || !question) return;
      setQuestion(null);
      void window.electronAPI.agentRespondQuestion(id, question.requestId, answers);
    },
    [question],
  );

  /** Explicitly end the session — the pane is being closed, not just hidden. */
  const stop = useCallback(() => {
    const id = sessionIdRef.current;
    if (id) void window.electronAPI.agentStopSession(id);
  }, []);

  const setModel = useCallback((model: string | undefined) => {
    const id = sessionIdRef.current;
    if (id) void window.electronAPI.agentSetModel(id, model);
  }, []);

  const setPermissionMode = useCallback((mode: AgentPermissionMode) => {
    const id = sessionIdRef.current;
    setPermissionModeState(mode);
    if (id) void window.electronAPI.agentSetPermissionMode(id, mode);
  }, []);

  return {
    sessionId,
    status,
    activity,
    progress,
    info,
    permissionMode,
    transcript,
    approval,
    question,
    send,
    interrupt,
    respondApproval,
    respondQuestion,
    setPermissionMode,
    setModel,
    stop,
  };
}
