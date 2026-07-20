import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { detectWslDistros, wslExePath } from './wsl';
import { hookHelperPath, browserSkillResourcePath, terminalSkillResourcePath, sqlSkillResourcePath } from './agent-hooks/paths';
import { applyHooksToConfig } from './agent-hooks/installer';
import { CLAUDE } from './agent-hooks/registry';
import { winPathToWsl } from './wsl-paths';
import { decodeWslOutput } from './wsl-encoding';

// ─── In-distro agent install (Claude inside WSL) ─────────────────────────────
// The host-side hook/skill installers write to the WINDOWS ~/.claude. A claude
// running inside a WSL distro reads the distro's LINUX ~/.claude, so it never sees
// them. This installer reaches into each distro (over `wsl … sh -s`, script piped
// via stdin so Windows arg-quoting can't mangle it) and installs the same two
// artifacts there:
//   • lifecycle hooks in ~/.claude/settings.json — merged, preserving the user's
//     own settings; the hook command points at the WSL-translated helper path
//     (/mnt/c/…/splitgrid-hook.sh, which itself rewrites the loopback endpoint).
//   • the browser skill in ~/.claude/skills/sg-browser/SKILL.md.
//   • the terminal skill in ~/.claude/skills/sg-terminal/SKILL.md.
//   • the SQL skill in ~/.claude/skills/sg-sql/SKILL.md.
// Gated on the distro already having ~/.claude (Claude present); idempotent
// (writes only when content actually changes).

const SKILL_REL = '.claude/skills/sg-browser/SKILL.md';
const SKILL_REL_TERMINAL = '.claude/skills/sg-terminal/SKILL.md';
const SKILL_REL_SQL = '.claude/skills/sg-sql/SKILL.md';
// Previously-named skill dirs to clean up inside the distro (transit).
const WSL_LEGACY_SKILL_DIRS = [
  'swapit-browser', 'swapit-terminal', 'swapit-sql',
  'splitgrid-browser', 'splitgrid-terminal', 'splitgrid-sql',
];
const READ_MARK_SETTINGS = '===SPLITGRID_SETTINGS===';
const READ_MARK_SKILL = '===SPLITGRID_SKILL===';
const READ_MARK_SKILL_TERMINAL = '===SPLITGRID_SKILL_TERMINAL===';
const READ_MARK_SKILL_SQL = '===SPLITGRID_SKILL_SQL===';

// Path translation + UTF-16/UTF-8 decoding live in shared pure modules
// (wsl-paths / wsl-encoding) so they're unit-tested in one place.

// Run a script inside a distro by piping it to `sh -s` over stdin. Returns stdout.
function runInDistro(distro: string, script: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(wslExePath(), ['-d', distro, '--', 'sh', '-s'], { windowsHide: true });
    const out: Buffer[] = [];
    let settled = false;
    const finish = (err?: Error, buf?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(decodeWslOutput(buf ?? Buffer.alloc(0)));
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(new Error('wsl timeout')); }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.on('error', (e) => finish(e));
    child.on('close', () => finish(undefined, Buffer.concat(out)));
    child.stdin.on('error', () => { /* ignore EPIPE */ });
    child.stdin.write(script);
    child.stdin.end();
  });
}

// One read round-trip: does the distro have ~/.claude, and what are the current
// settings.json + skill contents (so we can merge/compare without clobbering)?
const READ_SCRIPT =
  `if [ -d "$HOME/.claude" ]; then echo HASCLAUDE=1; else echo HASCLAUDE=0; fi;` +
  `echo '${READ_MARK_SETTINGS}';` +
  `cat "$HOME/.claude/settings.json" 2>/dev/null;` +
  `echo;echo '${READ_MARK_SKILL}';` +
  `cat "$HOME/${SKILL_REL}" 2>/dev/null;` +
  `echo;echo '${READ_MARK_SKILL_TERMINAL}';` +
  `cat "$HOME/${SKILL_REL_TERMINAL}" 2>/dev/null;` +
  `echo;echo '${READ_MARK_SKILL_SQL}';` +
  `cat "$HOME/${SKILL_REL_SQL}" 2>/dev/null`;

interface DistroState { hasClaude: boolean; settingsText: string; skillText: string; terminalSkillText: string; sqlSkillText: string; }

