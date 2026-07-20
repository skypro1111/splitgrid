// ─── Agent lifecycle-hook registry ──────────────────────────────────────────
// Each entry describes how to install splitgrid's turn-lifecycle hooks into one
// agent's GLOBAL config (in $HOME), à la cmux. The installed hook invokes the
// bundled helper with an event name; the helper POSTs it (tagged with
// $SPLITGRID_TERMINAL) to splitgrid's /hook endpoint, which drives the activity
// pipeline. Because the helper no-ops when $SPLITGRID_TERMINAL is unset, the global
// config is harmless for agent runs launched outside splitgrid.

/** Event names our /hook endpoint understands (see agent-activity-receiver). */
export type SplitGridHookEvent = 'prompt-submit' | 'stop' | 'notification' | 'tool';

export interface AgentEventMap {
  /** The agent's own hook event name (key in its config). */
  agentEvent: string;
  /** What we report to splitgrid for it. */
  splitgridEvent: SplitGridHookEvent;
  /** Whether this agent event expects a `"matcher"` field (tool-scoped events do). */
  matcher?: boolean;
}

export interface AgentHookDef {
  id: string;            // stable id: 'claude', 'codex'
  label: string;         // UI label
  /** Config dir relative to $HOME (e.g. '.claude'). */
  configDir: string;
  /** Env var that overrides the config dir if set (e.g. 'CODEX_HOME'). */
  configDirEnv?: string;
  /** Config file within the dir (e.g. 'settings.json', 'hooks.json'). */
  configFile: string;
  /** Key path inside the JSON where the hooks object lives (e.g. ['hooks']). */
  hooksKeyPath: string[];
  /** Per-event timeout written into the nested hook entry (ms). */
  timeoutMs: number;
  events: AgentEventMap[];
}

// Claude Code — settings.json, nested format. UserPromptSubmit/Stop/Notification
// are first-class Claude hook events. Pre/PostToolUse fire on every tool call
// (matcher '*' = all tools); we map them to a 'working' heartbeat so a long,
// tool-heavy turn keeps refreshing activity instead of being mistaken for idle
// by the safety sweep (Stop only fires at the very end of the turn).
export const CLAUDE: AgentHookDef = {
  id: 'claude',
  label: 'Claude Code',
  configDir: '.claude',
  configDirEnv: 'CLAUDE_CONFIG_DIR',
  configFile: 'settings.json',
  hooksKeyPath: ['hooks'],
  timeoutMs: 5000,
  events: [
    { agentEvent: 'UserPromptSubmit', splitgridEvent: 'prompt-submit' },
    { agentEvent: 'PreToolUse', splitgridEvent: 'tool', matcher: true },
    { agentEvent: 'PostToolUse', splitgridEvent: 'tool', matcher: true },
    { agentEvent: 'Stop', splitgridEvent: 'stop' },
    { agentEvent: 'Notification', splitgridEvent: 'notification' },
  ],
};

// Codex — hooks.json, nested format. Permission surfaces as PermissionRequest
// (not Notification). Same nested shape as Claude.
const CODEX: AgentHookDef = {
  id: 'codex',
  label: 'Codex',
  configDir: '.codex',
  configDirEnv: 'CODEX_HOME',
  configFile: 'hooks.json',
  hooksKeyPath: ['hooks'],
  timeoutMs: 5000,
  events: [
    { agentEvent: 'UserPromptSubmit', splitgridEvent: 'prompt-submit' },
    { agentEvent: 'Stop', splitgridEvent: 'stop' },
    { agentEvent: 'PermissionRequest', splitgridEvent: 'notification', matcher: true },
  ],
};

export const AGENT_HOOK_DEFS: AgentHookDef[] = [CLAUDE, CODEX];
