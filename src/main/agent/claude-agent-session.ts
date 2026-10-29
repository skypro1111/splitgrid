import { randomUUID } from 'node:crypto';
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentEvent,
  AgentPermissionMode,
  AgentQuestionRequest,
  AgentSessionOptions,
  AgentSlashCommand,
} from '../../shared/agent-types';
import { agentDiag } from './agent-diagnostics';
import { createMapperState, mapSdkMessage, summarizeTool } from './claude-event-mapper';
import { makeClaudeEnv, resolveClaudeExecutable } from './claude-executable';
import { loadSessionTranscript } from './session-transcript';

// One live Claude Code session, driven through @anthropic-ai/claude-agent-sdk.
//
// The SDK's streaming-input mode is what makes a long-lived, interactive pane
// possible: `query()` is handed an async generator of user messages that stays
// open for the whole session, so one `claude` process serves every turn and the
// control channel (interrupt, setPermissionMode, setModel) stays available.
// Turn-by-turn `query()` calls would give up all of that.

// The SDK is ESM-only; the main bundle is CJS, so it is pulled in lazily
// through a dynamic import (Vite bundles it, keeping startup free of it).
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
type SdkQuery = ReturnType<SdkModule['query']>;
type SdkPrompt = Parameters<SdkModule['query']>[0]['prompt'];
type SdkUserMessage = SdkPrompt extends string | AsyncIterable<infer M> ? M : never;
type CanUseTool = NonNullable<Parameters<SdkModule['query']>[0]['options']>['canUseTool'];
type PermissionResult = NonNullable<Awaited<ReturnType<NonNullable<CanUseTool>>>>;
type PermissionUpdate = NonNullable<
  Extract<PermissionResult, { behavior: 'allow' }>['updatedPermissions']
>[number];
let sdkPromise: Promise<SdkModule> | null = null;
function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

/** Settings the user's Claude Code install already owns; we only layer on top. */
const SETTING_SOURCES = ['user', 'project', 'local'] as const;

/**
 * How long teardown waits for a graceful interrupt. SDK control requests have
 * no timeout of their own, and a wedged CLI — exactly the stuck pane `stop`
 * exists for — never answers, so the wait is bounded and the query is then
 * always closed (which kills the subprocess).
 */
const INTERRUPT_GRACE_MS = 2_000;

/** Ask a query to interrupt, then close it no matter what it answered. */
async function shutdownQuery(query: SdkQuery | null): Promise<void> {
  if (!query) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      query.interrupt(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, INTERRUPT_GRACE_MS);
      }),
    ]);
  } catch {
    // Already idle or gone — closing below is what matters.
  } finally {
    if (timer) clearTimeout(timer);
  }
  try {
    query.close();
  } catch {
    // Already closed.
  }
  // Finish the message generator too, without waiting on it: a pump still
  // parked in `for await` must not hold teardown hostage.
  query.return(undefined).catch(() => {});
}

/** Async queue feeding the SDK's streaming input. */
class PromptQueue<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *stream(): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length > 0) {
        yield this.items.shift() as T;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

interface PendingApproval {
  toolName: string;
  suggestions: PermissionUpdate[] | undefined;
  resolve: (decision: AgentApprovalDecision) => void;
}

interface PendingQuestion {
  /** The tool's original `questions` array, echoed back with the answers. */
  questions: unknown;
  resolve: (answers: Record<string, string> | null) => void;
}

export interface ClaudeAgentSessionDeps {
  /** Pushes one event to the renderer that owns this pane. */
  emit: (event: AgentEvent) => void;
  /** Binary path override from app settings (empty = auto-detect). */
  binaryPath?: string;
}

export class ClaudeAgentSession {
  readonly id = randomUUID();

