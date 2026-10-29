import React from 'react';
import { MarkdownMessage } from '../MarkdownMessage';
import type { AgentTranscriptItem } from '../../../shared/agent-types';
import {
  classifyTool,
  diffStat,
  fileChangeDiff,
  todoEntries,
  type DiffLine,
  type ToolKind,
  type TodoEntry,
} from './toolPresentation';

// One Claude Code pane's transcript.
//
// The shape of each item is chosen so a long run stays scannable at a glance:
// prose reads as prose at full width, a tool call collapses to a single line
// until it is opened, and each turn closes with a hairline carrying its cost.
// The user's own messages are the only thing that gets a bubble — they are the
// landmarks people scroll back to.

const KIND_ACCENT: Record<ToolKind, string> = {
  command: 'var(--accent-green)',
  'file-change': 'var(--accent-orange)',
  'file-read': 'var(--text-muted)',
  search: 'var(--accent-blue)',
  web: 'var(--accent-blue)',
  task: 'var(--accent-purple)',
  todo: 'var(--accent-yellow)',
  mcp: 'var(--accent-purple)',
  question: 'var(--accent-blue)',
  other: 'var(--text-muted)',
};

function formatTokens(value: number): string {
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function formatUsd(value: number | undefined): string | null {
  if (typeof value !== 'number' || value <= 0) return null;
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

const UserBubble: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ display: 'flex', justifyContent: 'flex-end', minWidth: 0 }}>
    <div
      style={{
        maxWidth: '88%',
        minWidth: 0,
        padding: '8px 12px',
        borderRadius: '12px 12px 4px 12px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRight: '2px solid var(--accent)',
        fontSize: 12.5,
        lineHeight: 1.55,
        color: 'var(--text-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  </div>
);

const ThinkingBlock: React.FC<{ text: string; streaming: boolean }> = ({ text, streaming }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 10, minWidth: 0 }}>
      <button
        onClick={() => setOpen((value) => !value)}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontSize: 11,
          color: 'var(--text-muted)',
          fontStyle: 'italic',
        }}
      >
        {open ? '▾' : '▸'} thinking{streaming ? '…' : ''}
      </button>
      {open && (
        <div
          style={{
            fontSize: 11.5,
            lineHeight: 1.55,
            color: 'var(--text-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginTop: 4,
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
};

const monoBlockStyle: React.CSSProperties = {
  margin: '5px 0 0',
  padding: '7px 9px',
  borderRadius: 6,
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  lineHeight: 1.5,
  maxHeight: 280,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

/** A file change rendered as what it is: a diff. */
const DiffView: React.FC<{ lines: DiffLine[] }> = ({ lines }) => (
  <pre style={{ ...monoBlockStyle, whiteSpace: 'pre' }}>
    {lines.map((line, index) => (
      <div
        key={index}
        style={{
          color:
            line.sign === '+'
              ? 'var(--accent-green)'
              : line.sign === '-'
                ? 'var(--accent-red)'
                : 'var(--text-muted)',
          background:
            line.sign === '+'
              ? 'rgba(21,172,145,0.08)'
              : line.sign === '-'
                ? 'rgba(241,76,76,0.08)'
                : 'transparent',
        }}
      >
        {line.sign}
        {line.text}
      </div>
    ))}
  </pre>
);

/** TodoWrite is a plan, not a tool call — show the plan. */
const TodoView: React.FC<{ todos: TodoEntry[] }> = ({ todos }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
    {todos.map((todo, index) => {
      const done = todo.status === 'completed';
      const active = todo.status === 'in_progress';
      return (
        <div
          key={index}
          style={{
            display: 'flex',
            gap: 7,
            fontSize: 11.5,
            lineHeight: 1.5,
            color: done ? 'var(--text-muted)' : 'var(--text-primary)',
            textDecoration: done ? 'line-through' : 'none',
            minWidth: 0,
          }}
        >
          <span
            style={{
              flexShrink: 0,
              color: done
                ? 'var(--accent-green)'
                : active
                  ? 'var(--accent-yellow)'
                  : 'var(--text-muted)',
            }}
          >
            {done ? '✓' : active ? '▸' : '○'}
          </span>
          <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{todo.content}</span>
        </div>
      );
    })}
  </div>
);

const ToolRow: React.FC<{ item: Extract<AgentTranscriptItem, { kind: 'tool' }> }> = ({ item }) => {
  const presentation = classifyTool(item.name, item.input, item.summary);
  const diff = presentation.kind === 'file-change' ? fileChangeDiff(item.name, item.input) : null;
  const todos = presentation.kind === 'todo' ? todoEntries(item.input) : [];
  const stat = diff ? diffStat(diff) : null;

  // A plan always reads; a diff is worth seeing by default on a small change.
  const [open, setOpen] = React.useState(
    presentation.kind === 'todo' || (diff !== null && diff.length <= 14),
  );
  const expandable = Boolean(item.output || diff || todos.length > 0);
  const accent = item.isError
    ? 'var(--accent-red)'
    : item.running
      ? 'var(--accent-yellow)'
      : KIND_ACCENT[presentation.kind];

  return (
    <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
      <div
        style={{
          width: 2,
          borderRadius: 1,
          background: accent,
          opacity: item.running ? 1 : 0.45,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <button
          onClick={() => setOpen((value) => !value)}
          disabled={!expandable}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '2px 0',
            background: 'transparent',
            border: 'none',
            cursor: expandable ? 'pointer' : 'default',
            textAlign: 'left',
            fontSize: 11.5,
            minWidth: 0,
          }}
        >
          <span style={{ color: accent, width: 12, flexShrink: 0, textAlign: 'center' }}>
            {presentation.icon}
          </span>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>
            {presentation.verb}
          </span>
          <span
            title={item.summary}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
            }}
          >
            {presentation.target}
          </span>
          {stat && (stat.added > 0 || stat.removed > 0) && (
            <span style={{ fontSize: 10, flexShrink: 0 }}>
              <span style={{ color: 'var(--accent-green)' }}>+{stat.added}</span>{' '}
              <span style={{ color: 'var(--accent-red)' }}>−{stat.removed}</span>
            </span>
          )}
          {item.running && (
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: 'var(--accent-yellow)',
                flexShrink: 0,
              }}
            />
          )}
          {expandable && (
            <span style={{ color: 'var(--text-muted)', fontSize: 10, flexShrink: 0 }}>
              {open ? '▾' : '▸'}
            </span>
          )}
        </button>

        {open && todos.length > 0 && <TodoView todos={todos} />}
        {open && diff && diff.length > 0 && <DiffView lines={diff} />}
        {open && item.output && (
          <pre
            style={{
              ...monoBlockStyle,
              color: item.isError ? 'var(--accent-red)' : 'var(--text-secondary)',
            }}
          >
            {item.output}
          </pre>
        )}
      </div>
    </div>
  );
};

