// How a tool call is presented in the transcript.
//
// Modelled on t3code's canonical item taxonomy: they do not render "a tool",
// they render a command execution, a file change, a web search, an MCP call —
// each with its own icon, verb and body. A single generic row loses exactly the
// information a reader scans for, so the same split is made here, mapped from
// Claude Code's tool names.

export type ToolKind =
  | 'command'
  | 'file-change'
  | 'file-read'
  | 'search'
  | 'web'
  | 'task'
  | 'todo'
  | 'mcp'
  | 'question'
  | 'other';

export interface ToolPresentation {
  kind: ToolKind;
  /** Leading glyph, chosen per kind rather than per tool. */
  icon: string;
  /** What happened, as a verb phrase: "Ran", "Edited", "Searched". */
  verb: string;
  /** The thing it happened to — a path, a command, a query. */
  target: string;
  /** True for anything that can change the working tree. */
  mutates: boolean;
}

const KIND_ICONS: Record<ToolKind, string> = {
  command: '$',
  'file-change': '✎',
  'file-read': '◰',
  search: '⌕',
  web: '⇩',
  task: '⚙',
  todo: '☑',
  mcp: '⚒',
  question: '?',
  other: '•',
};

function field(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Trailing path segments — a full absolute path buries the filename. */
export function shortPath(value: string, segments = 2): string {
  const parts = value.split('/').filter(Boolean);
  if (parts.length <= segments) return value;
  return parts.slice(-segments).join('/');
}

export function classifyTool(name: string, input: unknown, summary: string): ToolPresentation {
  const make = (
    kind: ToolKind,
    verb: string,
    target: string,
    mutates = false,
  ): ToolPresentation => ({ kind, icon: KIND_ICONS[kind], verb, target: target || summary, mutates });

  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    return make('mcp', `${server ?? 'mcp'}`, tool ?? summary);
  }

  switch (name) {
    case 'Bash':
      return make('command', 'Ran', field(input, 'command') ?? summary, true);
    case 'BashOutput':
      return make('command', 'Read output', summary);
    case 'KillShell':
      return make('command', 'Stopped', summary, true);
    case 'Edit':
      return make('file-change', 'Edited', shortPath(field(input, 'file_path') ?? summary), true);
    case 'Write':
      return make('file-change', 'Wrote', shortPath(field(input, 'file_path') ?? summary), true);
    case 'NotebookEdit':
      return make('file-change', 'Edited', shortPath(field(input, 'notebook_path') ?? summary), true);
    case 'Read':
      return make('file-read', 'Read', shortPath(field(input, 'file_path') ?? summary));
    case 'Glob':
      return make('search', 'Globbed', field(input, 'pattern') ?? summary);
    case 'Grep':
      return make('search', 'Searched', field(input, 'pattern') ?? summary);
    case 'WebSearch':
      return make('web', 'Searched the web', field(input, 'query') ?? summary);
    case 'WebFetch':
      return make('web', 'Fetched', field(input, 'url') ?? summary);
    case 'Task':
    case 'Agent':
      return make('task', 'Delegated', field(input, 'description') ?? summary);
    case 'TodoWrite':
      return make('todo', 'Updated the plan', '');
    case 'AskUserQuestion':
      return make('question', 'Asked', summary);
    default:
      return make('other', name, summary);
  }
}

// ─── File-change diffs ───────────────────────────────────────────────────────

export type DiffLine = { sign: ' ' | '+' | '-'; text: string };

/**
 * Line diff of an Edit's before/after. A tool row that only says "Edited
 * App.tsx" hides the actual change; this is the part worth expanding to.
 */
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');

  // Classic LCS table — inputs here are one edit hunk, not whole files.
  const lcs: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    new Array<number>(newLines.length + 1).fill(0),
  );
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      all.push({ sign: ' ', text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      all.push({ sign: '-', text: oldLines[i] });
      i += 1;
    } else {
      all.push({ sign: '+', text: newLines[j] });
      j += 1;
    }
  }
  while (i < oldLines.length) all.push({ sign: '-', text: oldLines[i++] });
  while (j < newLines.length) all.push({ sign: '+', text: newLines[j++] });

  return trimToChangedRegions(all, context);
}

/** Keep changed lines plus a little context; drop long untouched stretches. */
function trimToChangedRegions(lines: DiffLine[], context: number): DiffLine[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.sign === ' ') return;
    for (let offset = -context; offset <= context; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) keep.add(target);
    }
  });
  if (keep.size === 0) return [];

  const out: DiffLine[] = [];
  let skipping = false;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      out.push(line);
      skipping = false;
    } else if (!skipping) {
      out.push({ sign: ' ', text: '…' });
      skipping = true;
    }
  });
  return out;
}

/** The diff a file-change tool call represents, if its input carries one. */
export function fileChangeDiff(name: string, input: unknown): DiffLine[] | null {
  if (name === 'Edit') {
    const before = field(input, 'old_string');
    const after = field(input, 'new_string');
    if (before === undefined || after === undefined) return null;
    return diffLines(before, after);
  }
  if (name === 'Write') {
    const content = field(input, 'content');
    if (content === undefined) return null;
    return content.split('\n').map((text) => ({ sign: '+' as const, text }));
  }
  return null;
}

/** `+n −m` for a diff, the way a changed-files list summarises one. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.sign === '+') added += 1;
    else if (line.sign === '-') removed += 1;
  }
  return { added, removed };
}

/** One todo as TodoWrite records it. */
export interface TodoEntry {
  content: string;
  status: string;
}

/** The todo list a TodoWrite call carries, if any. */
export function todoEntries(input: unknown): TodoEntry[] {
  if (!input || typeof input !== 'object') return [];
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return [];
  return todos
    .filter((todo): todo is Record<string, unknown> => !!todo && typeof todo === 'object')
    .map((todo) => ({
      content: typeof todo.content === 'string' ? todo.content : '',
      status: typeof todo.status === 'string' ? todo.status : 'pending',
    }))
    .filter((todo) => todo.content.length > 0);
}
