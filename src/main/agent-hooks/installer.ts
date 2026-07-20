import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { hookHelperPath } from './paths';
import { AGENT_HOOK_DEFS, type AgentHookDef } from './registry';

// Recognises splitgrid's own hook entries so install is idempotent and uninstall
// is surgical — by the helper filename in the command, robust to path changes.
const HELPER_MARKER = 'splitgrid-hook';

interface NestedHookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

function configFilePath(def: AgentHookDef): string {
  const overrideDir = def.configDirEnv ? process.env[def.configDirEnv] : undefined;
  const dir = overrideDir && overrideDir.trim()
    ? overrideDir
    : path.join(homedir(), def.configDir);
  return path.join(dir, def.configFile);
}

/** Shell command the hook runs: the (quoted) helper path + event. */
function hookCommand(event: string, helperPath: string): string {
  return `"${helperPath}" ${event}`;
}

function isSplitGridOwned(entry: unknown): boolean {
  const e = entry as NestedHookEntry;
  return Array.isArray(e?.hooks) && e.hooks.some((h) => h?.command?.includes(HELPER_MARKER));
}

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  // Throw on malformed JSON rather than clobbering a file we can't safely merge.
  return JSON.parse(readFileSync(file, 'utf8') || '{}');
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// The hooks object lives at def.hooksKeyPath inside the config JSON.
function getHooksObj(root: Record<string, any>, keyPath: string[]): Record<string, any> {
  let node = root;
  for (const k of keyPath) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k];
  }
  return node;
}

/**
 * Merge splitgrid's hooks into a parsed config object in place (idempotent: drops
 * any prior splitgrid entry, keeps the user's). `helperPath` is the command the hook
 * runs — the host helper path for a local install, or a WSL-translated /mnt/… path
 * for an in-distro install. Returns the same root for convenience.
 */
export function applyHooksToConfig(root: Record<string, any>, def: AgentHookDef, helperPath: string): Record<string, any> {
  const hooks = getHooksObj(root, def.hooksKeyPath);
  for (const ev of def.events) {
    const list: NestedHookEntry[] = Array.isArray(hooks[ev.agentEvent]) ? hooks[ev.agentEvent] : [];
    const kept = list.filter((e) => !isSplitGridOwned(e));
    const entry: NestedHookEntry = {
      ...(ev.matcher ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: hookCommand(ev.splitgridEvent, helperPath), timeout: def.timeoutMs }],
    };
    kept.push(entry);
    hooks[ev.agentEvent] = kept;
  }
  return root;
}

/** Install (or refresh) splitgrid's lifecycle hooks into the agent's global config. */
export function installAgentHooks(def: AgentHookDef): void {
  const file = configFilePath(def);
  const root = applyHooksToConfig(readJson(file), def, hookHelperPath());
  writeJson(file, root);
}

/** Remove splitgrid's hooks from the agent's config, preserving everything else. */
export function uninstallAgentHooks(def: AgentHookDef): void {
  const file = configFilePath(def);
  if (!existsSync(file)) return;
  const root = readJson(file);
  const hooks = getHooksObj(root, def.hooksKeyPath);

  for (const ev of def.events) {
    if (!Array.isArray(hooks[ev.agentEvent])) continue;
    const kept = (hooks[ev.agentEvent] as NestedHookEntry[]).filter((e) => !isSplitGridOwned(e));
    if (kept.length) hooks[ev.agentEvent] = kept;
    else delete hooks[ev.agentEvent];
  }
  // Drop an empty hooks object so we don't leave `"hooks": {}` litter.
  const leafKey = def.hooksKeyPath[def.hooksKeyPath.length - 1];
  let parent: Record<string, any> = root;
  for (let i = 0; i < def.hooksKeyPath.length - 1; i++) parent = parent[def.hooksKeyPath[i]];
  if (parent[leafKey] && Object.keys(parent[leafKey]).length === 0) delete parent[leafKey];

  writeJson(file, root);
}

export interface AgentHookStatus {
  id: string;
  label: string;
  configPath: string;
  exists: boolean;     // config file present
  installed: boolean;  // all our events have a splitgrid-owned entry
}

export function agentHookStatus(def: AgentHookDef): AgentHookStatus {
  const file = configFilePath(def);
  let installed = false;
  try {
    if (existsSync(file)) {
      const hooks = getHooksObj(readJson(file), def.hooksKeyPath);
      installed = def.events.every((ev) =>
        Array.isArray(hooks[ev.agentEvent]) && (hooks[ev.agentEvent] as unknown[]).some(isSplitGridOwned),
      );
    }
  } catch { /* malformed config -> treat as not installed */ }
  return { id: def.id, label: def.label, configPath: file, exists: existsSync(file), installed };
}

/**
 * Install hooks for every agent whose config dir already exists. Called on
 * startup; idempotent, so it also refreshes the (possibly stale) helper path
 * after an app move/update. Agents not present are skipped silently.
 */
export function syncInstalledAgentHooks(): void {
  for (const def of AGENT_HOOK_DEFS) {
    const overrideDir = def.configDirEnv ? process.env[def.configDirEnv] : undefined;
    const dir = overrideDir && overrideDir.trim() ? overrideDir : path.join(homedir(), def.configDir);
    if (!existsSync(dir)) continue; // agent not installed on this machine
    try {
      installAgentHooks(def);
      console.log(`[agent-hooks] installed hooks for ${def.id} -> ${configFilePath(def)}`);
    } catch (err) {
      console.error(`[agent-hooks] failed to install ${def.id}:`, (err as Error).message);
    }
  }
}

// Helper marker this app used in hook commands under its previous product name.
const LEGACY_HELPER_MARKER = 'swapit-hook';

/**
 * One-time rename migration: strip hook entries the previous (pre-rename) app
 * installed — recognised by the old `swapit-hook` helper marker — from every
 * agent config, so a renamed install doesn't leave dead hooks pointing at the
 * gone binary. Preserves the user's own hooks and the renamed app's entries.
 */
export function removeRenamedLegacyAgentHooks(): void {
  const isLegacyOwned = (entry: unknown): boolean => {
    const e = entry as NestedHookEntry;
    return Array.isArray(e?.hooks) && e.hooks.some((h) => h?.command?.includes(LEGACY_HELPER_MARKER));
  };
  for (const def of AGENT_HOOK_DEFS) {
    const file = configFilePath(def);
    if (!existsSync(file)) continue;
    let root: Record<string, any>;
    try {
      root = readJson(file);
    } catch {
      continue; // malformed config — leave it alone
    }
    const hooks = getHooksObj(root, def.hooksKeyPath);
    let changed = false;
    for (const ev of def.events) {
      if (!Array.isArray(hooks[ev.agentEvent])) continue;
      const list = hooks[ev.agentEvent] as NestedHookEntry[];
      const kept = list.filter((e) => !isLegacyOwned(e));
      if (kept.length === list.length) continue;
      changed = true;
      if (kept.length) hooks[ev.agentEvent] = kept;
      else delete hooks[ev.agentEvent];
    }
    if (!changed) continue;
    const leafKey = def.hooksKeyPath[def.hooksKeyPath.length - 1];
    let parent: Record<string, any> = root;
    for (let i = 0; i < def.hooksKeyPath.length - 1; i++) parent = parent[def.hooksKeyPath[i]];
    if (parent[leafKey] && Object.keys(parent[leafKey]).length === 0) delete parent[leafKey];
    writeJson(file, root);
    console.log(`[agent-hooks] removed legacy (renamed-app) hooks from ${file}`);
  }
}
