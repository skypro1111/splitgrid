import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HistoryIcon, SplitHorizontalIcon, SplitVerticalIcon } from '../Icons';
import { Select } from '../Select';
import { AgentTranscriptView } from './AgentTranscriptView';
import { AgentPendingAction } from './AgentPendingAction';
import { AgentActivityLine } from './AgentActivityLine';
import { AgentCompleteMenu } from './AgentCompleteMenu';
import { AgentThreadPicker } from './AgentThreadPicker';
import { PaneFocusButton } from '../focusMode';
import {
  lastAssistantText,
  paneSlashCommands,
  resolvePaneCommand,
  terminalOnlyNote,
  transcriptToMarkdown,
  usageTotals,
} from './paneCommands';
import { useComposerComplete } from './useComposerComplete';
import { useAgentSession } from '../../hooks/useAgentSession';
import type {
  AgentModelOption,
  AgentPermissionMode,
  AgentSessionOptions,
} from '../../../shared/agent-types';
import type { ContainerContent } from '../../../shared/types';

// A Claude Code pane: the same agent the terminal runs, driven through the
// Agent SDK instead of a PTY, so tool calls, approvals and plans are real UI
// instead of ANSI. One pane owns one session for its lifetime.

// Mirrors the CLI's own modes, including `auto` — a user whose
// permissions.defaultMode is `auto` must see that, not a mode we invented.
const PERMISSION_OPTIONS: { value: AgentPermissionMode; label: string; meta?: string }[] = [
  { value: 'default', label: 'Ask', meta: 'every tool' },
  { value: 'auto', label: 'Auto', meta: 'classifier' },
  { value: 'acceptEdits', label: 'Auto-edit', meta: 'edits only' },
  { value: 'plan', label: 'Plan', meta: 'read-only' },
  { value: 'bypassPermissions', label: 'Full access', meta: 'no prompts' },
];

/** Composer height bounds — grows with the draft, never eats the transcript. */
const COMPOSER_MIN_HEIGHT = 38;
const COMPOSER_MAX_HEIGHT = 180;

interface AgentPanelProps {
  containerId: string;
  content: ContainerContent;
  /** Workspace root — the default cwd when the pane doesn't carry one. */
  workspaceRootPath?: string | null;
  onContentChange: (content: ContainerContent) => void;
  onClose: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
}

const iconBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  borderRadius: 4,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  flexShrink: 0,
  color: 'var(--text-muted)',
};

/** Trailing path segment — the full cwd is too long for a pane header. */
function shortenPath(input: string): string {
  const parts = input.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return input;
  return `…/${parts.slice(-2).join('/')}`;
}

/** Model ids are long and dated; the family name is what identifies it. */
function shortenModel(model: string): string {
  const match = /(opus|sonnet|haiku|fable)[-.]?([\d.]+)?/i.exec(model);
  if (!match) return model;
  const family = match[1].toLowerCase();
  return match[2] ? `${family} ${match[2]}` : family;
}

const STARTER_PROMPTS = [
  'What does this project do?',
  'Review my uncommitted changes',
  'Find and fix the failing test',
];

/**
 * Thin wrapper owning what must survive a session swap: which thread the pane
 * is on, and the thread picker. Resuming a different thread relaunches the
 * session, so the body is keyed and simply remounts — no restart plumbing
 * threaded through the session hook.
 */
