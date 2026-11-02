// ─── What an agent's hook says, in one notification-sized line ──────────────
// The hook helper forwards the payload the agent hands its hooks (stdin JSON).
// From it we pull the one line worth showing when the agent needs the user:
// the final answer on Stop, the question it asks (AskUserQuestion), or the
// tool call it wants permission for. Kept to a short single line so a system
// notification stays a banner, never a wall of text.

/** The few fields we read from Claude Code / Codex hook input. */
export interface HookPayload {
  hook_event_name?: string;
  /** Stop / SubagentStop: the text of the final reply. */
  last_assistant_message?: string;
  /** Notification: e.g. "Claude needs your permission to use Bash". */
  message?: string;
  notification_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export const DETAIL_MAX = 180;

export function parseHookPayload(raw: unknown): HookPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const input = o.tool_input && typeof o.tool_input === 'object' && !Array.isArray(o.tool_input)
    ? (o.tool_input as Record<string, unknown>)
    : undefined;
  return {
    hook_event_name: str(o.hook_event_name),
    last_assistant_message: str(o.last_assistant_message),
    message: str(o.message),
    notification_type: str(o.notification_type),
    tool_name: str(o.tool_name),
    tool_input: input,
  };
}

/** Markdown and line breaks out, whitespace collapsed, clipped at a word with "…". */
export function oneLine(text: string, max = DETAIL_MAX): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')            // code blocks carry no summary
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')      // [text](url) → text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/^\s*\|?[-:\s|]+\|?\s*$/gm, ' ')        // table rule rows
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > max * 0.6 ? cut.slice(0, atWord) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The question an AskUserQuestion call puts to the user, with its choices. */
function questionOf(input: Record<string, unknown> | undefined): string {
  const questions = Array.isArray(input?.questions) ? input!.questions : [];
  const first = questions[0] as Record<string, unknown> | undefined;
  const q = str(first?.question).trim();
  if (!q) return '';
  const labels = (Array.isArray(first?.options) ? first!.options : [])
    .map((o) => str((o as Record<string, unknown>)?.label).trim())
    .filter(Boolean);
  const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : '';
  return labels.length ? `${q} ${labels.join(' / ')}${more}` : `${q}${more}`;
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** "Bash: npm test", "Edit: app.ts" — what a tool call is about, for a permission prompt. */
export function toolSummary(name: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!name) return '';
  if (name === 'AskUserQuestion') return questionOf(input);
  const what =
    str(input?.command) ||
    (str(input?.file_path) && baseName(str(input?.file_path))) ||
    (str(input?.notebook_path) && baseName(str(input?.notebook_path))) ||
    str(input?.url) ||
    str(input?.pattern) ||
    str(input?.description) ||
    str(input?.prompt);
  const tool = name.replace(/^mcp__([^_]+)__/, '$1: ');
  return what ? `${tool}: ${what}` : tool;
}

/** The line for a finished turn: the agent's final reply. */
export function doneDetail(payload: HookPayload | null): string | undefined {
  const text = oneLine(payload?.last_assistant_message ?? '');
  return text || undefined;
}

export type PendingTool = Pick<HookPayload, 'tool_name' | 'tool_input'>;

/**
 * The line for an agent that is waiting: the question it asks, or the tool call
 * it wants allowed. A permission Notification doesn't name the tool itself, so
 * `pending` is the last call announced by PreToolUse that hasn't finished yet.
 */
export function waitingDetail(payload: HookPayload | null, pending?: PendingTool): string | undefined {
  const call = payload?.tool_name ? payload : pending;
  if (call?.tool_name) {
    const summary = toolSummary(call.tool_name, call.tool_input);
    return oneLine(call.tool_name === 'AskUserQuestion' ? summary : `Allow ${summary}?`) || undefined;
  }
  return oneLine(payload?.message ?? '') || undefined;
}
