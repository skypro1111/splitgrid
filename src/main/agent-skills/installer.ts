import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { browserSkillResourcePath, terminalSkillResourcePath, sqlSkillResourcePath } from '../agent-hooks/paths';

// ─── Agent skill install ─────────────────────────────────────────────────────
// Ships splitgrid's Claude Code skills into the agent's global skills dir so a
// claude running in a splitgrid terminal knows how to use splitgrid's features: the
// browser pane and driving the other terminals in its workspace. Mirrors the
// lifecycle-hook installer: gated on the agent being present, idempotent, and
// refreshed on startup (so an app update updates the skill). Each skill no-ops
// outside splitgrid (its $SPLITGRID_*_CLI is empty).

// Every bundled skill we know how to install: the browser skill is part of the
// master opt-in; the terminal skill is gated on its own sub-opt-in (see
// syncInstalledAgentSkills' terminalControl arg).
const BROWSER_SKILL = 'sg-browser';
const TERMINAL_SKILL = 'sg-terminal';
const SQL_SKILL = 'sg-sql';

/** Claude's config dir: $CLAUDE_CONFIG_DIR if set, else ~/.claude. */
function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override && override.trim() ? override : path.join(homedir(), '.claude');
}

/** Install (or refresh) one bundled skill into ~/.claude/skills/<name>. */
function installSkill(claudeDir: string, name: string, source: string): void {
  if (!existsSync(source)) {
    console.error(`[agent-skills] bundled skill missing at ${source}`);
    return;
  }
  const destDir = path.join(claudeDir, 'skills', name);
  const dest = path.join(destDir, 'SKILL.md');
  try {
    const desired = readFileSync(source, 'utf8');
    // Write only when missing or stale, so we refresh on app update without
    // churning the file on every launch.
    const current = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (current === desired) return;
    mkdirSync(destDir, { recursive: true });
    writeFileSync(dest, desired, 'utf8');
    console.log(`[agent-skills] installed skill ${name} -> ${dest}`);
  } catch (err) {
    console.error(`[agent-skills] failed to install ${name}:`, (err as Error).message);
  }
}

/** Remove one bundled skill dir from ~/.claude/skills (only our own dir). */
function removeSkill(claudeDir: string, name: string): void {
  const destDir = path.join(claudeDir, 'skills', name);
  try {
    if (!existsSync(destDir)) return;
    rmSync(destDir, { recursive: true, force: true });
    console.log(`[agent-skills] removed skill ${name} -> ${destDir}`);
  } catch (err) {
    console.error(`[agent-skills] failed to remove ${name}:`, (err as Error).message);
  }
}

/**
 * Install (or refresh) the bundled skills into ~/.claude/skills. The browser
 * skill is always installed (master opt-in); the terminal and SQL skills are
 * each installed only when their sub-opt-in is on, and removed when it's off — so
 * toggling a sub-opt-in off cleans up after itself.
 */
export function syncInstalledAgentSkills(terminalControl: boolean, sqlControl = false): void {
  const claudeDir = claudeConfigDir();
  // Only install when Claude Code is actually present on this machine.
  if (!existsSync(claudeDir)) return;

  // Transit: drop any previously-named skill dirs (swapit-* / splitgrid-*) so a
  // refresh on app open OR on a Settings toggle leaves only the current sg-* set.
  for (const legacy of LEGACY_SKILLS) removeSkill(claudeDir, legacy);

  installSkill(claudeDir, BROWSER_SKILL, browserSkillResourcePath());
  if (terminalControl) installSkill(claudeDir, TERMINAL_SKILL, terminalSkillResourcePath());
  else removeSkill(claudeDir, TERMINAL_SKILL);
  if (sqlControl) installSkill(claudeDir, SQL_SKILL, sqlSkillResourcePath());
  else removeSkill(claudeDir, SQL_SKILL);
}

/** Remove every bundled skill from ~/.claude/skills (only our own dirs). */
export function uninstallAgentSkills(): void {
  const claudeDir = claudeConfigDir();
  removeSkill(claudeDir, BROWSER_SKILL);
  removeSkill(claudeDir, TERMINAL_SKILL);
  removeSkill(claudeDir, SQL_SKILL);
}

// Skill dir names this app shipped under previous names (the old product name
// `swapit-*`, and the longer `splitgrid-*` names before the `sg-*` shortening).
const LEGACY_SKILLS = [
  'swapit-browser', 'swapit-terminal', 'swapit-sql',
  'splitgrid-browser', 'splitgrid-terminal', 'splitgrid-sql',
];

/**
 * One-time rename migration: remove skill dirs installed under the old product
 * name so they don't linger in ~/.claude/skills beside the renamed ones.
 */
export function removeRenamedLegacyAgentSkills(): void {
  const claudeDir = claudeConfigDir();
  if (!existsSync(claudeDir)) return;
  for (const legacy of LEGACY_SKILLS) removeSkill(claudeDir, legacy);
}
