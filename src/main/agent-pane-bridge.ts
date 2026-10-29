import type { ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { app } from 'electron';
import { isAgentToken } from './agent-browser-bridge';
import { claudeAgentManager } from './agent/claude-agent-manager';
import { agentDiagnosticsLogPath, readAgentDiagnostics } from './agent/agent-diagnostics';
import type { AgentApprovalDecision, AgentEvent } from '../shared/agent-types';

// ─── Agent pane bridge ───────────────────────────────────────────────────────
// Lets an agent in a splitgrid terminal inspect and drive the Claude Code PANES
// of the app through `splitgrid-agent`, POSTing to /agent on the same local
// server as the other bridges (:19558).
//
// Unlike the terminal / sql / sftp bridges, this one does NOT round-trip through
// the renderer: the session manager lives in the main process, so answering here
// keeps the bridge usable in exactly the case it exists for — a pane whose UI is
// stuck and cannot answer for itself.
//
// Same per-run secret and the same sub-opt-in as cross-terminal control: sending
// a prompt to a pane (or approving its tool call) is as privileged as typing in
// somebody else's shell.

interface BridgeResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

let agentPaneControlEnabled = false;
export function setAgentPaneControlEnabled(enabled: boolean): void {
  agentPaneControlEnabled = enabled;
}

const DECISIONS: AgentApprovalDecision[] = ['allow', 'allowForSession', 'deny', 'cancel'];

const USAGE = [
  'splitgrid-agent list',
  'splitgrid-agent state <session|#n>',
  'splitgrid-agent events <session|#n> [--tail N]',
  'splitgrid-agent diag [<session|#n>] [--tail N]',
  'splitgrid-agent send <session|#n> <text...>',
  'splitgrid-agent interrupt <session|#n>',
  'splitgrid-agent approve <session|#n> <requestId> <allow|allowForSession|deny|cancel>',
  'splitgrid-agent answer <session|#n> <requestId> <label>',
  'splitgrid-agent mode <session|#n> <default|auto|acceptEdits|plan|bypassPermissions>',
  'splitgrid-agent stop <session|#n>',
];

/** Read `--tail N` out of argv, returning the value and the remaining args. */
export function takeTail(argv: string[], fallback: number): { tail: number; rest: string[] } {
  const rest: string[] = [];
  let tail = fallback;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--tail') {
      // Consumed even when the value is missing or junk, so a stray flag is
      // never mistaken for the session reference.
      const parsed = Number.parseInt(argv[index + 1] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) tail = parsed;
      index += 1;
      continue;
    }
    rest.push(argv[index]);
  }
  return { tail, rest };
}

/**
 * Resolve a session reference: a full id, a unique id prefix, or `#n` (the
 * 1-based position in `list`). Debugging by hand with 36-char uuids is
 * miserable, and the index is what a human actually reads off `list`.
 */
export function resolveSessionRef(
  ref: string,
  sessions: { sessionId: string }[],
): { sessionId: string } | { error: string } {
  const trimmed = (ref ?? '').trim();
  if (!trimmed) return { error: 'missing_session' };

  if (trimmed.startsWith('#')) {
    const index = Number.parseInt(trimmed.slice(1), 10);
    const found = sessions[index - 1];
    return found ? { sessionId: found.sessionId } : { error: 'unknown_session' };
  }
  const exact = sessions.find((session) => session.sessionId === trimmed);
  if (exact) return { sessionId: exact.sessionId };

  const matches = sessions.filter((session) => session.sessionId.startsWith(trimmed));
  if (matches.length === 1) return { sessionId: matches[0].sessionId };
  if (matches.length > 1) return { error: 'ambiguous_session' };
  return { error: 'unknown_session' };
}

/**
 * Which build is actually running: the app version plus the mtime of the main
 * bundle this process was loaded from, and how long it has been up.
 */
function runningBuild(): Record<string, unknown> {
  let builtAt: string | null = null;
  try {
    builtAt = new Date(statSync(__filename).mtimeMs).toISOString();
  } catch {
    // Packaged from an asar that reports no mtime — the version still helps.
  }
  return {
    version: app.getVersion(),
    builtAt,
    startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
  };
}

/** Compact one transcript event for the wire — never the full tool output. */
function briefEvent(event: AgentEvent): Record<string, unknown> {
  const base = { type: event.type };
  switch (event.type) {
    case 'user.message':
    case 'pane.note':
      return { ...base, text: event.text };
    case 'text.delta':
      return { ...base, kind: event.kind, text: event.text };
    case 'tool.start':
      return { ...base, tool: event.name, summary: event.summary };
    case 'tool.end':
      return { ...base, isError: event.isError, output: event.output.slice(0, 2000) };
    case 'session.init':
      return { ...base, model: event.model, cwd: event.cwd, mode: event.permissionMode };
    case 'session.status':
      return { ...base, status: event.status };
    case 'session.activity':
      return { ...base, activity: event.activity };
    case 'context.compacted':
      return { ...base, preTokens: event.preTokens, postTokens: event.postTokens };
    case 'session.error':
      return { ...base, message: event.message };
    case 'turn.end':
      return { ...base, status: event.status, ...(event.message ? { message: event.message } : {}) };
    case 'approval.request':
      return {
        ...base,
        requestId: event.request.requestId,
        tool: event.request.toolName,
        summary: event.request.summary,
      };
    case 'question.request':
      return {
        ...base,
        requestId: event.request.requestId,
        question: event.request.question,
        options: event.request.options.map((option) => option.label),
      };
    default:
      return base;
  }
}