function parseReadOutput(out: string): DistroState {
  const hasClaude = /(^|\n)HASCLAUDE=1(\r?\n|$)/.test(out);
  const sIdx = out.indexOf(READ_MARK_SETTINGS);
  const kIdx = out.indexOf(READ_MARK_SKILL);
  const tIdx = out.indexOf(READ_MARK_SKILL_TERMINAL);
  const qIdx = out.indexOf(READ_MARK_SKILL_SQL);
  let settingsText = '';
  let skillText = '';
  let terminalSkillText = '';
  let sqlSkillText = '';
  if (sIdx >= 0 && kIdx >= 0 && tIdx >= 0 && qIdx >= 0) {
    settingsText = out.slice(sIdx + READ_MARK_SETTINGS.length, kIdx).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    skillText = out.slice(kIdx + READ_MARK_SKILL.length, tIdx).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    terminalSkillText = out.slice(tIdx + READ_MARK_SKILL_TERMINAL.length, qIdx).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    sqlSkillText = out.slice(qIdx + READ_MARK_SKILL_SQL.length).replace(/^\r?\n/, '');
  }
  return { hasClaude, settingsText, skillText, terminalSkillText, sqlSkillText };
}

async function installInto(distro: string, wslHookPath: string, skill: string, terminalSkill: string, sqlSkill: string, terminalControl: boolean, sqlControl: boolean): Promise<void> {
  let state: DistroState;
  try {
    state = parseReadOutput(await runInDistro(distro, READ_SCRIPT));
  } catch (err) {
    console.error(`[agent-wsl] ${distro}: read failed: ${(err as Error).message}`);
    return;
  }
  if (!state.hasClaude) return; // Claude not installed in this distro — leave it alone.

  // Merge hooks into the distro's settings (preserve the user's own settings).
  // If the existing file is non-empty but unparseable, skip the settings write
  // rather than clobber a config we can't safely merge.
  let settingsOut: string | null = null;
  const trimmed = state.settingsText.trim();
  try {
    const root = trimmed ? JSON.parse(trimmed) : {};
    const merged = applyHooksToConfig(root, CLAUDE, wslHookPath);
    const serialized = JSON.stringify(merged, null, 2) + '\n';
    // Compare against current to stay idempotent.
    const current = trimmed ? JSON.stringify(JSON.parse(trimmed), null, 2) + '\n' : '';
    if (serialized !== current) settingsOut = serialized;
  } catch {
    console.error(`[agent-wsl] ${distro}: existing settings.json is not valid JSON — skipping hook install`);
  }

  const skillOut = state.skillText === skill ? null : skill;
  // Terminal skill is gated on the sub-opt-in: install/refresh when on, remove
  // when off (mirrors the host installer so toggling off cleans up the distro).
  const terminalSkillOut = terminalControl && state.terminalSkillText !== terminalSkill ? terminalSkill : null;
  const removeTerminalSkill = !terminalControl && state.terminalSkillText.trim() !== '';
  // SQL skill is gated on its own sub-opt-in: install/refresh when on, remove when off.
  const sqlSkillOut = sqlControl && state.sqlSkillText !== sqlSkill ? sqlSkill : null;
  const removeSqlSkill = !sqlControl && state.sqlSkillText.trim() !== '';

  if (
    settingsOut === null && skillOut === null
    && terminalSkillOut === null && !removeTerminalSkill
    && sqlSkillOut === null && !removeSqlSkill
  ) return; // already up to date

  // One write round-trip: base64-decode each payload into place. base64 has no
  // shell-special chars, so embedding it in a single-quoted heredoc-free script
  // is safe regardless of the file contents. settings.json is written atomically.
  let script = `mkdir -p "$HOME/.claude" "$HOME/.claude/skills/sg-browser" "$HOME/.claude/skills/sg-terminal" "$HOME/.claude/skills/sg-sql";`;
  // Transit: drop any previously-named skill dirs in the distro.
  for (const legacy of WSL_LEGACY_SKILL_DIRS) script += `rm -rf "$HOME/.claude/skills/${legacy}";`;
  if (settingsOut !== null) {
    const b64 = Buffer.from(settingsOut, 'utf8').toString('base64');
    script += `printf '%s' '${b64}' | base64 -d > "$HOME/.claude/settings.json.splitgrid.tmp" && mv "$HOME/.claude/settings.json.splitgrid.tmp" "$HOME/.claude/settings.json";`;
  }
  if (skillOut !== null) {
    const b64 = Buffer.from(skillOut, 'utf8').toString('base64');
    script += `printf '%s' '${b64}' | base64 -d > "$HOME/${SKILL_REL}";`;
  }
  if (terminalSkillOut !== null) {
    const b64 = Buffer.from(terminalSkillOut, 'utf8').toString('base64');
    script += `printf '%s' '${b64}' | base64 -d > "$HOME/${SKILL_REL_TERMINAL}";`;
  }
  if (removeTerminalSkill) {
    script += `rm -f "$HOME/${SKILL_REL_TERMINAL}";`;
  }
  if (sqlSkillOut !== null) {
    const b64 = Buffer.from(sqlSkillOut, 'utf8').toString('base64');
    script += `printf '%s' '${b64}' | base64 -d > "$HOME/${SKILL_REL_SQL}";`;
  }
  if (removeSqlSkill) {
    script += `rm -f "$HOME/${SKILL_REL_SQL}";`;
  }
  script += `echo OK`;

  try {
    const res = await runInDistro(distro, script);
    if (res.includes('OK')) {
      console.log(`[agent-wsl] ${distro}: installed${settingsOut !== null ? ' hooks' : ''}${skillOut !== null ? ' skill' : ''}${terminalSkillOut !== null ? ' terminal-skill' : ''}${removeTerminalSkill ? ' (removed terminal-skill)' : ''}${sqlSkillOut !== null ? ' sql-skill' : ''}${removeSqlSkill ? ' (removed sql-skill)' : ''}`);
    } else {
      console.error(`[agent-wsl] ${distro}: write returned unexpected output: ${res.slice(0, 120)}`);
    }
  } catch (err) {
    console.error(`[agent-wsl] ${distro}: write failed: ${(err as Error).message}`);
  }
}

