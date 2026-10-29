// Types for the Claude Code agent pane — a first-class container type that
// talks to Claude Code through @anthropic-ai/claude-agent-sdk instead of a PTY.
//
// The SDK runs in the main process (it spawns the user's own `claude` binary
// and streams structured messages back). The main process normalizes those
// messages into the small `AgentEvent` union below and forwards them to the
// renderer over IPC; the renderer folds events into a transcript. Nothing here
// depends on the SDK's own types so the renderer never imports it.

/** Permission mode of a live agent session (mirrors the SDK's PermissionMode). */
export type AgentPermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions';

/** What the user chose for a pending tool-approval request. */
export type AgentApprovalDecision = 'allow' | 'allowForSession' | 'deny' | 'cancel';

/** Coarse lifecycle of a pane's session, used to drive the header/composer UI. */
export type AgentSessionStatus = 'starting' | 'idle' | 'running' | 'error' | 'closed';

/** Options for starting (or resuming) a session. All paths are absolute. */
export interface AgentSessionOptions {
  /** Working directory the agent runs in (the workspace root by default). */
  cwd: string;
  /** Claude model id, e.g. 'claude-opus-5'. Undefined = the CLI's default. */
  model?: string;
  /** Starting permission mode. Defaults to 'default' (ask for everything). */
  permissionMode?: AgentPermissionMode;
  /** Claude session id to resume (persisted per pane so a reopen continues). */
  resumeSessionId?: string;
  /**
   * CLAUDE_CONFIG_DIR for this session — lets one pane use a different Claude
   * account/config than another. Empty/undefined = the normal config dir.
   */
  configDir?: string;
}

/** A slash command the running CLI reports as available. */
export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** Account/plan info reported by the CLI at initialization. */
export interface AgentAccountInfo {
  email?: string;
  subscriptionType?: string;
  apiProvider?: string;
}

/** Token/cost totals reported when a turn ends. */
export interface AgentTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/** What the CLI is doing inside a turn; null once it is just thinking. */
export type AgentActivity = 'compacting' | 'requesting' | null;

/** How a turn finished. */
export type AgentTurnStatus = 'completed' | 'interrupted' | 'error';

/** A tool-approval request awaiting the user's decision. */
export interface AgentApprovalRequest {
  requestId: string;
  toolName: string;
  /** Human-readable one-liner ("Bash: npm test", "Edit src/main.ts"). */
  summary: string;
  input: unknown;
  /** True when the SDK offered an "always allow this" style suggestion. */
  canAllowForSession: boolean;
}

/** One option of an AskUserQuestion prompt. */
export interface AgentQuestionOption {
  label: string;
  description?: string;
}

/** A clarifying question the agent asked via the AskUserQuestion tool. */
export interface AgentQuestionRequest {
  requestId: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: AgentQuestionOption[];
}

/**
 * Everything the main process pushes to a pane. Every event carries the pane's
 * `sessionId` so one IPC channel can serve every open agent pane.
 */
