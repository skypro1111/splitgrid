import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppSettings, FastChatSettings } from '../shared/types';
import { normalizeQuickChatHotkey } from '../shared/quick-chat-hotkey';

const SETTINGS_FILE = 'app-settings.json';

// Kept in sync with the renderer defaults (src/renderer/sounds/index.ts). The
// store is intentionally tolerant: missing/invalid fields fall back to these.
const DEFAULTS: AppSettings = {
  defaultSoundId: 'notification-new-1',
  defaultVolume: 0.5,
  muteAll: false,
  terminalRenderer: 'xterm',
  // Off by default: splitgrid installs no global hooks/skills and injects no
  // SPLITGRID_* env until the user opts in via Settings.
  agentIntegrations: false,
  // Sub-opt-in under agentIntegrations: cross-terminal control. Off by default.
  agentTerminalControl: false,
  // Sub-opt-in under agentIntegrations: SQL control (read-only). Off by default.
  agentSqlControl: false,
  // Sub-sub-opt-in under agentSqlControl: allow write/DDL. Off by default.
  agentSqlWrite: false,
  // Sub-opt-in under agentIntegrations: SFTP access (read-only). Off by default.
  agentSftpControl: false,
  // Sub-sub-opt-in under agentSftpControl: allow uploads/changes. Off by default.
  agentSftpWrite: false,
  // Off by default: SplitGrid does not edit ~/.tmux.conf / ~/.screenrc until the
  // user opts in. Toggling it writes/removes a managed mouse-mode block.
  terminalMouseScroll: false,
};

function clamp01(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

// Number of recent chats to keep, clamped to [0, 200]. Undefined when unset so
// the renderer/store can apply its own default (20).
function normalizeHistoryLimit(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(200, Math.max(0, Math.floor(v)));
}

// Chat resume-grace window in seconds, clamped to [0, 86400]. Undefined when
// unset so the renderer applies its own default (300).
function normalizeResumeGraceSec(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(86400, Math.max(0, Math.floor(v)));
}

// Normalize a Fast chat config from untrusted JSON / renderer input. Returns
// undefined when nothing usable is present so callers can treat it as "unset".
function normalizeFastChat(v: unknown): FastChatSettings | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const baseUrl = str(o.baseUrl).trim();
  const apiKey = str(o.apiKey).trim();
  let model = str(o.model).trim();
  const systemPrompt = str(o.systemPrompt);
  // Available models: trimmed, de-duplicated, non-empty. The default `model` is
  // always folded in so it stays selectable; if it's unset, adopt the first.
  const rawModels = Array.isArray(o.models) ? o.models : [];
  const models = [...new Set(rawModels.map((m) => str(m).trim()).filter(Boolean))];
  if (!model && models.length) model = models[0];
  if (model && !models.includes(model)) models.unshift(model);
  const temperature =
    typeof o.temperature === 'number' && Number.isFinite(o.temperature)
      ? Math.min(2, Math.max(0, o.temperature))
      : 0.7;
  const reasoningEffort =
    o.reasoningEffort === 'minimal' || o.reasoningEffort === 'low' ||
    o.reasoningEffort === 'medium' || o.reasoningEffort === 'high'
      ? o.reasoningEffort
      : undefined;
  // Drop entirely if the user has not entered anything meaningful yet.
  if (!baseUrl && !apiKey && !model && !systemPrompt) return undefined;
  return { baseUrl, apiKey, model, models: models.length ? models : undefined, temperature, systemPrompt: systemPrompt || undefined, reasoningEffort };
}

export class AppSettingsStore {
  private filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), SETTINGS_FILE);
  }

  get(): AppSettings {
    try {
      if (!existsSync(this.filePath)) return { ...DEFAULTS };
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
      const o = parsed as Record<string, unknown>;
      return {
        defaultSoundId: typeof o.defaultSoundId === 'string' ? o.defaultSoundId : DEFAULTS.defaultSoundId,
        defaultVolume: clamp01(o.defaultVolume, DEFAULTS.defaultVolume),
        muteAll: typeof o.muteAll === 'boolean' ? o.muteAll : DEFAULTS.muteAll,
        windowsDefaultShell: typeof o.windowsDefaultShell === 'string' ? o.windowsDefaultShell : undefined,
        fastChat: normalizeFastChat(o.fastChat),
        quickChatHotkey: normalizeQuickChatHotkey(o.quickChatHotkey),
        focusModeHotkey: normalizeQuickChatHotkey(o.focusModeHotkey),
        quickChatHistoryLimit: normalizeHistoryLimit(o.quickChatHistoryLimit),
        quickChatResumeGraceSec: normalizeResumeGraceSec(o.quickChatResumeGraceSec),
        agentIntegrations: typeof o.agentIntegrations === 'boolean' ? o.agentIntegrations : DEFAULTS.agentIntegrations,
        agentTerminalControl: typeof o.agentTerminalControl === 'boolean' ? o.agentTerminalControl : DEFAULTS.agentTerminalControl,
        agentSqlControl: typeof o.agentSqlControl === 'boolean' ? o.agentSqlControl : DEFAULTS.agentSqlControl,
        agentSqlWrite: typeof o.agentSqlWrite === 'boolean' ? o.agentSqlWrite : DEFAULTS.agentSqlWrite,
        agentSftpControl: typeof o.agentSftpControl === 'boolean' ? o.agentSftpControl : DEFAULTS.agentSftpControl,
        agentSftpWrite: typeof o.agentSftpWrite === 'boolean' ? o.agentSftpWrite : DEFAULTS.agentSftpWrite,
        terminalMouseScroll: typeof o.terminalMouseScroll === 'boolean' ? o.terminalMouseScroll : DEFAULTS.terminalMouseScroll,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  save(settings: AppSettings): void {
    const next: AppSettings = {
      defaultSoundId: typeof settings.defaultSoundId === 'string' ? settings.defaultSoundId : DEFAULTS.defaultSoundId,
      defaultVolume: clamp01(settings.defaultVolume, DEFAULTS.defaultVolume),
      muteAll: !!settings.muteAll,
      windowsDefaultShell: typeof settings.windowsDefaultShell === 'string' && settings.windowsDefaultShell
        ? settings.windowsDefaultShell
        : undefined,
      fastChat: normalizeFastChat(settings.fastChat),
      quickChatHotkey: normalizeQuickChatHotkey(settings.quickChatHotkey),
      focusModeHotkey: normalizeQuickChatHotkey(settings.focusModeHotkey),
      quickChatHistoryLimit: normalizeHistoryLimit(settings.quickChatHistoryLimit),
      quickChatResumeGraceSec: normalizeResumeGraceSec(settings.quickChatResumeGraceSec),
      agentIntegrations: !!settings.agentIntegrations,
      agentTerminalControl: !!settings.agentTerminalControl,
      agentSqlControl: !!settings.agentSqlControl,
      agentSqlWrite: !!settings.agentSqlWrite,
      agentSftpControl: !!settings.agentSftpControl,
      agentSftpWrite: !!settings.agentSftpWrite,
      terminalMouseScroll: !!settings.terminalMouseScroll,
    };
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), 'utf-8');
  }
}