/**
 * Install/refresh splitgrid's Claude hooks + browser skill inside every detected WSL
 * distro that has Claude. The terminal and SQL skills are each installed only when
 * their sub-opt-in (`terminalControl` / `sqlControl`) is on, and removed when off.
 * Windows-only; best-effort and idempotent; safe to call on every startup.
 * Fire-and-forget (returns a promise the caller may ignore).
 */
export async function syncWslAgentArtifacts(terminalControl = false, sqlControl = false): Promise<void> {
  if (process.platform !== 'win32') return;

  const hostHelper = hookHelperPath(true); // force the .sh helper (runs inside the distro)
  const wslHookPath = winPathToWsl(hostHelper);
  if (!wslHookPath) {
    console.error(`[agent-wsl] cannot translate helper path to WSL: ${hostHelper}`);
    return;
  }

  const skillSrc = browserSkillResourcePath();
  if (!existsSync(skillSrc)) {
    console.error(`[agent-wsl] bundled skill missing at ${skillSrc}`);
    return;
  }
  const skill = readFileSync(skillSrc, 'utf8');

  const terminalSkillSrc = terminalSkillResourcePath();
  if (!existsSync(terminalSkillSrc)) {
    console.error(`[agent-wsl] bundled skill missing at ${terminalSkillSrc}`);
    return;
  }
  const terminalSkill = readFileSync(terminalSkillSrc, 'utf8');

  const sqlSkillSrc = sqlSkillResourcePath();
  if (!existsSync(sqlSkillSrc)) {
    console.error(`[agent-wsl] bundled skill missing at ${sqlSkillSrc}`);
    return;
  }
  const sqlSkill = readFileSync(sqlSkillSrc, 'utf8');

  let distros: string[];
  try {
    distros = await detectWslDistros();
  } catch {
    return; // no WSL / detection failed
  }
  if (distros.length === 0) return;

  await Promise.all(distros.map((d) => installInto(d, wslHookPath, skill, terminalSkill, sqlSkill, terminalControl, sqlControl).catch((err) => {
    console.error(`[agent-wsl] ${d}: ${(err as Error).message}`);
  })));
}
