import React, { useEffect, useState } from 'react';
import { GlobeIcon } from './Icons';
import { subscribeTerminalProcesses, getTerminalProcInfo } from '../hooks/useTerminalProcesses';
import { useClaudeActivity } from '../hooks/useClaudeActivity';

interface Props {
  sessionId: string;
  onOpen: (sessionId: string) => void;
}

// Header button shown while this terminal is running an agent (claude/codex).
// Clicking opens the browser bound to this agent — focusing its existing pane or
// creating one (handled by `onOpen`).
//
// Two detection signals, OR'd, because neither alone covers every shell:
//   1. Foreground process == claude/codex (live process feed). Works for native
//      shells but NOT WSL, where Win32_Process only sees wsl.exe, not the Linux
//      claude process.
//   2. The terminal has reported agent lifecycle activity (hooks, keyed by
//      SPLITGRID_TERMINAL). This crosses the WSL boundary, so a claude running
//      inside a distro still lights the icon.
export const AgentBrowserButton: React.FC<Props> = ({ sessionId, onOpen }) => {
  const [procIsAgent, setProcIsAgent] = useState(false);
  const activity = useClaudeActivity();

  useEffect(() => {
    const update = () => {
      const cmd = getTerminalProcInfo(sessionId)?.processCommand;
      setProcIsAgent(cmd === 'claude' || cmd === 'codex');
    };
    const unsub = subscribeTerminalProcesses(update);
    update();
    return unsub;
  }, [sessionId]);

  if (!procIsAgent && !activity.has(sessionId)) return null;

  return (
    <button
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => onOpen(sessionId)}
      title="Open this agent's browser"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, borderRadius: 4, flexShrink: 0,
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: 'var(--accent-blue, #4c9df3)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <GlobeIcon size={14} />
    </button>
  );
};