  private query: SdkQuery | null = null;
  /** Commands/account metadata, fetched once the CLI answers `initialize`. */
  private initPromise: Promise<Awaited<ReturnType<SdkQuery['initializationResult']>>> | null = null;
  private queue = new PromptQueue<SdkUserMessage>();
  /** Bumped per `query()`; a pump from an older generation stops reporting. */
  private generation = 0;
  private executable = '';
  /**
   * `bypassPermissions` can only be entered by a session LAUNCHED with
   * `allowDangerouslySkipPermissions` — the CLI rejects it as a live control
   * request. So switching into it relaunches the CLI on the same Claude
   * session instead of failing in the user's face.
   */
  private launchedWithBypass = false;
  private currentModel = '';
  private currentCwd = '';
  /** Set once the pane has been told about this session. */
  private publishedInit = false;
  /**
   * Whether `resume` can be used. The CLI writes a conversation to disk only
   * once a turn completes, so resuming a session that has never answered fails
   * with "No conversation found" — there is simply nothing to resume, and a
   * fresh launch loses nothing.
   */
  private canResume: boolean;
  private readonly mapper = createMapperState();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();
  /**
   * Every event this session has emitted, replayed to a pane that (re)attaches.
   * A pane unmounts on every workspace switch, so the transcript has to live
   * here rather than in the renderer. Capped — an old delta lost off the front
   * only truncates scrollback, it never breaks the live stream.
   */
  private readonly history: AgentEvent[] = [];
  /**
   * Undefined until either the pane picks a mode or the CLI reports its own.
   * Left unset at launch on purpose: the user's `permissions.defaultMode` (it
   * may well be `auto`) should decide, not a hardcoded pane default.
   */
  private permissionMode: AgentPermissionMode | undefined;
  private claudeSessionId = '';
  private stopped = false;
  private turnActive = false;

  constructor(
    private readonly options: AgentSessionOptions,
    private readonly deps: ClaudeAgentSessionDeps,
  ) {
    this.permissionMode = options.permissionMode;
    this.canResume = Boolean(options.resumeSessionId);
  }

  /** Claude's own session id — persist it to resume this thread later. */
  get resumeId(): string {
    return this.claudeSessionId;
  }

  private static readonly MAX_HISTORY = 5000;

  private emit(event: AgentEvent): void {
    if (this.stopped && event.type !== 'session.closed') return;
    // One line per streamed token would flood the log (and the in-memory ring
    // the /agent `diag` command reads) with noise; deltas are not lifecycle.
    if (event.type !== 'text.delta') {
      agentDiag(this.id, `emit:${event.type}`, summarizeEventForDiag(event));
    }
    this.history.push(event);
    if (this.history.length > ClaudeAgentSession.MAX_HISTORY) {
      this.history.splice(0, this.history.length - ClaudeAgentSession.MAX_HISTORY);
    }
    this.deps.emit(event);
  }

  /**
   * Load the resumed thread out of the CLI's own session store into this
   * session's history. Recorded, not dispatched: no pane is attached yet, and
   * the attach replay is what delivers it — the same path a live event takes.
   */
  private async seedHistoryFromStore(): Promise<void> {
    const resumeId = this.options.resumeSessionId;
    if (!resumeId || this.history.length > 0) return;
    const events = await loadSessionTranscript(this.id, resumeId, this.options.configDir);
    agentDiag(this.id, 'history:loaded', { resumeId, events: events.length });
    this.history.push(...events);
  }

  /** Everything emitted so far, for a pane that just (re)attached. */
  replay(): AgentEvent[] {
    return [...this.history];
  }

  /** Live state of this session, for the /agent debug bridge. */
  snapshot(): Record<string, unknown> {
    return {
      sessionId: this.id,
      claudeSessionId: this.claudeSessionId,
      cwd: this.currentCwd || this.options.cwd,
      model: this.currentModel || this.options.model || '',
      permissionMode: this.permissionMode ?? '(user default)',
      launchedWithBypass: this.launchedWithBypass,
      generation: this.generation,
      publishedInit: this.publishedInit,
      canResume: this.canResume,
      turnActive: this.turnActive,
      stopped: this.stopped,
      hasQuery: this.query !== null,
      executable: this.executable,
      historyEvents: this.history.length,
      pendingApprovals: [...this.approvals.keys()],
      pendingQuestions: [...this.questions.keys()],
    };
  }