const TurnFooter: React.FC<{ item: Extract<AgentTranscriptItem, { kind: 'turn-end' }> }> = ({
  item,
}) => {
  if (item.status === 'error') {
    return (
      <div
        style={{
          borderLeft: '2px solid var(--accent-red)',
          paddingLeft: 10,
          fontSize: 11,
          lineHeight: 1.5,
          color: 'var(--accent-red)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {item.message ?? 'The turn ended with an error.'}
      </div>
    );
  }

  const cost = formatUsd(item.usage?.costUsd);
  const duration = item.usage?.durationMs ? `${(item.usage.durationMs / 1000).toFixed(1)}s` : null;
  const label =
    item.status === 'interrupted'
      ? 'interrupted'
      : [cost, duration].filter(Boolean).join(' · ');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginTop: 2 }}>
      <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
      {label && (
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      )}
    </div>
  );
};

// Memoized per item: the transcript reducer keeps every untouched item's
// identity, so a streamed token re-renders (and re-parses the markdown of) only
// the item it lands in — not the whole run.
const TranscriptItem = React.memo<{ item: AgentTranscriptItem }>(({ item }) => {
  switch (item.kind) {
    case 'user':
      return <UserBubble key={item.id} text={item.text} />;
    case 'assistant':
      return (
        <div key={item.id} style={{ minWidth: 0 }}>
          <MarkdownMessage content={item.text} />
        </div>
      );
    case 'thinking':
      return <ThinkingBlock key={item.id} text={item.text} streaming={item.streaming} />;
    case 'tool':
      return <ToolRow key={item.id} item={item} />;
    case 'plan':
      return (
        <div
          key={item.id}
          style={{
            borderLeft: '2px solid var(--accent-blue)',
            borderRadius: '0 8px 8px 0',
            padding: '8px 12px',
            background: 'var(--bg-surface)',
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 0.6,
              color: 'var(--accent-blue)',
              marginBottom: 4,
            }}
          >
            PROPOSED PLAN
          </div>
          <MarkdownMessage content={item.plan} />
        </div>
      );
    case 'note':
      // Visibly the app's own voice: same left-rail language as a tool row,
      // never mistakable for something Claude said.
      return (
        <div
          key={item.id}
          style={{
            borderLeft: '2px solid var(--accent-blue)',
            paddingLeft: 10,
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 0.6,
              color: 'var(--accent-blue)',
              marginBottom: 2,
            }}
          >
            PANE
          </div>
          <MarkdownMessage content={item.text} />
        </div>
      );
    case 'compaction': {
      const shrank =
        item.postTokens !== undefined
          ? `${formatTokens(item.preTokens)} → ${formatTokens(item.postTokens)} tokens`
          : `from ${formatTokens(item.preTokens)} tokens`;
      const seconds = item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : '';
      return (
        <div
          key={item.id}
          style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, margin: '2px 0' }}
        >
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
            {item.trigger === 'auto' ? 'auto-compacted' : 'compacted'} {shrank}
            {seconds}
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>
      );
    }
    case 'turn-end':
      return <TurnFooter key={item.id} item={item} />;
    case 'error':
      // Deliberately quiet: an error is one line of context in the run, not
      // a full-bleed alarm that dwarfs everything the agent actually did.
      return (
        <div
          key={item.id}
          style={{
            borderLeft: '2px solid var(--accent-red)',
            paddingLeft: 10,
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--accent-red)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {item.message}
        </div>
      );
    default:
      return null;
  }
});
TranscriptItem.displayName = 'TranscriptItem';

// Memoized so composer keystrokes (AgentPanel state) don't re-render the run.
export const AgentTranscriptView = React.memo<{ items: AgentTranscriptItem[] }>(({ items }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: '14px 14px 10px',
      minWidth: 0,
    }}
  >
    {items.map((item) => <TranscriptItem key={item.id} item={item} />)}
  </div>
));
AgentTranscriptView.displayName = 'AgentTranscriptView';