export type AgentEvent =
  | {
      type: 'session.init';
      sessionId: string;
      /** Claude's own session id — persist it to resume this thread later. */
      claudeSessionId: string;
      model: string;
      cwd: string;
      permissionMode: AgentPermissionMode;
      slashCommands: AgentSlashCommand[];
      account?: AgentAccountInfo;
    }
  | { type: 'session.status'; sessionId: string; status: AgentSessionStatus }
  /**
   * What the CLI is busy with inside a turn. The terminal shows this as its
   * spinner caption ("Compacting conversation…"); without it a long compaction
   * looks like the pane simply stopped.
   */
  | { type: 'session.activity'; sessionId: string; activity: AgentActivity }
  /** A compaction finished: the conversation was summarised down to fit. */
  | {
      type: 'context.compacted';
      sessionId: string;
      itemId: string;
      trigger: 'manual' | 'auto';
      preTokens: number;
      postTokens?: number;
      durationMs?: number;
    }
  | { type: 'turn.start'; sessionId: string; turnId: string }
  /**
   * Live counters for the turn in flight — what the terminal puts next to its
   * spinner. Each field is a patch: absent means "unchanged", so the renderer
   * merges rather than resets.
   */
  | {
      type: 'turn.progress';
      sessionId: string;
      /** Cumulative output tokens for the assistant message being streamed. */
      outputTokens?: number;
      /** Extended-thinking tokens burned so far. */
      thinkingTokens?: number;
      /** The tool currently running, with how long it has been going. */
      tool?: { name: string; elapsedSeconds: number } | null;
    }
  /**
   * The user's own prompt, echoed by the session. It belongs in the session's
   * history rather than only in the pane, or every prompt would vanish the
   * moment the pane remounts and replays.
   */
  | { type: 'user.message'; sessionId: string; itemId: string; text: string }
  | {
      type: 'text.delta';
      sessionId: string;
      itemId: string;
      kind: 'assistant' | 'thinking';
      text: string;
    }
  | { type: 'text.end'; sessionId: string; itemId: string }
  | {
      type: 'tool.start';
      sessionId: string;
      itemId: string;
      toolUseId: string;
      name: string;
      summary: string;
      input: unknown;
    }
  | {
      type: 'tool.end';
      sessionId: string;
      itemId: string;
      toolUseId: string;
      isError: boolean;
      output: string;
    }
  | { type: 'approval.request'; sessionId: string; request: AgentApprovalRequest }
  | {
      type: 'approval.resolved';
      sessionId: string;
      requestId: string;
      decision: AgentApprovalDecision;
    }
  | { type: 'question.request'; sessionId: string; request: AgentQuestionRequest }
  | { type: 'question.resolved'; sessionId: string; requestId: string }
  | { type: 'plan.proposed'; sessionId: string; itemId: string; plan: string }
  | {
      type: 'turn.end';
      sessionId: string;
      turnId: string;
      status: AgentTurnStatus;
      message?: string;
      usage?: AgentTurnUsage;
    }
  /**
   * Something the PANE says, not the agent: the output of a command the pane
   * handles itself, or why a terminal-only command cannot run here. Routed
   * through the session so it lands in history and replays like everything else.
   */
  | { type: 'pane.note'; sessionId: string; itemId: string; text: string }
  | { type: 'session.error'; sessionId: string; message: string }
  | { type: 'session.closed'; sessionId: string; reason?: string };

/** One past Claude thread for this working directory (the `/resume` list). */
export interface AgentThreadSummary {
  sessionId: string;
  /** Title, auto-summary, or the first prompt — whatever the CLI recorded. */
  summary: string;
  lastModified: number;
}

/** A model the running CLI offers for this session. */
export interface AgentModelOption {
  /** Value to pass to setModel ('default', 'opus[1m]', …). */
  value: string;
  label: string;
  description?: string;
}

/** Result of `agentStartSession` — the handle the renderer keeps. */
export interface AgentSessionHandle {
  sessionId: string;
}

/** One rendered block in a pane's transcript (renderer-side model). */
export type AgentTranscriptItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  | { id: string; kind: 'thinking'; text: string; streaming: boolean }
  | {
      id: string;
      kind: 'tool';
      toolUseId: string;
      name: string;
      summary: string;
      input: unknown;
      output?: string;
      isError?: boolean;
      running: boolean;
    }
  | { id: string; kind: 'plan'; plan: string }
  | { id: string; kind: 'note'; text: string }
  | {
      id: string;
      kind: 'compaction';
      trigger: 'manual' | 'auto';
      preTokens: number;
      postTokens?: number;
      durationMs?: number;
    }
  | {
      id: string;
      kind: 'turn-end';
      status: AgentTurnStatus;
      message?: string;
      usage?: AgentTurnUsage;
    }
  | { id: string; kind: 'error'; message: string };