  async start(): Promise<void> {
    agentDiag(this.id, 'start', {
      cwd: this.options.cwd,
      model: this.options.model ?? '',
      permissionMode: this.permissionMode ?? '(user default)',
      resumeSessionId: this.options.resumeSessionId ?? '',
      configDir: this.options.configDir ?? '',
    });
    const executable = resolveClaudeExecutable({ configured: this.deps.binaryPath });
    agentDiag(this.id, 'resolve-executable', { executable: executable ?? null });
    if (!executable) {
      this.emit({
        type: 'session.error',
        sessionId: this.id,
        message:
          'Claude Code was not found. Install it (https://claude.com/product/claude-code) and run `claude auth login`, or set the binary path in Settings.',
      });
      this.emit({ type: 'session.status', sessionId: this.id, status: 'error' });
      return;
    }

    this.executable = executable;
    // A resumed thread must open with its conversation, not blank: `resume`
    // continues a thread on the CLI side but never replays it.
    await this.seedHistoryFromStore();
    await this.openQuery();
  }

  /**
   * Launch (or relaunch) the CLI for this session. A relaunch resumes the same
   * Claude session, so the thread — and everything the pane already shows —
   * carries over; only the process-level options change.
   */
  private async openQuery(): Promise<void> {
    agentDiag(this.id, 'load-sdk:begin');
    const { query } = await loadSdk();
    agentDiag(this.id, 'load-sdk:done');
    const env = makeClaudeEnv(this.options.configDir);
    const generation = ++this.generation;
    this.launchedWithBypass = this.permissionMode === 'bypassPermissions';
    // Resume the live thread when relaunching; otherwise the pane's saved cursor.
    const resume = this.canResume
      ? this.claudeSessionId || this.options.resumeSessionId
      : undefined;

    this.query = query({
      prompt: this.queue.stream(),
      options: {
        cwd: this.options.cwd,
        // Keep Claude Code's own persona, CLAUDE.md, skills and MCP servers —
        // this pane is the user's Claude Code, not a bespoke agent.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: [...SETTING_SOURCES],
        includePartialMessages: true,
        ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
        ...(this.launchedWithBypass ? { allowDangerouslySkipPermissions: true } : {}),
        ...(this.currentModel || this.options.model
          ? { model: this.currentModel || this.options.model }
          : {}),
        ...(resume ? { resume } : {}),
        additionalDirectories: [this.options.cwd],
        env,
        pathToClaudeCodeExecutable: this.executable,
        canUseTool: (toolName, toolInput, callbackOptions) =>
          this.handleCanUseTool(toolName, toolInput as Record<string, unknown>, callbackOptions),
      },
    });

    agentDiag(this.id, 'query-created', {
      generation,
      resume: resume ?? '',
      launchedWithBypass: this.launchedWithBypass,
      pathEntries: (env.PATH ?? '').split(':').length,
    });

    // Two independent readiness signals, and the pane must not wait on both:
    // the `initialize` control response carries commands/account, the CLI's
    // `system`/`init` message carries the session id and effective model. Each
    // publishes what it knows, so the composer unlocks on whichever lands first.
    this.initPromise = this.query.initializationResult();
    agentDiag(this.id, 'initialize:requested', { generation });
    this.initPromise.then(
      () => {
        agentDiag(this.id, 'initialize:resolved', {
          generation,
          stale: generation !== this.generation,
        });
        if (generation === this.generation) void this.publishInit({});
      },
      (error: unknown) => {
        agentDiag(this.id, 'initialize:failed', { generation, error: describeError(error) });
        if (generation !== this.generation) return;
        // A saved cursor can point at a conversation the user has since
        // deleted. Drop the cursor and launch clean rather than dead-ending
        // the pane on someone else's housekeeping.
        if (resume && isMissingConversation(error)) {
          this.canResume = false;
          this.claudeSessionId = '';
          void this.relaunch();
          return;
        }
        this.emit({
          type: 'session.error',
          sessionId: this.id,
          message: `Failed to initialize Claude Code: ${describeError(error)}`,
        });
        this.emit({ type: 'session.status', sessionId: this.id, status: 'error' });
      },
    );
    void this.pump(generation);
  }