export const AgentPanel: React.FC<AgentPanelProps> = (props) => {
  const [historyOpen, setHistoryOpen] = useState(false);
  // Bumped to force a clean remount when the user picks another thread.
  const [threadNonce, setThreadNonce] = useState(0);
  const [resumeOverride, setResumeOverride] = useState<string | null>(null);

  const cwd = props.content.agentCwd ?? props.workspaceRootPath ?? '';

  const startNewThread = () => {
    setResumeOverride('');
    setThreadNonce((nonce) => nonce + 1);
    setHistoryOpen(false);
    props.onContentChange({
      ...props.content,
      type: 'agent',
      agentResumeId: undefined,
      agentSessionId: undefined,
    });
  };

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', minWidth: 0 }}>
      <AgentPaneBody
        {...props}
        key={threadNonce}
        resumeOverride={resumeOverride}
        onOpenHistory={() => setHistoryOpen(true)}
        onNewThread={startNewThread}
      />
      {historyOpen && (
        <AgentThreadPicker
          cwd={cwd}
          currentThreadId={resumeOverride ?? props.content.agentResumeId ?? ''}
          onResume={(sessionId) => {
            setResumeOverride(sessionId);
            setThreadNonce((nonce) => nonce + 1);
            setHistoryOpen(false);
            props.onContentChange({
              ...props.content,
              type: 'agent',
              agentResumeId: sessionId,
              agentSessionId: undefined,
            });
          }}
          onNewThread={startNewThread}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
};

const AgentPaneBody: React.FC<
  AgentPanelProps & {
    resumeOverride: string | null;
    onOpenHistory: () => void;
    onNewThread: () => void;
  }
> = ({
  containerId,
  content,
  workspaceRootPath,
  resumeOverride,
  onOpenHistory,
  onNewThread,
  onContentChange,
  onClose,
  onSplitRight,
  onSplitDown,
}) => {
  // Captured once: the pane's session is pinned to the cwd it started in.
  const [options] = useState<AgentSessionOptions | null>(() => {
    const cwd = content.agentCwd ?? workspaceRootPath ?? '';
    if (!cwd) return null;
    return {
      cwd,
      ...(content.agentModel ? { model: content.agentModel } : {}),
      ...(content.agentPermissionMode ? { permissionMode: content.agentPermissionMode } : {}),
      // '' means "start a fresh thread" — distinct from undefined (use saved).
      ...(resumeOverride !== null
        ? resumeOverride
          ? { resumeSessionId: resumeOverride }
          : {}
        : content.agentResumeId
          ? { resumeSessionId: content.agentResumeId }
          : {}),
      ...(content.agentConfigDir ? { configDir: content.agentConfigDir } : {}),
    };
  });

  // Persist the live session id so a workspace switch can reattach instead of
  // spawning a second CLI.
  const contentRef = useRef(content);
  contentRef.current = content;
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const session = useAgentSession({
    options,
    ...(resumeOverride === null && content.agentSessionId
      ? { existingSessionId: content.agentSessionId }
      : {}),
    onSessionId: useCallback((sessionId: string) => {
      const current = contentRef.current;
      if (current.agentSessionId === sessionId) return;
      onContentChangeRef.current({ ...current, type: 'agent', agentSessionId: sessionId });
    }, []),
  });

  const [draft, setDraft] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pinnedToBottom = useRef(true);

  // Persist Claude's session id so reopening this pane continues the thread.
  const persistedResumeId = useRef(content.agentResumeId ?? '');
  useEffect(() => {
    const claudeSessionId = session.info?.claudeSessionId;
    if (!claudeSessionId || claudeSessionId === persistedResumeId.current) return;
    persistedResumeId.current = claudeSessionId;
    onContentChangeRef.current({
      ...contentRef.current,
      type: 'agent',
      agentCwd: session.info?.cwd ?? contentRef.current.agentCwd,
      agentResumeId: claudeSessionId,
      label: 'Claude Code',
    });
  }, [session.info?.claudeSessionId, session.info?.cwd]);

  // Follow the stream only while the user is already at the bottom, so reading
  // back through a long run isn't yanked away by new output.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [session.transcript]);

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  }, []);

  // Grow the composer with its content, up to a cap. Runs on mount as well so
  // a restored draft opens at its real height.
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = 'auto';
    const next = Math.min(Math.max(node.scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
    node.style.height = `${next}px`;
    node.style.overflowY = node.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [draft]);

  // The model list comes from the running CLI, so it reflects what this
  // account may actually select (including 1M-context variants).
  const [models, setModels] = useState<AgentModelOption[]>([]);
  useEffect(() => {
    const id = session.sessionId;
    if (!id || session.status === 'starting' || models.length > 0) return;
    let cancelled = false;
    let attempt = 0;

    // The CLI answers `initialize` before its model catalogue is queryable, so
    // one empty reply right after start is expected, not an error.
    const ask = () => {
      window.electronAPI
        .agentListModels(id)
        .then((list) => {
          if (cancelled) return;
          if (list.length > 0) {
            setModels(list);
            return;
          }
          if (++attempt < 5) timer = setTimeout(ask, 500);
        })
        .catch(() => undefined);
    };
    let timer = setTimeout(ask, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [session.sessionId, session.status, models.length]);

  // `/resume` is handled by the pane, not the CLI (which refuses it outside a
  // terminal), so it is offered in the picker alongside the real commands and
  // intercepted on submit. Mirrors how t3code maps some slash commands to
  // client actions instead of sending them.
  const slashCommands = useMemo(() => {
    const pane = paneSlashCommands();
    const owned = new Set(pane.map((command) => command.name));
    // `/clear` exists on both sides; the pane's version also resets what the
    // transcript shows, so it wins and the CLI's twin is dropped from the menu.
    return [...pane, ...(session.info?.slashCommands ?? []).filter((c) => !owned.has(c.name))];
  }, [session.info?.slashCommands]);

  const complete = useComposerComplete({
    draft,
    cwd: session.info?.cwd ?? content.agentCwd ?? workspaceRootPath ?? '',
    slashCommands,
  });

  /** Push a rewritten draft into the textarea and put the caret back. */
  const applyCompletion = useCallback(
    (result: { text: string; cursor: number } | null) => {
      if (!result) return;
      setDraft(result.text);
      complete.sync(result.text, result.cursor);
      requestAnimationFrame(() => {
        const node = inputRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(result.cursor, result.cursor);
      });
    },
    [complete],
  );

  const running = session.status === 'running';
  const busy = session.status === 'starting';
  const canSend = session.status === 'idle' || session.status === 'running';

  /** Publish a pane-authored line into the transcript (and the session history). */
  const note = useCallback(
    (text: string) => {
      const id = session.sessionId;
      if (id) void window.electronAPI.agentNote(id, text);
    },
    [session.sessionId],
  );

  /**
   * Run a command the pane owns. These never reach the CLI — either because it
   * refuses them outside a terminal, or because the pane is simply the right
   * place to answer them.
   */
  const runPaneCommand = useCallback(
    async (name: string, args: string) => {
      switch (name) {
        case 'resume':
          onOpenHistory();
          return;
        case 'clear':
          onNewThread();
          return;
        case 'exit':
          session.stop();
          onClose();
          return;
        case 'copy': {
          const wantsAll = args.toLowerCase() === 'all';
          const text = wantsAll
            ? transcriptToMarkdown(session.transcript)
            : lastAssistantText(session.transcript);
          if (!text) {
            note('Nothing to copy yet.');
            return;
          }
          await window.electronAPI.clipboardWriteText(text);
          note(
            wantsAll
              ? `Copied the whole thread (${text.length.toLocaleString()} characters).`
              : `Copied Claude's last reply (${text.length.toLocaleString()} characters).`,
          );
          return;
        }
        case 'export': {
          const markdown = transcriptToMarkdown(session.transcript);
          if (!markdown) {
            note('Nothing to export yet.');
            return;
          }
          const dir = await window.electronAPI.selectDirectory();
          if (!dir) return;
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          const file = `${dir}/claude-thread-${stamp}.md`;
          await window.electronAPI.writeFile(file, markdown);
          note(`Exported this thread to \`${file}\`.`);
          return;
        }
        case 'cost': {
          const totals = usageTotals(session.transcript);
          if (totals.turns === 0) {
            note('No turns in this thread yet.');
            return;
          }
          note(
            [
              `**Session cost** — $${totals.costUsd.toFixed(4)} across ${totals.turns} turn${totals.turns === 1 ? '' : 's'}.`,
              `Tokens: ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out.`,
              'Cost is the CLI\'s running estimate for this session, not a bill.',
            ].join('\n\n'),
          );
          return;
        }
        case 'status': {
          const usage = session.sessionId
            ? await window.electronAPI.agentContextUsage(session.sessionId)
            : null;
          const used = typeof usage?.total_tokens === 'number' ? usage.total_tokens : null;
          const window_ = typeof usage?.context_window === 'number' ? usage.context_window : null;
          note(
            [
              '**Pane status**',
              `Account: ${session.info?.account?.email ?? 'unknown'}` +
                (session.info?.account?.subscriptionType
                  ? ` (${session.info.account.subscriptionType})`
                  : ''),
              `Model: ${session.info?.model || 'session default'}`,
              `Permissions: ${session.permissionMode}`,
              `Folder: ${session.info?.cwd ?? content.agentCwd ?? workspaceRootPath ?? 'unknown'}`,
              `Thread: ${session.info?.claudeSessionId ?? '(not started)'}`,
              used !== null
                ? `Context: ${used.toLocaleString()}${window_ ? ` / ${window_.toLocaleString()}` : ''} tokens`
                : 'Context: unavailable',
            ].join('\n\n'),
          );
          return;
        }
        case 'help':
          note(
            [
              '**This pane runs your Claude Code**, driven through the Agent SDK instead of a terminal.',
              'Most commands go straight to the CLI. These are handled here: `/copy`, `/resume`, `/clear`, `/exit`, `/status`, `/cost`, `/export`, `/help`.',
              'Commands bound to the terminal UI (`/vim`, `/login`, `/permissions`, `/hooks`, …) cannot run in a pane — open a Terminal pane and run `claude` there.',
              'Composer: `@` inserts a file, `/` opens commands, Enter sends, Shift+Enter adds a line, Esc stops a running turn.',
            ].join('\n\n'),
          );
          return;
        default:
          return;
      }
    },
    [session, onOpenHistory, onNewThread, onClose, note, content.agentCwd, workspaceRootPath],
  );

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;

    const resolved = resolvePaneCommand(text);
    if (resolved?.kind === 'pane') {
      setDraft('');
      void runPaneCommand(resolved.name, resolved.args);
      return;
    }
    if (resolved?.kind === 'terminal-only') {
      setDraft('');
      note(terminalOnlyNote(resolved.name));
      return;
    }

    if (!canSend) return;
    session.send(text);
    setDraft('');
    pinnedToBottom.current = true;
  }, [draft, canSend, session, runPaneCommand, note]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // While the picker is open it owns the arrows, Tab, Enter and Escape —
      // Enter must complete the mention, not send a half-typed prompt.
      if (complete.open) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const count = complete.items.length;
          complete.setActiveIndex((complete.activeIndex + delta + count) % count);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          applyCompletion(complete.accept(complete.items[complete.activeIndex]));
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          complete.dismiss();
          return;
        }
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
        return;
      }
      if (event.key === 'Escape' && running) {
        event.preventDefault();
        session.interrupt();
      }
    },
    [complete, applyCompletion, submit, running, session],
  );

  const cwd = session.info?.cwd ?? content.agentCwd ?? workspaceRootPath ?? '';
  const model = session.info?.model ?? '';

  const statusColor = running
    ? 'var(--accent-yellow)'
    : session.status === 'error' || session.status === 'closed'
      ? 'var(--accent-red)'
      : busy
        ? 'var(--text-muted)'
        : 'var(--accent-green)';

  const statusLabel = useMemo(() => {
    // What the CLI is doing beats the coarse status: compaction can run for
    // tens of seconds, and "Working" alone reads as a stall.
    if (session.activity === 'compacting') return 'Compacting conversation… — Esc to stop';
    if (session.activity === 'requesting') return 'Waiting for Claude… — Esc to stop';
    switch (session.status) {
      case 'starting':
        return 'Starting Claude Code…';
      case 'running':
        return 'Working — Esc to stop';
      case 'error':
        return 'Session error';
      case 'closed':
        return 'Session ended';
      default:
        return 'Ready';
    }
  }, [session.status, session.activity]);

  // The footer carries the last turn's cost, which is otherwise easy to miss.
  const lastTurn = useMemo(() => {
    for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
      const item = session.transcript[index];
      if (item.kind === 'turn-end') return item;
    }
    return null;
  }, [session.transcript]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        minWidth: 0,
        background: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      {/* Title bar */}
      <div
        className="container-drag-handle"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px 0 10px',
          height: 32,
          minHeight: 32,
          background: 'var(--bg-titlebar)',
          borderBottom: '1px solid var(--border)',
          userSelect: 'none',
          cursor: 'grab',
        }}
      >
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            session.stop();
            onClose();
          }}
          title="Close"
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: 'var(--accent-red)',
            border: 'none',
            cursor: 'pointer',
            flexShrink: 0,
            opacity: 0.7,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
        />
        <PaneFocusButton containerId={containerId} />
        <div
          title={statusLabel}
          style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }}
        />
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-primary)',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {content.customName?.trim() || 'Claude Code'}
        </span>
        {cwd && (
          <span
            title={cwd}
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {shortenPath(cwd)}
          </span>
        )}
        {!cwd && <span style={{ flex: 1, minWidth: 0 }} />}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onOpenHistory}
          title="Threads — resume a past conversation in this folder"
          style={iconBtnStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <HistoryIcon size={13} />
        </button>
        {models.length > 0 ? (
          <div onMouseDown={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <Select
              value={content.agentModel ?? ''}
              options={[
                { value: '', label: shortenModel(model) || 'Model', meta: 'session default' },
                ...models.map((option) => ({
                  value: option.value,
                  label: option.label,
                  ...(option.description ? { meta: option.description } : {}),
                })),
              ]}
              onChange={(value) => {
                session.setModel(value || undefined);
                onContentChangeRef.current({
                  ...contentRef.current,
                  type: 'agent',
                  agentModel: value || undefined,
                });
              }}
              minWidth={110}
              title="Model"
            />
          </div>
        ) : model ? (
          <span
            title={model}
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              padding: '1px 6px',
              borderRadius: 4,
              background: 'var(--bg-surface)',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {shortenModel(model)}
          </span>
        ) : null}
        <div onMouseDown={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
          <Select
            value={session.permissionMode}
            options={PERMISSION_OPTIONS}
            onChange={(value) => {
              const mode = value as AgentPermissionMode;
              session.setPermissionMode(mode);
              onContentChangeRef.current({
                ...contentRef.current,
                type: 'agent',
                agentPermissionMode: mode,
              });
            }}
            minWidth={96}
            title="Permission mode — how tool calls are approved"
          />
        </div>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onSplitRight}
          title="Split right"
          style={iconBtnStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <SplitHorizontalIcon size={14} />
        </button>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onSplitDown}
          title="Split down"
          style={iconBtnStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <SplitVerticalIcon size={14} />
        </button>
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden' }}
      >
        {!options ? (
          <EmptyState
            title="No working directory"
            lines={[
              'A Claude Code pane runs in the workspace folder.',
              'Set a working directory for this workspace, then reopen the pane.',
            ]}
          />
        ) : session.transcript.length === 0 ? (
          <EmptyState
            title={busy ? 'Starting Claude Code…' : 'Claude Code'}
            lines={[
              cwd,
              session.info?.account?.email ?? '',
              session.info ? `${session.info.slashCommands.length} commands available` : '',
            ].filter(Boolean)}
            prompts={session.status === 'idle' ? STARTER_PROMPTS : []}
            onPrompt={(text) => {
              session.send(text);
              pinnedToBottom.current = true;
            }}
          />
        ) : (
          <AgentTranscriptView items={session.transcript} />
        )}
      </div>

      {/* Blocking interactions sit ABOVE the composer, outside the scroll area —
          an approval buried in scrollback reads as a hung session. */}
      {(session.approval || session.question) && (
        <AgentPendingAction
          approval={session.approval}
          question={session.question}
          onApproval={session.respondApproval}
          onQuestion={session.respondQuestion}
        />
      )}

      {/* Composer — one card holding the picker, the input and its controls, so
          the pane reads as a chat surface rather than a form with a button. */}
      <div
        style={{
          padding: '8px 10px 8px',
          background: 'var(--bg-titlebar)',
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <div
          style={{
            border: '1px solid',
            borderColor: composerFocused ? 'var(--border-active)' : 'var(--border)',
            borderRadius: 10,
            background: 'var(--bg-input)',
            overflow: 'hidden',
            minWidth: 0,
            transition: 'border-color 120ms ease',
          }}
        >
          {/* Indeterminate while a turn runs — the CLI gives no percentage, and
              a long turn otherwise looks like a stalled pane. */}
          {running && (
            <div
              className="agent-activity-bar"
              style={{
                color:
                  session.activity === 'compacting'
                    ? 'var(--accent-yellow)'
                    : 'var(--accent)',
              }}
              role="progressbar"
              aria-label={statusLabel}
            />
          )}
          {running && session.progress && (
            <AgentActivityLine
              progress={session.progress}
              activity={session.activity}
              onInterrupt={() => session.interrupt()}
            />
          )}
          <AgentCompleteMenu
            items={complete.items}
            activeIndex={complete.activeIndex}
            title={complete.title}
            onPick={(item) => applyCompletion(complete.accept(item))}
            onHover={complete.setActiveIndex}
          />
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              complete.sync(event.target.value, event.target.selectionStart ?? 0);
            }}
            onSelect={(event) => {
              const node = event.currentTarget;
              complete.sync(node.value, node.selectionStart ?? 0);
            }}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            onKeyDown={onKeyDown}
            placeholder={
              session.status === 'closed'
                ? 'Session ended — open Threads to start a new one'
                : 'Ask Claude Code…  @ for files, / for commands'
            }
            disabled={!canSend}
            rows={1}
            style={{
              display: 'block',
              width: '100%',
              minWidth: 0,
              resize: 'none',
              // NO `height` here: React re-applies inline styles on every
              // render, which would overwrite the auto-grow measurement in the
              // layout effect and pin the composer to a single line forever.
              minHeight: COMPOSER_MIN_HEIGHT,
              maxHeight: COMPOSER_MAX_HEIGHT,
              padding: '10px 12px 6px',
              border: 'none',
              background: 'transparent',
              color: 'var(--text-primary)',
              fontSize: 12.5,
              lineHeight: 1.55,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
            }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 8px 6px 12px',
              minWidth: 0,
            }}
          >
            {!running && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                {statusLabel}
              </span>
            )}
            {lastTurn?.usage?.costUsd ? (
              <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                · ${lastTurn.usage.costUsd < 0.01
                  ? lastTurn.usage.costUsd.toFixed(4)
                  : lastTurn.usage.costUsd.toFixed(2)}
              </span>
            ) : null}
            <span style={{ flex: 1, minWidth: 0 }} />
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                flexShrink: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              ⏎ send · ⇧⏎ newline
            </span>
            {running ? (
              <button
                onClick={() => session.interrupt()}
                title="Interrupt (Esc)"
                style={{
                  flexShrink: 0,
                  padding: '4px 12px',
                  borderRadius: 7,
                  border: '1px solid var(--accent-red)',
                  background: 'transparent',
                  color: 'var(--accent-red)',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Stop
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canSend || draft.trim().length === 0}
                title="Send (Enter)"
                style={{
                  flexShrink: 0,
                  padding: '4px 12px',
                  borderRadius: 7,
                  border: '1px solid',
                  borderColor: draft.trim() && canSend ? 'var(--accent)' : 'var(--border)',
                  background: draft.trim() && canSend ? 'var(--accent)' : 'transparent',
                  color: draft.trim() && canSend ? '#fff' : 'var(--text-muted)',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: draft.trim() && canSend ? 'pointer' : 'default',
                }}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const EmptyState: React.FC<{
  title: string;
  lines: string[];
  prompts?: string[];
  onPrompt?: (text: string) => void;
}> = ({ title, lines, prompts, onPrompt }) => (
  <div
    style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: 24,
      textAlign: 'center',
    }}
  >
    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
    {lines.map((line) => (
      <div
        key={line}
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          maxWidth: 420,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {line}
      </div>
    ))}
    {prompts && prompts.length > 0 && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, width: '100%', maxWidth: 320 }}>
        {prompts.map((prompt) => (
          <button
            key={prompt}
            onClick={() => onPrompt?.(prompt)}
            style={{
              padding: '7px 12px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 11,
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            {prompt}
          </button>
        ))}
      </div>
    )}
  </div>
);
