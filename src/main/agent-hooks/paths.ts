import { app } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';

// Bundled `resources/` ships via forge `extraResource`, landing under
// process.resourcesPath in packaged builds and the project root in dev.
//
// In dev, app.getAppPath() points at the bundled main location (`.vite/build`),
// NOT the project root, so `<appPath>/resources` doesn't exist and every hook /
// browser-helper invocation fails with "No such file or directory". Probe up the
// tree from the app path for the real `resources/` dir; fall back to the naive
// path if none is found.
function resourcesDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'resources');
  let dir = app.getAppPath();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'resources');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(app.getAppPath(), 'resources');
}

/**
 * Absolute path to the OS-appropriate lifecycle-hook helper. Agent hook configs
 * invoke this as `<path> <event>`; it POSTs the event (tagged with
 * $SPLITGRID_TERMINAL) to splitgrid's local receiver. Note: we inject `RunAsNode:false`
 * via fuses, so the helper is a plain shell + curl script, not Electron-as-node.
 *
 * `posix` forces the .sh variant even on win32 — used for WSL terminals, where
 * the helper runs inside the Linux distro (the path is later translated to
 * /mnt/c/… by WSLENV's /p flag).
 */
export function hookHelperPath(posix = false): string {
  const name = (!posix && process.platform === 'win32') ? 'splitgrid-hook.cmd' : 'splitgrid-hook.sh';
  return path.join(resourcesDir(), name);
}

/**
 * Absolute path to the OS-appropriate browser-control helper. Agents invoke this
 * as `<path> <cmd> [args]` to drive their browser pane; it POSTs the argv (tagged
 * with $SPLITGRID_TERMINAL + $SPLITGRID_BROWSER_TOKEN) to splitgrid's /browser endpoint
 * and prints the JSON reply. Plain shell + curl, like the hook helper.
 *
 * `posix` forces the .sh variant even on win32 (WSL terminals); see hookHelperPath.
 */
export function browserHelperPath(posix = false): string {
  const name = (!posix && process.platform === 'win32') ? 'splitgrid-browser.cmd' : 'splitgrid-browser.sh';
  return path.join(resourcesDir(), name);
}

/**
 * Absolute path to the OS-appropriate terminal-control helper. Agents invoke this
 * as `<path> <cmd> [args]` to list/read/drive the other terminals in their
 * workspace; it POSTs the argv (tagged with $SPLITGRID_TERMINAL + $SPLITGRID_TERMINAL_TOKEN)
 * to splitgrid's /terminal endpoint and prints the JSON reply. Plain shell + curl,
 * like the browser helper.
 *
 * `posix` forces the .sh variant even on win32 (WSL terminals); see hookHelperPath.
 */
export function terminalHelperPath(posix = false): string {
  const name = (!posix && process.platform === 'win32') ? 'splitgrid-terminal.cmd' : 'splitgrid-terminal.sh';
  return path.join(resourcesDir(), name);
}

/**
 * Absolute path to the OS-appropriate SQL-control helper. Agents invoke this
 * as `<path> <cmd> [args]` to query/inspect/export against the SQL component; it
 * POSTs the argv (tagged with $SPLITGRID_TERMINAL + $SPLITGRID_SQL_TOKEN) to
 * splitgrid's /sql endpoint and prints the JSON reply. Plain shell + curl, like the
 * browser helper.
 *
 * `posix` forces the .sh variant even on win32 (WSL terminals); see hookHelperPath.
 */
export function sqlHelperPath(posix = false): string {
  const name = (!posix && process.platform === 'win32') ? 'splitgrid-sql.cmd' : 'splitgrid-sql.sh';
  return path.join(resourcesDir(), name);
}

/**
 * Absolute path to the OS-appropriate SFTP helper. Agents invoke this as
 * `<path> <cmd> [args]` to move files between this machine and the workspace's
 * remote hosts; it POSTs the argv (tagged with $SPLITGRID_TERMINAL +
 * $SPLITGRID_SFTP_TOKEN) to splitgrid's /sftp endpoint. `posix` forces the .sh
 * variant (WSL terminals run Linux even when the host is Windows).
 */
export function sftpHelperPath(posix = false): string {
  const name = (!posix && process.platform === 'win32') ? 'splitgrid-sftp.cmd' : 'splitgrid-sftp.sh';
  return path.join(resourcesDir(), name);
}

/**
 * Absolute path to the bundled <webview> focus-bridge preload. Loaded into every
 * browser guest page so a click (which never reaches the host window) posts a
 * host message to focus the owning pane.
 */
export function webviewFocusPreloadPath(): string {
  return path.join(resourcesDir(), 'webview-focus.js');
}

/**
 * Absolute path to the bundled Claude Code skill that teaches an agent how to
 * drive the browser pane via $SPLITGRID_BROWSER_CLI. Installed into the agent's
 * ~/.claude/skills/ on startup (see agent-skills/installer).
 */
export function browserSkillResourcePath(): string {
  return path.join(resourcesDir(), 'skills', 'sg-browser', 'SKILL.md');
}

/**
 * Absolute path to the bundled Claude Code skill that teaches an agent how to
 * drive the other terminals in its workspace via $SPLITGRID_TERMINAL_CLI. Installed
 * into the agent's ~/.claude/skills/ on startup (see agent-skills/installer).
 */
export function terminalSkillResourcePath(): string {
  return path.join(resourcesDir(), 'skills', 'sg-terminal', 'SKILL.md');
}

/**
 * Absolute path to the bundled Claude Code skill that teaches an agent how to
 * drive the workspace's SQL pane via $SPLITGRID_SQL_CLI. Installed into the
 * agent's ~/.claude/skills/ on startup (see agent-skills/installer).
 */
export function sqlSkillResourcePath(): string {
  return path.join(resourcesDir(), 'skills', 'sg-sql', 'SKILL.md');
}

/**
 * Absolute path to the bundled Claude Code skill that teaches an agent how to
 * move files to/from the workspace's remote hosts via $SPLITGRID_SFTP_CLI.
 * Installed into the agent's ~/.claude/skills/ on startup (see
 * agent-skills/installer).
 */
export function sftpSkillResourcePath(): string {
  return path.join(resourcesDir(), 'skills', 'sg-sftp', 'SKILL.md');
}