  /**
   * Announce the session to the pane, merging whatever each readiness signal
   * knows. This matters more than it looks: the CLI only emits `system`/`init`
   * once a turn starts, so a pane that waited for it would sit disabled forever
   * with no way to send the first prompt. The `initialize` control response
   * arrives immediately and carries commands, account, the permission mode and
   * the model catalog — enough to open the pane for business.
   */
  private async publishInit(systemInit: {
    session_id?: string;
    model?: string;
    cwd?: string;
    permissionMode?: string;
  }): Promise<void> {
    if (typeof systemInit.session_id === 'string' && systemInit.session_id.length > 0) {
      this.claudeSessionId = systemInit.session_id;
    }
    if (systemInit.model) this.currentModel = systemInit.model;
    if (systemInit.cwd) this.currentCwd = systemInit.cwd;
    if (systemInit.permissionMode) {
      this.permissionMode = systemInit.permissionMode as AgentPermissionMode;
    }
    const init = (await this.initPromise?.catch(() => null)) as
      | (Awaited<ReturnType<SdkQuery['initializationResult']>> & {
          current_permission_mode?: string;
          models?: { value?: string; resolvedModel?: string }[];
        })
      | null
      | undefined;
    const account = init?.account;

    // `system`/`init` is authoritative about the model, but it comes late; until
    // then resolve what the catalog says this session will actually run.
    if (!this.currentModel && init?.models?.length) {
      const wanted = this.options.model;
      const entry = wanted
        ? init.models.find((m) => m.value === wanted || m.resolvedModel === wanted)
        : (init.models.find((m) => m.value === 'default') ?? init.models[0]);
      this.currentModel = entry?.resolvedModel ?? entry?.value ?? '';
    }
    if (!systemInit.permissionMode && init?.current_permission_mode) {
      this.permissionMode = init.current_permission_mode as AgentPermissionMode;
    }
    this.publishedInit = true;
    const commands: AgentSlashCommand[] = Array.isArray(init?.commands)
      ? init.commands.map((command) => ({
          name: String((command as { name?: unknown }).name ?? ''),
          description: String((command as { description?: unknown }).description ?? ''),
          ...((command as { argumentHint?: string }).argumentHint
            ? { argumentHint: (command as { argumentHint?: string }).argumentHint }
            : {}),
        }))
      : [];

    this.emit({
      type: 'session.init',
      sessionId: this.id,
      claudeSessionId: this.claudeSessionId,
      model: this.currentModel || this.options.model || '',
      cwd: this.currentCwd || this.options.cwd,
      permissionMode: this.permissionMode ?? 'default',
      slashCommands: commands.filter((command) => command.name.length > 0),
      ...(account
        ? {
            account: {
              ...(account.email ? { email: account.email } : {}),
              ...(account.subscriptionType ? { subscriptionType: account.subscriptionType } : {}),
              ...(account.apiProvider ? { apiProvider: account.apiProvider } : {}),
            },
          }
        : {}),
    });
    this.emit({ type: 'session.status', sessionId: this.id, status: 'idle' });
  }

