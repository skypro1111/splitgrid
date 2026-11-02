import { readFileSync } from 'node:fs';
import { terminalSkillResourcePath } from '../agent-hooks/paths';

// ─── sg-terminal: where long-running processes go ───────────────────────────
// As shipped, the skill lets simple background jobs (a dev server, a watcher,
// a log tail) stay background Bash jobs, with a tray pane when the user wants
// to watch one. With AppSettings.agentLongRunningInPanes on, the installed
// copy (host and WSL) swaps those passages for a version that puts every
// long-running process in a tray pane. SSH always gets its own pane either way.

export const BACKGROUND_DESCRIPTION =
  ' - and to open a small tray pane for a long-running process the user wants to watch. Simple background jobs may stay background Bash jobs.';
const PANES_DESCRIPTION =
  ' - and to start any long-running process (dev server, watcher, tail -f, http.server) in a small tray pane instead of a background Bash job, so the user can watch and stop it.';

export const BACKGROUND_RULE = `- **Simple background jobs may stay in the background.** A dev server,
  watcher or \`tail -f\` that only has to keep running can be a background Bash
  job (\`run_in_background\`). Open a tray pane with \`open <label> --background\`
  instead when the user asks to see it, or it must outlive this session.
  Background panes sit in a thin strip along the zone's bottom.`;
const PANES_RULE = `- **Long-running processes go in a tray pane, not the background.** A dev
  server, watcher, \`tail -f\` or \`python3 -m http.server\` started with
  \`run_in_background\` or \`&\` is invisible to the user and dies with this
  session. \`open <label> --background\` a terminal, \`send\` the command there,
  then \`read\` it. Background panes sit in a thin strip along the zone's
  bottom, so they stay visible without crowding the layout.`;

/** The sg-terminal skill text for the chosen long-running-process policy. */
export function renderTerminalSkill(text: string, longRunningInPanes: boolean): string {
  if (!longRunningInPanes) return text;
  return text.replace(BACKGROUND_DESCRIPTION, PANES_DESCRIPTION).replace(BACKGROUND_RULE, PANES_RULE);
}

let longRunningInPanes = false;

/** Set from AppSettings.agentLongRunningInPanes before the skills are synced. */
export function setTerminalSkillLongRunningInPanes(on: boolean): void {
  longRunningInPanes = on;
}

/** The bundled sg-terminal skill as it should be installed now. */
export function terminalSkillText(): string {
  return renderTerminalSkill(readFileSync(terminalSkillResourcePath(), 'utf8'), longRunningInPanes);
}
