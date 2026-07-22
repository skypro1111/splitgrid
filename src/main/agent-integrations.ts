import { syncInstalledAgentHooks, uninstallAgentHooks, removeRenamedLegacyAgentHooks } from './agent-hooks/installer';
import { AGENT_HOOK_DEFS } from './agent-hooks/registry';
import { syncInstalledAgentSkills, uninstallAgentSkills, removeRenamedLegacyAgentSkills } from './agent-skills/installer';
import { syncWslAgentArtifacts } from './agent-wsl-install';
import {
  setAgentIntegrationsEnabled, setAgentTerminalControlEnabled, setAgentSqlControlEnabled,
  setAgentSqlWriteEnabled, setAgentSftpControlEnabled, setAgentSftpWriteEnabled,
} from './local-shell-manager';
import { setTerminalControlEnabled } from './agent-terminal-bridge';

// ─── Agent integrations: the single permission gate ──────────────────────────
// Every GLOBAL change splitgrid can make to the machine on an agent's behalf is
// funnelled through here so it is governed by one opt-in (AppSettings.
// agentIntegrations, off by default — see app-settings-store):
//   • lifecycle hooks merged into ~/.claude & ~/.codex configs,
//   • the splitgrid-browser skill in ~/.claude/skills,
//   • the splitgrid-terminal skill — gated on the agentTerminalControl sub-opt-in,
//   • the splitgrid-sql skill — gated on the agentSqlControl sub-opt-in,
//   • the splitgrid-sftp skill — gated on the agentSftpControl sub-opt-in,
//   • the same artifacts inside each WSL distro's Linux ~/.claude,
//   • the SPLITGRID_* env injected into local terminals (the SPLITGRID_TERMINAL_* part
//     also gated on the sub-opt-in).
// Nothing installs on launch unless the user has turned it on; toggling it in
// Settings installs or uninstalls the host artifacts immediately.

/**
 * Apply the persisted permission on startup. Installs when enabled; when
 * disabled it does NOT touch the machine — launch must never modify the user's
 * global config on its own. It only arms the env-injection flags. `terminalControl`
 * is the cross-terminal sub-opt-in; it only takes effect while `enabled` is on.
 */
export function initAgentIntegrations(
  enabled: boolean,
  terminalControl = false,
  sqlControl = false,
  sqlWrite = false,
  sftpControl = false,
  sftpWrite = false,
): void {
  const terminal = enabled && terminalControl;
  const sql = enabled && sqlControl;
  const sftp = enabled && sftpControl;
  setAgentIntegrationsEnabled(enabled);
  setAgentTerminalControlEnabled(terminal);
  setTerminalControlEnabled(terminal);
  setAgentSqlControlEnabled(sql);
  setAgentSqlWriteEnabled(sql && sqlWrite);
  setAgentSftpControlEnabled(sftp);
  setAgentSftpWriteEnabled(sftp && sftpWrite);
  if (enabled) {
    // Each installer is gated on the agent actually being present and is
    // idempotent, so this also refreshes stale helper paths after an update.
    syncInstalledAgentHooks();
    syncInstalledAgentSkills(terminal, sql, sftp);
    void syncWslAgentArtifacts(terminal, sql, sftp);
  }
}

/**
 * Apply an explicit change to the permission (from Settings). Installs on
 * enable, uninstalls the host artifacts on disable. Idempotent. `terminalControl`
 * installs/removes just the terminal skill + env while the master stays on.
 */
export function applyAgentIntegrations(
  enabled: boolean,
  terminalControl = false,
  sqlControl = false,
  sqlWrite = false,
  sftpControl = false,
  sftpWrite = false,
): void {
  if (enabled) {
    initAgentIntegrations(true, terminalControl, sqlControl, sqlWrite, sftpControl, sftpWrite);
    return;
  }

  // Disabled → flip env injection off and remove what we installed into the host
  // config (best effort). WSL distro artifacts are left in place but go inert:
  // without the SPLITGRID_* env a claude inside the distro has nothing to report to
  // or drive.
  setAgentIntegrationsEnabled(false);
  setAgentTerminalControlEnabled(false);
  setTerminalControlEnabled(false);
  setAgentSqlControlEnabled(false);
  setAgentSqlWriteEnabled(false);
  setAgentSftpControlEnabled(false);
  setAgentSftpWriteEnabled(false);
  for (const def of AGENT_HOOK_DEFS) {
    try {
      uninstallAgentHooks(def);
    } catch {
      /* best effort */
    }
  }
  uninstallAgentSkills();
}

/**
 * One-time rename migration: remove agent artifacts (skills + lifecycle hooks)
 * that a previous, differently-named build installed into ~/.claude & ~/.codex,
 * so they don't linger beside the renamed app's. Runs on every startup; a no-op
 * once nothing legacy remains. Independent of the opt-in — leftover hooks must be
 * cleaned even if the user keeps integrations off.
 */
export function migrateLegacyAgentArtifacts(): void {
  try { removeRenamedLegacyAgentSkills(); } catch { /* best effort */ }
  try { removeRenamedLegacyAgentHooks(); } catch { /* best effort */ }
}