  /** Drain the SDK message stream for the life of one launched CLI. */
  private async pump(generation: number): Promise<void> {
    const query = this.query;
    if (!query) return;
    try {
      for await (const message of query) {
        if (this.stopped || generation !== this.generation) break;
        const framed = message as {
          type?: string;
          subtype?: string;
          session_id?: string;
          model?: string;
          cwd?: string;
          permissionMode?: string;
        };
        if (typeof framed.session_id === 'string' && framed.session_id.length > 0) {
          const isNew = framed.session_id !== this.claudeSessionId;
          this.claudeSessionId = framed.session_id;
          // The pane persists its resume cursor off session.init, and the id can
          // land after the first publish — refresh so a pane that never runs a
          // turn still remembers this thread.
          if (isNew && this.publishedInit) void this.publishInit({});
        }
        // stream_event is one partial-message chunk per token — skip it.
        if (framed.type !== 'stream_event') {
          agentDiag(this.id, 'sdk-message', {
            type: framed.type ?? '?',
            ...(framed.subtype ? { subtype: framed.subtype } : {}),
          });
        }
        if (framed.type === 'system' && framed.subtype === 'init') {
          void this.publishInit(framed);
          continue;
        }
        for (const event of mapSdkMessage(this.id, message, this.mapper)) {
          if (event.type === 'turn.end') {
            // Resuming a session makes the CLI replay a handshake (system/init
            // plus a zero-turn result). That result is not our turn: reporting
            // it would stamp a phantom turn footer on every reopened pane.
            if (!this.turnActive) continue;
            this.turnActive = false;
            // The CLI has now persisted this conversation, so it can be resumed.
            this.canResume = true;
            this.emit(event);
            this.emit({ type: 'session.status', sessionId: this.id, status: 'idle' });
            continue;
          }
          this.emit(event);
        }
      }
      // A superseded generation is a relaunch, not an exit — stay quiet.
      if (!this.stopped && generation === this.generation) {
        this.emit({ type: 'session.closed', sessionId: this.id, reason: 'Claude Code exited.' });
      }
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.emit({ type: 'session.error', sessionId: this.id, message: describeError(error) });
      this.emit({ type: 'session.status', sessionId: this.id, status: 'error' });
    } finally {
      if (generation === this.generation) this.rejectPending();
    }
  }

  /**
   * Relaunch the CLI on the same Claude session — the only way to change an
   * option the CLI fixes at launch (notably entering bypassPermissions).
   */
  private async relaunch(): Promise<void> {
    agentDiag(this.id, 'relaunch', { permissionMode: this.permissionMode ?? '' });
    // Invalidate the running pump FIRST: it notices the stream ending before
    // openQuery bumps the generation, and would report the relaunch as an exit.
    this.generation += 1;
    const old = this.query;
    this.query = null;
    this.rejectPending();
    this.emit({ type: 'session.status', sessionId: this.id, status: 'starting' });
    this.queue.close();
    this.queue = new PromptQueue<SdkUserMessage>();
    this.turnActive = false;
    // The old CLI's half-streamed blocks must not suppress the new one's.
    this.mapper.blocks.clear();
    this.mapper.streamingMessageId = '';
    this.mapper.startedTools.clear();
    this.publishedInit = false;
    // Bounded, and always ends the old CLI — a relaunch must never hang here.
    await shutdownQuery(old);
    await this.openQuery();
  }