/**
 * Run one `splitgrid-agent` command against the live pane sessions.
 * Transport-agnostic; the caller validates the token.
 */
export async function processAgentPaneCommand(argv: string[]): Promise<BridgeResult> {
  if (!agentPaneControlEnabled) {
    return {
      ok: false,
      error: 'agent_pane_control_disabled',
      data: {
        message:
          'Claude Code pane control is disabled. Enable Settings → Agent integrations → Terminal control.',
      },
    };
  }
  if (argv.length === 0 || argv[0] === 'help') {
    return { ok: true, data: { usage: USAGE } };
  }

  const [command, ...args] = argv;
  const sessions = claudeAgentManager.list() as ({ sessionId: string } & Record<string, unknown>)[];

  if (command === 'list') {
    // The build stamp answers the question that otherwise costs a round trip:
    // "is the running app the one I just built?"
    return { ok: true, data: { app: runningBuild(), count: sessions.length, sessions } };
  }

  if (command === 'diag' && (args.length === 0 || args[0] === '--tail')) {
    const { tail } = takeTail(args, 200);
    return {
      ok: true,
      data: {
        logPath: agentDiagnosticsLogPath(),
        entries: readAgentDiagnostics(undefined, tail),
      },
    };
  }

  const { tail, rest } = takeTail(args, command === 'events' ? 80 : 200);
  const ref = resolveSessionRef(rest[0] ?? '', sessions);
  if ('error' in ref) {
    return {
      ok: false,
      error: ref.error,
      data: { message: `Unknown session '${rest[0] ?? ''}'.`, known: sessions.map((s) => s.sessionId) },
    };
  }
  const { sessionId } = ref;

  switch (command) {
    case 'state': {
      const snapshot = claudeAgentManager.snapshot(sessionId);
      return snapshot ? { ok: true, data: snapshot } : { ok: false, error: 'unknown_session' };
    }
    case 'events': {
      const events = claudeAgentManager.replay(sessionId);
      if (!events) return { ok: false, error: 'unknown_session' };
      return {
        ok: true,
        data: {
          total: events.length,
          events: events.slice(Math.max(0, events.length - tail)).map(briefEvent),
        },
      };
    }
    case 'diag':
      return {
        ok: true,
        data: {
          logPath: agentDiagnosticsLogPath(),
          entries: readAgentDiagnostics(sessionId, tail),
        },
      };
    case 'send': {
      const text = rest.slice(1).join(' ').trim();
      if (!text) return { ok: false, error: 'missing_text' };
      claudeAgentManager.send(sessionId, text);
      return { ok: true, data: { sessionId, sent: text } };
    }
    case 'interrupt':
      await claudeAgentManager.interrupt(sessionId);
      return { ok: true, data: { sessionId } };
    case 'approve': {
      const requestId = rest[1] ?? '';
      const decision = (rest[2] ?? 'allow') as AgentApprovalDecision;
      if (!requestId) return { ok: false, error: 'missing_request' };
      if (!DECISIONS.includes(decision)) {
        return { ok: false, error: 'bad_decision', data: { expected: DECISIONS } };
      }
      claudeAgentManager.respondToApproval(sessionId, requestId, decision);
      return { ok: true, data: { sessionId, requestId, decision } };
    }
    case 'answer': {
      const requestId = rest[1] ?? '';
      const label = rest.slice(2).join(' ').trim();
      if (!requestId) return { ok: false, error: 'missing_request' };
      const events = claudeAgentManager.replay(sessionId) ?? [];
      const pending = [...events]
        .reverse()
        .find((event) => event.type === 'question.request' && event.request.requestId === requestId);
      if (!pending || pending.type !== 'question.request') {
        return { ok: false, error: 'unknown_request' };
      }
      claudeAgentManager.respondToQuestion(
        sessionId,
        requestId,
        label ? { [pending.request.question]: label } : null,
      );
      return { ok: true, data: { sessionId, requestId, answered: label || '(cancelled)' } };
    }
    case 'mode': {
      const mode = rest[1] ?? '';
      const allowed = ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'];
      if (!allowed.includes(mode)) {
        return { ok: false, error: 'bad_mode', data: { expected: allowed } };
      }
      await claudeAgentManager.setPermissionMode(
        sessionId,
        mode as Parameters<typeof claudeAgentManager.setPermissionMode>[1],
      );
      return { ok: true, data: { sessionId, mode } };
    }
    case 'stop':
      await claudeAgentManager.stop(sessionId, 'Stopped from splitgrid-agent.');
      return { ok: true, data: { sessionId } };
    default:
      return { ok: false, error: 'unknown_command', data: { usage: USAGE } };
  }
}

/** Flatten a BridgeResult into the wire shape agents consume. */
export function flattenAgentPaneResult(result: BridgeResult): Record<string, unknown> {
  return { ok: result.ok, ...(result.data ?? {}), ...(result.error ? { error: result.error } : {}) };
}

/** Handle a POST /agent request: validate the token, run the command, reply. */
export async function handleAgentPaneRequest(raw: Buffer, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  let parsed: { token?: unknown; argv?: unknown };
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    reply(400, { ok: false, error: 'invalid_json' });
    return;
  }
  if (!isAgentToken(parsed?.token)) {
    reply(403, { ok: false, error: 'bad_token' });
    return;
  }
  const argv = Array.isArray(parsed.argv) ? parsed.argv.map((entry) => String(entry)) : [];

  try {
    reply(200, flattenAgentPaneResult(await processAgentPaneCommand(argv)));
  } catch (error) {
    reply(200, { ok: false, error: 'bridge_error', message: (error as Error).message });
  }
}
