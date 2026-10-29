import React, { useEffect, useMemo, useState } from 'react';
import type { AgentActivity } from '../../../shared/agent-types';
import type { AgentTurnProgress } from '../../hooks/useAgentSession';
import { classifyTool } from './toolPresentation';

// The pane's answer to the terminal's spinner line:
//
//   ✻ Discombobulating… (12s · ↑ 1.4k tokens · esc to interrupt)
//
// Every number here is real — elapsed time from the turn's start, output tokens
// from the streaming `message_delta`, thinking tokens from the CLI's own
// estimate, tool runtime from its heartbeat. Only the verb is ours, and it is
// what makes a long wait feel alive rather than hung.

const VERBS = [
  'Thinking',
  'Pondering',
  'Discombobulating',
  'Percolating',
  'Ruminating',
  'Untangling',
  'Noodling',
  'Cogitating',
  'Marinating',
  'Spelunking',
  'Deliberating',
  'Wrangling',
];

/** Braille spinner — one glyph, no layout shift as it turns. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Swap the verb occasionally, so a long turn does not look frozen. */
const VERB_PERIOD_MS = 9_000;
const SPINNER_PERIOD_MS = 90;

function formatTokens(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export const AgentActivityLine: React.FC<{
  progress: AgentTurnProgress;
  activity: AgentActivity;
  onInterrupt: () => void;
}> = ({ progress, activity, onInterrupt }) => {
  const [now, setNow] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const spin = setInterval(() => {
      setFrame((value) => value + 1);
      setNow(Date.now());
    }, SPINNER_PERIOD_MS);
    return () => clearInterval(spin);
  }, []);

  const elapsedMs = Math.max(0, now - progress.startedAt);
  const elapsed =
    elapsedMs < 60_000
      ? `${Math.floor(elapsedMs / 1000)}s`
      : `${Math.floor(elapsedMs / 60_000)}m ${Math.floor((elapsedMs % 60_000) / 1000)}s`;

  // Caption: what the CLI is actually doing wins over the whimsy.
  const caption = useMemo(() => {
    if (activity === 'compacting') return 'Compacting conversation';
    if (progress.tool) {
      const presentation = classifyTool(progress.tool.name, undefined, progress.tool.name);
      return `${presentation.verb} ${presentation.target}`;
    }
    if (progress.phase === 'thinking') return 'Thinking';
    if (progress.phase === 'responding') return 'Responding';
    // Stable per stretch of the turn rather than per render.
    const index = Math.floor(elapsedMs / VERB_PERIOD_MS) % VERBS.length;
    return VERBS[index];
  }, [activity, progress.tool, progress.phase, elapsedMs]);

  const counters = [
    elapsed,
    progress.tool ? `${Math.round(progress.tool.elapsedSeconds)}s in tool` : null,
    progress.thinkingTokens > 0 ? `${formatTokens(progress.thinkingTokens)} thinking` : null,
    progress.outputTokens > 0 ? `↑ ${formatTokens(progress.outputTokens)} tokens` : null,
  ].filter(Boolean);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 12px 6px',
        fontSize: 11,
        color: 'var(--text-muted)',
        minWidth: 0,
      }}
    >
      <span
        style={{
          color: activity === 'compacting' ? 'var(--accent-yellow)' : 'var(--accent)',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
        }}
      >
        {SPINNER[frame % SPINNER.length]}
      </span>
      <span
        style={{
          color: 'var(--text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {caption}…
      </span>
      <span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>({counters.join(' · ')}</span>
      <button
        onClick={onInterrupt}
        title="Interrupt (Esc)"
        style={{
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--text-muted)',
          fontSize: 11,
          cursor: 'pointer',
          flexShrink: 0,
          textDecoration: 'underline',
          textUnderlineOffset: 2,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-red)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        · esc to interrupt
      </button>
      <span style={{ flexShrink: 0 }}>)</span>
    </div>
  );
};