  /** Queue a user prompt. Starts a turn; the pane shows it immediately. */
  send(text: string): void {
    if (this.stopped || !this.query) return;
    const turnId = randomUUID();
    this.mapper.turnId = turnId;
    this.turnActive = true;
    this.emit({ type: 'turn.start', sessionId: this.id, turnId });
    this.emit({ type: 'user.message', sessionId: this.id, itemId: `user:${turnId}`, text });
    this.emit({ type: 'session.status', sessionId: this.id, status: 'running' });
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.claudeSessionId,
    } as SdkUserMessage);
  }

  async interrupt(): Promise<void> {
    if (!this.query || !this.turnActive) return;
    try {
      await this.query.interrupt();
    } catch (error) {
      this.emit({ type: 'session.error', sessionId: this.id, message: describeError(error) });
    }
  }

  async setPermissionMode(mode: AgentPermissionMode): Promise<void> {
    if (mode === this.permissionMode) return;
    this.permissionMode = mode;
    if (!this.query) return;

    // Entering bypass needs the launch flag, so go straight to a relaunch
    // rather than letting the CLI reject the control request.
    if (mode === 'bypassPermissions' && !this.launchedWithBypass) {
      await this.relaunch();
      return;
    }
    try {
      await this.query.setPermissionMode(mode);
    } catch {
      // Any other launch-gated mode lands here; relaunching is the fallback
      // that keeps the switch working instead of surfacing a CLI error.
      await this.relaunch();
    }
  }

  /** Publish a pane-authored line into this session's transcript. */
  note(text: string): void {
    this.emit({
      type: 'pane.note',
      sessionId: this.id,
      itemId: `note:${randomUUID()}`,
      text,
    });
  }

  /** Context-window breakdown, for the pane's /status. Null when unavailable. */
  async contextUsage(): Promise<Record<string, unknown> | null> {
    if (!this.query) return null;
    try {
      return (await this.query.getContextUsage()) as unknown as Record<string, unknown>;
    } catch (error) {
      agentDiag(this.id, 'context-usage:failed', { error: describeError(error) });
      return null;
    }
  }

  /** Models this CLI offers, for the pane's picker. Empty when unavailable. */
  async supportedModels(): Promise<{ value: string; label: string; description?: string }[]> {
    if (!this.query) {
      agentDiag(this.id, 'models:no-query');
      return [];
    }
    try {
      const models = (await this.query.supportedModels()) as {
        value?: string;
        displayName?: string;
        description?: string;
      }[];
      return models
        .filter((model) => typeof model.value === 'string' && model.value.length > 0)
        .map((model) => ({
          value: model.value as string,
          label: model.displayName ?? (model.value as string),
          ...(model.description ? { description: model.description } : {}),
        }));
    } catch (error) {
      agentDiag(this.id, 'models:failed', { error: describeError(error) });
      return [];
    }
  }

  async setModel(model: string | undefined): Promise<void> {
    this.currentModel = model ?? '';
    if (!this.query) return;
    try {
      await this.query.setModel(model);
    } catch (error) {
      this.emit({ type: 'session.error', sessionId: this.id, message: describeError(error) });
    }
  }

  /** Resolve a pending tool approval with the user's choice. */
  respondToApproval(requestId: string, decision: AgentApprovalDecision): void {
    const pending = this.approvals.get(requestId);
    if (!pending) return;
    this.approvals.delete(requestId);
    pending.resolve(decision);
    this.emit({ type: 'approval.resolved', sessionId: this.id, requestId, decision });
  }

  /** Resolve a pending AskUserQuestion. `null` cancels the tool call. */
  respondToQuestion(requestId: string, answers: Record<string, string> | null): void {
    const pending = this.questions.get(requestId);
    if (!pending) return;
    this.questions.delete(requestId);
    pending.resolve(answers);
    this.emit({ type: 'question.resolved', sessionId: this.id, requestId });
  }

  async stop(reason?: string): Promise<void> {
    agentDiag(this.id, 'stop', { reason: reason ?? '', already: this.stopped });
    if (this.stopped) return;
    this.stopped = true;
    this.rejectPending();
    this.queue.close();
    const query = this.query;
    this.query = null;
    await shutdownQuery(query);
    this.deps.emit({ type: 'session.closed', sessionId: this.id, ...(reason ? { reason } : {}) });
  }

  /** Unpark everything waiting on the user so no SDK callback hangs forever. */
  private rejectPending(): void {
    for (const [requestId, pending] of this.approvals) {
      this.approvals.delete(requestId);
      pending.resolve('cancel');
    }
    for (const [requestId, pending] of this.questions) {
      this.questions.delete(requestId);
      pending.resolve(null);
    }
  }

  // ─── Permission surface ────────────────────────────────────────────────────

  private async handleCanUseTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    callbackOptions: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID?: string },
  ): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') {
      return this.handleAskUserQuestion(toolInput, callbackOptions.signal);
    }

    if (toolName === 'ExitPlanMode') {
      const plan = typeof toolInput.plan === 'string' ? toolInput.plan : '';
      if (plan) {
        this.emit({
          type: 'plan.proposed',
          sessionId: this.id,
          itemId: `plan:${callbackOptions.toolUseID ?? randomUUID()}`,
          plan,
        });
      }
      // The pane owns the plan: show it and let the user decide in a new turn.
      return {
        behavior: 'deny',
        message:
          'The client captured your proposed plan. Stop here and wait for the user to approve it or ask for changes in a later turn.',
      };
    }

    // bypassPermissions never prompts; the CLI already skips its own prompts.
    if (this.permissionMode === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: toolInput };
    }

    const requestId = randomUUID();
    const request: AgentApprovalRequest = {
      requestId,
      toolName,
      summary: summarizeTool(toolName, toolInput),
      input: toolInput,
      canAllowForSession: true,
    };

    const decision = await new Promise<AgentApprovalDecision>((resolve) => {
      this.approvals.set(requestId, {
        toolName,
        suggestions: callbackOptions.suggestions,
        resolve,
      });
      callbackOptions.signal.addEventListener(
        'abort',
        () => {
          if (!this.approvals.delete(requestId)) return;
          resolve('cancel');
        },
        { once: true },
      );
      this.emit({ type: 'approval.request', sessionId: this.id, request });
    });

    if (decision === 'allow' || decision === 'allowForSession') {
      const suggestions = callbackOptions.suggestions;
      return {
        behavior: 'allow',
        updatedInput: toolInput,
        ...(decision === 'allowForSession'
          ? { updatedPermissions: sessionPermissionUpdates(toolName, suggestions) }
          : {}),
      };
    }

    return {
      behavior: 'deny',
      message: decision === 'cancel' ? 'User cancelled tool execution.' : 'User declined tool execution.',
    };
  }

  private async handleAskUserQuestion(
    toolInput: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
    const first = (rawQuestions[0] ?? {}) as Record<string, unknown>;
    const requestId = randomUUID();
    const request: AgentQuestionRequest = {
      requestId,
      header: typeof first.header === 'string' ? first.header : 'Question',
      question: typeof first.question === 'string' ? first.question : '',
      multiSelect: first.multiSelect === true,
      options: Array.isArray(first.options)
        ? (first.options as Record<string, unknown>[]).map((option) => ({
            label: typeof option.label === 'string' ? option.label : '',
            description: typeof option.description === 'string' ? option.description : undefined,
          }))
        : [],
    };

    const answers = await new Promise<Record<string, string> | null>((resolve) => {
      this.questions.set(requestId, { questions: toolInput.questions, resolve });
      signal.addEventListener(
        'abort',
        () => {
          if (!this.questions.delete(requestId)) return;
          resolve(null);
        },
        { once: true },
      );
      this.emit({ type: 'question.request', sessionId: this.id, request });
    });

    if (!answers) return { behavior: 'deny', message: 'User cancelled tool execution.' };
    // The SDK looks answers up by the question's full text, so the keys the UI
    // sends back must be the question strings themselves.
    return {
      behavior: 'allow',
      updatedInput: { questions: toolInput.questions, answers } as Record<string, unknown>,
    };
  }
}

