export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'PreCompact',
  'PostCompact',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'Elicitation',
  'ElicitationResult',
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export interface HookEvent {
  session_id: string;
  hook_event_name: HookEventName;
  cwd: string;
  transcript_path: string;
  timestamp: number; // added by daemon
  // tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  // agent events
  agent_id?: string;
  agent_type?: string;
  // all other fields passed through
  [key: string]: unknown;
}

export interface DaemonStatus {
  uptime: number;
  sessions: number;
  totalEvents: number;
  port: number;
}