/**
 * "Allow for the rest of this session": prefer the SDK's own suggestions
 * (narrow, e.g. this exact command prefix) and fall back to allowing the tool.
 */
function sessionPermissionUpdates(
  toolName: string,
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  const scoped = (suggestions ?? []).map(
    (suggestion) => ({ ...suggestion, destination: 'session' }) as PermissionUpdate,
  );
  if (scoped.length > 0) return scoped;
  return [
    {
      type: 'addRules',
      rules: [{ toolName }],
      behavior: 'allow',
      destination: 'session',
    } as PermissionUpdate,
  ];
}

/** The CLI's way of saying the conversation being resumed no longer exists. */
function isMissingConversation(error: unknown): boolean {
  return /no conversation found/i.test(describeError(error));
}

/** Small, log-safe shape of an event — never the full tool output. */
function summarizeEventForDiag(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case 'session.init':
      return { model: event.model, claudeSessionId: event.claudeSessionId, mode: event.permissionMode };
    case 'session.status':
      return { status: event.status };
    case 'session.error':
      return { message: event.message.slice(0, 300) };
    case 'session.closed':
      return { reason: event.reason ?? '' };
    case 'tool.start':
      return { tool: event.name };
    case 'tool.end':
      return { isError: event.isError, bytes: event.output.length };
    case 'turn.end':
      return { status: event.status, ...(event.message ? { message: event.message.slice(0, 300) } : {}) };
    case 'approval.request':
      return { tool: event.request.toolName, requestId: event.request.requestId };
    default:
      return {};
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
