import React, { useState, useEffect } from 'react';
import type { AppSettings, AuthSession, FastChatSettings, FastChatReasoningEffort, QuickChatHotkey, SavedConnection, SSHConnectionConfig, ShellOption, TerminalRendererKind } from '../../shared/types';
import { SOUNDS, SILENT_SOUND_ID, playSound } from '../sounds';
import { SSHConnectionManager } from './SSHConnectionManager';
import { Card, Row, Hint, Toggle, Segmented, PInput, PSelect, PTextarea, HotkeyRecorder, ghostBtnStyle } from './settings-ui';
import { defaultQuickChatHotkey, defaultFocusModeHotkey } from '../../shared/quick-chat-hotkey';

interface SettingsModalProps {
  onClose: () => void;
  /** Tab to open on; defaults to 'general'. */
  initialTab?: Tab;
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  // SSH connections (managed only here)
  savedConnections: SavedConnection[];
  onSaveConnection: (config: Omit<SSHConnectionConfig, 'id'>) => Promise<SavedConnection>;
  onUpdateConnection: (id: string, config: Omit<SSHConnectionConfig, 'id'>) => Promise<SavedConnection>;
  onDeleteConnection: (id: string) => Promise<void>;
  onTestConnection: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

type Tab = 'general' | 'ssh' | 'fastChat' | 'account';

const RELAY_URL = 'https://stream.splitgrid.dev';

// Account tab: sign in/out of the web-streaming relay (WorkOS). Self-contained —
// auth is an immediate action, not part of the draft/Save flow. Tokens live in
// main; this only ever sees the user profile.
const AccountSettings: React.FC = () => {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    window.electronAPI.authGetSession()
      .then((s) => { if (alive) { setSession(s); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    const off = window.electronAPI.onAuthChanged((s) => { setSession(s); setBusy(false); });
    // Sign-in completes in the system browser; onAuthChanged fires on success,
    // but a cancelled login never does — clear the waiting state when the user
    // returns to the app so the button re-enables.
    const onFocus = () => setBusy(false);
    window.addEventListener('focus', onFocus);
    return () => { alive = false; off(); window.removeEventListener('focus', onFocus); };
  }, []);

  const signIn = () => { setBusy(true); window.electronAPI.authLogin().catch(() => setBusy(false)); };
  const signOut = () => { window.electronAPI.authLogout().catch(() => {}); };

  const u = session?.user;
  const fullName = u ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() : '';
  const initial = (fullName || u?.email || '?').charAt(0).toUpperCase();

  return (
    <div style={{ padding: 20 }}>
      <Card title="Web streaming" desc={
        <>Sign in to stream this app's terminals to the web at <code>{RELAY_URL.replace('https://', '')}</code>.
        Output is sent only while you choose to share it; viewing is read-only and scoped to your account.
        Sign-in opens your browser.</>
      }>
        {loading ? (
          <Hint>Checking sign-in status…</Hint>
        ) : u ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {u.profilePictureUrl ? (
                <img
                  src={u.profilePictureUrl} alt="" referrerPolicy="no-referrer"
                  style={{ width: 40, height: 40, borderRadius: '50%', flexShrink: 0, objectFit: 'cover' }}
                />
              ) : (
                <div style={{
                  width: 40, height: 40, borderRadius: '50%', flexShrink: 0, display: 'flex',
                  alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700,
                  background: 'color-mix(in srgb, var(--accent) 18%, transparent)', color: 'var(--accent)',
                }}>{initial}</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                {fullName && (
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fullName}
                  </div>
                )}
                <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.email}
                </div>
              </div>
              <button
                onClick={signOut}
                style={{
                  padding: '8px 14px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-primary)',
                  color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                }}
              >
                Sign out
              </button>
            </div>
            <div style={{ marginTop: 14 }}>
              <button
                onClick={() => window.electronAPI.openExternal(RELAY_URL)}
                style={ghostBtnStyle}
              >
                Open web viewer ↗
              </button>
            </div>
          </>
        ) : (
          <button
            onClick={signIn}
            disabled={busy}
            style={{
              padding: '10px 18px', borderRadius: 9, border: 'none', fontSize: 13, fontWeight: 700,
              cursor: busy ? 'default' : 'pointer',
              background: busy ? 'var(--bg-hover)' : 'var(--accent)',
              color: busy ? 'var(--text-muted)' : 'var(--bg-primary)',
            }}
          >
            {busy ? 'Waiting for browser…' : 'Sign in with Google'}
          </button>
        )}
      </Card>
    </div>
  );
};

// Pre-filled Fast chat suggestions for an unconfigured setup — Gemini's
// OpenAI-compatible endpoint. Shown in the form; only persisted once the user
// edits something (e.g. enters the API key) and clicks Save.
const FAST_CHAT_DEFAULTS: FastChatSettings = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiKey: '',
  model: 'gemini-3.1-flash-lite',
  models: ['gemini-3.1-flash-lite'],
  temperature: 0.7,
};

// The list of models to display/edit: explicit `models` when present, else the
// lone default. Mirrors the store, which folds `model` into the list on load.
function fcModelList(fc: FastChatSettings): string[] {
  if (fc.models && fc.models.length) return fc.models;
  return fc.model ? [fc.model] : [];
}

const hotkeyEq = (a: QuickChatHotkey, b: QuickChatHotkey) =>
  a.key === b.key && !!a.meta === !!b.meta && !!a.control === !!b.control && !!a.alt === !!b.alt && !!a.shift === !!b.shift;

// Canonical (comparable) forms mirroring the store's normalization, so the dirty
// check matches values back to "saved" — e.g. untrimmed whitespace or an empty
// config that the store drops don't read as a change.
function fcCanon(fc?: FastChatSettings): string | null {
  if (!fc) return null;
  const baseUrl = fc.baseUrl.trim();
  const apiKey = fc.apiKey.trim();
  let model = fc.model.trim();
  const systemPrompt = fc.systemPrompt ?? '';
  // Mirror the store's model-list normalization so reverting an edit reads as
  // "not dirty" (trim, de-dup, fold the default in).
  const models = [...new Set((fc.models ?? []).map((m) => m.trim()).filter(Boolean))];
  if (!model && models.length) model = models[0];
  if (model && !models.includes(model)) models.unshift(model);
  if (!baseUrl && !apiKey && !model && !systemPrompt) return null;
  return JSON.stringify({
    baseUrl, apiKey, model, models,
    temperature: Math.min(2, Math.max(0, fc.temperature)),
    systemPrompt,
    reasoningEffort: fc.reasoningEffort ?? '',
  });
}
export const SettingsModal: React.FC<SettingsModalProps> = ({
  onClose,
  initialTab,
  settings,
  onUpdateSettings,
  savedConnections,
  onSaveConnection,
  onUpdateConnection,
  onDeleteConnection,
  onTestConnection,
}) => {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'general');

  // Everything in General + Fast chat edits a local draft; nothing persists until
  // the user clicks Save. `dirty` lights up the Save button; `saved` shows the
  // confirmation. (Per-workspace notify overrides live in Workspace Settings.)
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saved, setSaved] = useState(false);

  const set = (patch: Partial<AppSettings>) => { setDraft((d) => ({ ...d, ...patch })); setSaved(false); };

  const fc: FastChatSettings = draft.fastChat ?? FAST_CHAT_DEFAULTS;
  const setFc = (patch: Partial<FastChatSettings>) => set({ fastChat: { ...fc, ...patch } });

  // ── Fast chat models list (add / remove / pick default) ──
  const modelList = fcModelList(fc);
  const [newModel, setNewModel] = useState('');
  const addModel = () => {
    const name = newModel.trim();
    if (!name || modelList.includes(name)) { setNewModel(''); return; }
    const models = [...modelList, name];
    // First model added also becomes the default.
    setFc({ models, model: fc.model.trim() || name });
    setNewModel('');
  };
  const removeModel = (name: string) => {
    const models = modelList.filter((m) => m !== name);
    const model = fc.model === name ? (models[0] ?? '') : fc.model;
    setFc({ models, model });
  };
  const setDefaultModel = (name: string) => setFc({ model: name });

  const platform = window.electronAPI.platform;
  const defaultHotkey = defaultQuickChatHotkey(platform);
  const currentHotkey: QuickChatHotkey = draft.quickChatHotkey ?? defaultHotkey;
  const defaultFocusHotkey = defaultFocusModeHotkey(platform);
  const currentFocusHotkey: QuickChatHotkey = draft.focusModeHotkey ?? defaultFocusHotkey;

  // Structural dirty: Save lights up only when the draft truly differs from the
  // saved settings, and goes dark again if values are reverted.
  const appDirty =
    draft.defaultSoundId !== settings.defaultSoundId ||
    draft.defaultVolume !== settings.defaultVolume ||
    !!draft.muteAll !== !!settings.muteAll ||
    (draft.windowsDefaultShell ?? '') !== (settings.windowsDefaultShell ?? '') ||
    (draft.terminalRenderer ?? 'xterm') !== (settings.terminalRenderer ?? 'xterm') ||
    !!draft.agentIntegrations !== !!settings.agentIntegrations ||
    !!draft.agentTerminalControl !== !!settings.agentTerminalControl ||
    !!draft.agentSqlControl !== !!settings.agentSqlControl ||
    !!draft.agentSftpControl !== !!settings.agentSftpControl ||
    !!draft.agentSftpWrite !== !!settings.agentSftpWrite ||
    !!draft.agentSqlWrite !== !!settings.agentSqlWrite ||
    !!draft.terminalMouseScroll !== !!settings.terminalMouseScroll ||
    fcCanon(draft.fastChat) !== fcCanon(settings.fastChat) ||
    !hotkeyEq(currentHotkey, settings.quickChatHotkey ?? defaultHotkey) ||
    !hotkeyEq(currentFocusHotkey, settings.focusModeHotkey ?? defaultFocusHotkey) ||
    (draft.quickChatHistoryLimit ?? 20) !== (settings.quickChatHistoryLimit ?? 20) ||
    (draft.quickChatResumeGraceSec ?? 300) !== (settings.quickChatResumeGraceSec ?? 300);
  const dirty = appDirty;

  const save = () => {
    onUpdateSettings({
      ...draft,
      fastChat: draft.fastChat
        ? {
            ...draft.fastChat,
            baseUrl: draft.fastChat.baseUrl.trim(),
            apiKey: draft.fastChat.apiKey.trim(),
            model: draft.fastChat.model.trim(),
            models: [...new Set((draft.fastChat.models ?? []).map((m) => m.trim()).filter(Boolean))],
          }
        : undefined,
    });
    setSaved(true);
  };

  // Available shells for the Windows default-shell picker (empty elsewhere).
  const [shells, setShells] = useState<ShellOption[]>([]);
  useEffect(() => {
    window.electronAPI.listShells?.().then(setShells).catch(() => setShells([]));
  }, []);

  const tabButton = (key: Tab, label: string): React.ReactNode => {
    const active = tab === key;
    return (
      <button
        onClick={() => setTab(key)}
        style={{
          padding: '7px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 12, fontWeight: 600,
          border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 40%, var(--border))' : 'transparent'}`,
          background: active ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
          color: active ? 'var(--accent)' : 'var(--text-muted)',
          transition: 'all 0.12s',
        }}
      >
        {label}
      </button>
    );
  };

  const testBtn = (sound: string, vol: number): React.ReactNode => (
    <button
      onClick={() => playSound(sound === '' ? draft.defaultSoundId : sound, vol)}
      style={{
        padding: '8px 12px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-primary)',
        color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
      }}
    >
      ▶ Test
    </button>
  );

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.55)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '40px 20px',
      }}
    >
      <div style={{
        width: 720, maxWidth: '100%', height: '82vh', maxHeight: 660, background: 'var(--bg-surface)',
        border: '1px solid var(--border)', borderRadius: 16, display: 'flex', flexDirection: 'column',
        overflow: 'hidden', boxShadow: '0 24px 70px rgba(0, 0, 0, 0.55)',
      }}>
        {/* Header: glyph + title + tabs + close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)', fontSize: 17,
          }}>⚙</div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Settings</h2>
          <div style={{ display: 'flex', gap: 4, marginLeft: 10 }}>
            {tabButton('general', 'General')}
            {tabButton('ssh', 'SSH Connections')}
            {tabButton('fastChat', 'Fast chat')}
            {tabButton('account', 'Account')}
          </div>
          <button
            onClick={onClose}
            title="Close"
            style={{
              marginLeft: 'auto', width: 26, height: 26, borderRadius: 8, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 16, lineHeight: 1, color: 'var(--text-muted)',
              background: 'transparent', border: 'none', cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          overflow: tab === 'ssh' ? 'hidden' : 'auto',
          background: tab === 'ssh' ? 'var(--bg-surface)' : 'var(--bg-primary)',
        }}>
          {tab === 'fastChat' ? (
            <div style={{ padding: 20 }}>
              <Card title="Fast chat" desc={
                <>A quick-question palette (open with the hotkey below). Point it at any OpenAI-compatible
                chat-completions endpoint — OpenAI, OpenRouter, Groq, a local Ollama (<code>/v1</code>),
                LM Studio, etc. The API key stays on this machine.</>
              }>
                <Row label="Hotkey">
                  <HotkeyRecorder
                    value={currentHotkey}
                    defaultValue={defaultHotkey}
                    onChange={(h) => set({ quickChatHotkey: h })}
                    platform={platform}
                  />
                </Row>
              </Card>

              <Card title="Endpoint">
                <Row label="Base URL">
                  <PInput type="text" placeholder="https://api.openai.com/v1" value={fc.baseUrl} onValue={(v) => setFc({ baseUrl: v })} grow />
                </Row>
                <Row label="API key">
                  <PInput type="password" placeholder="sk-…  (leave empty for local servers)" value={fc.apiKey} onValue={(v) => setFc({ apiKey: v })} grow />
                </Row>
                <Row label="Models" align="flex-start">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {modelList.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                        {modelList.map((m) => {
                          const isDefault = m === fc.model;
                          return (
                            <div key={m} style={{
                              display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                              borderRadius: 9, border: `1px solid ${isDefault ? 'var(--accent)' : 'var(--border)'}`,
                              background: isDefault ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'var(--bg-primary)',
                            }}>
                              <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, cursor: 'pointer' }}>
                                <input
                                  type="radio" name="fc-default-model" checked={isDefault}
                                  onChange={() => setDefaultModel(m)}
                                  style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                                />
                                <span style={{
                                  fontSize: 12, color: 'var(--text-primary)', fontWeight: isDefault ? 600 : 400,
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                  {m}
                                </span>
                                {isDefault && (
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                                    default
                                  </span>
                                )}
                              </label>
                              <button
                                type="button" onClick={() => removeModel(m)} title="Remove"
                                style={{
                                  width: 22, height: 22, flexShrink: 0, borderRadius: 6, border: 'none', cursor: 'pointer',
                                  background: 'transparent', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1,
                                }}
                              >
                                ✕
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <PInput
                        type="text" placeholder="gpt-4o-mini" value={newModel}
                        onValue={setNewModel} grow
                      />
                      <button type="button" onClick={addModel} style={ghostBtnStyle}>Add</button>
                    </div>
                  </div>
                </Row>
                <Hint>Add the models you use; pick one as the default. You can switch models per chat from the palette.</Hint>
                <Row label="Temperature">
                  <input
                    type="range" min={0} max={2} step={0.1} value={fc.temperature}
                    onChange={(e) => setFc({ temperature: Number(e.target.value) })}
                    style={{ flex: 1, maxWidth: 220, accentColor: 'var(--accent)' }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 28, textAlign: 'right' }}>
                    {fc.temperature.toFixed(1)}
                  </span>
                </Row>
                <Row label="Reasoning effort">
                  <PSelect value={fc.reasoningEffort ?? ''} onValue={(v) => setFc({ reasoningEffort: (v || undefined) as FastChatReasoningEffort | undefined })}>
                    <option value="">Off (non-reasoning models)</option>
                    <option value="minimal">Minimal</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </PSelect>
                </Row>
                <Hint>Only for reasoning models (OpenAI o-series / gpt-5). Leave Off otherwise.</Hint>
                <Row label="System prompt" align="flex-start">
                  <PTextarea
                    rows={3} placeholder="Optional. e.g. Answer concisely. Prefer shell one-liners."
                    value={fc.systemPrompt ?? ''} onValue={(v) => setFc({ systemPrompt: v })} grow
                  />
                </Row>
              </Card>

              <Card title="History">
                <Row label="Save last N chats">
                  <PInput
                    type="number" min={0} max={200} step={1}
                    value={String(draft.quickChatHistoryLimit ?? 20)}
                    onValue={(v) => set({ quickChatHistoryLimit: Math.min(200, Math.max(0, Math.floor(Number(v) || 0))) })}
                    style={{ width: 90, flex: '0 0 90px' }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>0 disables history</span>
                </Row>
                <Row label="Resume window">
                  <PInput
                    type="number" min={0} max={86400} step={30}
                    value={String(draft.quickChatResumeGraceSec ?? 300)}
                    onValue={(v) => set({ quickChatResumeGraceSec: Math.min(86400, Math.max(0, Math.floor(Number(v) || 0))) })}
                    style={{ width: 90, flex: '0 0 90px' }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>seconds a closed chat can be reopened (0 = discard at once)</span>
                </Row>
              </Card>
            </div>
          ) : tab === 'general' ? (
            <div style={{ padding: 20 }}>
              <Card title="Notifications" desc="Play a sound when a terminal finishes (Done) in a background workspace or while the window is unfocused.">
                <Toggle
                  label="Mute all notifications"
                  checked={!!draft.muteAll}
                  onChange={(v) => set({ muteAll: v })}
                />
                <div style={{ opacity: draft.muteAll ? 0.5 : 1, marginTop: 14 }}>
                  <Row label="Default sound">
                    <PSelect value={draft.defaultSoundId} onValue={(v) => set({ defaultSoundId: v })}>
                      {SOUNDS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                      <option value={SILENT_SOUND_ID}>Silent</option>
                    </PSelect>
                    {testBtn(draft.defaultSoundId, draft.defaultVolume)}
                  </Row>
                  <Row label="Default volume">
                    <input
                      type="range" min={0} max={1} step={0.05} value={draft.defaultVolume}
                      onChange={(e) => set({ defaultVolume: Number(e.target.value) })}
                      style={{ flex: 1, maxWidth: 220, accentColor: 'var(--accent)' }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 38, textAlign: 'right' }}>
                      {Math.round(draft.defaultVolume * 100)}%
                    </span>
                  </Row>
                </div>
              </Card>

              <Card title="Terminal">
                <Row label="Renderer">
                  <Segmented
                    value={draft.terminalRenderer ?? 'xterm'}
                    onChange={(v) => set({ terminalRenderer: v as TerminalRendererKind })}
                    options={[{ value: 'xterm', label: 'xterm.js' }, { value: 'ghostty', label: 'Ghostty (WASM)' }]}
                  />
                </Row>
                <Hint>
                  Rendering engine for terminals. Ghostty is GPU-accelerated; xterm.js is the
                  classic engine. Changing it reloads open terminals.
                </Hint>
                {shells.length > 0 && (
                  <>
                    <Row label="Default shell">
                      <PSelect value={draft.windowsDefaultShell ?? shells[0]?.path ?? ''} onValue={(v) => set({ windowsDefaultShell: v })}>
                        {shells.map((s) => <option key={s.id} value={s.path}>{s.label}</option>)}
                      </PSelect>
                    </Row>
                    <Hint>Applies to new terminals. Existing ones keep their shell.</Hint>
                  </>
                )}
                <div style={{ marginTop: 14 }}>
                  <Toggle
                    label="Mouse wheel scroll in tmux / screen"
                    checked={!!draft.terminalMouseScroll}
                    onChange={(v) => set({ terminalMouseScroll: v })}
                    desc="Enables mouse mode in your local ~/.tmux.conf and ~/.screenrc so the wheel scrolls their scrollback. Trade-off: text selection then goes through tmux/screen — hold Shift to select natively. Only affects this machine (not remote tmux over SSH); reopen tmux or run “tmux source-file ~/.tmux.conf” to apply to running sessions."
                  />
                </div>
              </Card>

              <Card title="Shortcuts">
                <Row label="Focus mode">
                  <HotkeyRecorder
                    value={currentFocusHotkey}
                    defaultValue={defaultFocusHotkey}
                    onChange={(h) => set({ focusModeHotkey: h })}
                    platform={platform}
                  />
                </Row>
                <Hint>Toggle a single container to full-screen focus (and back). Works over terminals, editors and browser panes.</Hint>
              </Card>

              <Card title="Agent integrations">
                <Toggle
                  label="Enable agent integrations"
                  checked={!!draft.agentIntegrations}
                  onChange={(v) => set({ agentIntegrations: v })}
                  desc={
                    <>When on, splitgrid installs the <code>sg-browser</code> skill and Claude/Codex
                    lifecycle hooks into your global <code>~/.claude</code> &amp; <code>~/.codex</code> (and
                    inside WSL distros), and injects <code>SPLITGRID_*</code> env into new terminals so agents
                    can report activity and drive the browser pane. Off by default — nothing is installed or
                    injected until you turn this on. Turning it off uninstalls the host hooks &amp; skill;
                    env changes apply to newly opened terminals.</>
                  }
                />
                <div style={{ marginLeft: 22, marginTop: 14 }}>
                  <Toggle
                    label="Terminal control"
                    checked={!!draft.agentIntegrations && !!draft.agentTerminalControl}
                    disabled={!draft.agentIntegrations}
                    onChange={(v) => set({ agentTerminalControl: v })}
                    desc={
                      <>Also install the <code>sg-terminal</code> skill and inject <code>SPLITGRID_TERMINAL_*</code>
                      env, letting an agent list, read and drive the <em>other</em> terminals in its workspace
                      (run commands, send keys, Ctrl-C). Scoped to the agent's own workspace. Writing into a
                      sibling shell runs arbitrary commands, so it's a separate opt-in — off by default.</>
                    }
                  />
                </div>
                <div style={{ marginLeft: 22, marginTop: 14 }}>
                  <Toggle
                    label="Allow agents to query SQL (read-only)"
                    checked={!!draft.agentIntegrations && !!draft.agentSqlControl}
                    disabled={!draft.agentIntegrations}
                    onChange={(v) => set({ agentSqlControl: v, ...(v ? {} : { agentSqlWrite: false }) })}
                    desc={
                      <>Inject <code>SPLITGRID_SQL_*</code> env, letting an agent run read-only queries,
                      inspect schema and export results against the SQL component in its workspace.
                      Off by default.</>
                    }
                  />
                  <div style={{ marginLeft: 22, marginTop: 14 }}>
                    <Toggle
                      label="Allow agents to modify data / run DDL (write)"
                      checked={!!draft.agentIntegrations && !!draft.agentSqlControl && !!draft.agentSqlWrite}
                      disabled={!draft.agentIntegrations || !draft.agentSqlControl}
                      onChange={(v) => set({ agentSqlWrite: v })}
                      desc={
                        <>Also permit writes, data modification and schema changes (INSERT/UPDATE/DELETE,
                        DDL). Off by default — leave off to keep agents read-only.</>
                      }
                    />
                  </div>
                </div>
                <div style={{ marginLeft: 22, marginTop: 14 }}>
                  <Toggle
                    label="Allow agents to transfer files over SFTP (read-only)"
                    checked={!!draft.agentIntegrations && !!draft.agentSftpControl}
                    disabled={!draft.agentIntegrations}
                    onChange={(v) => set({ agentSftpControl: v, ...(v ? {} : { agentSftpWrite: false }) })}
                    desc={
                      <>Install the <code>sg-sftp</code> skill and inject <code>SPLITGRID_SFTP_*</code> env,
                      letting an agent list and download files from its workspace's remote hosts — its sync
                      targets and the hosts of its SSH panes. Local paths stay inside the workspace directory.
                      Off by default.</>
                    }
                  />
                  <div style={{ marginLeft: 22, marginTop: 14 }}>
                    <Toggle
                      label="Allow agents to upload / change remote files (write)"
                      checked={!!draft.agentIntegrations && !!draft.agentSftpControl && !!draft.agentSftpWrite}
                      disabled={!draft.agentIntegrations || !draft.agentSftpControl}
                      onChange={(v) => set({ agentSftpWrite: v })}
                      desc={
                        <>Also permit uploads, workspace sync and remote mkdir/rename/delete. Without this an
                        agent can only look and download. Off by default.</>
                      }
                    />
                  </div>
                </div>
              </Card>
            </div>
          ) : tab === 'account' ? (
            <AccountSettings />
          ) : (
            <SSHConnectionManager
              embedded
              savedConnections={savedConnections}
              onSave={onSaveConnection}
              onUpdate={onUpdateConnection}
              onDelete={onDeleteConnection}
              onTest={onTestConnection}
              onClose={onClose}
            />
          )}
        </div>

        {/* Footer: single Save for draft-based tabs. SSH manages its own saves;
            Account acts immediately (login/logout), so neither shows it. */}
        {tab !== 'ssh' && tab !== 'account' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '1px solid var(--border)' }}>
            <button
              onClick={save}
              disabled={!dirty}
              style={{
                padding: '9px 20px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 700,
                cursor: dirty ? 'pointer' : 'default',
                background: dirty ? 'var(--accent)' : 'var(--bg-hover)',
                color: dirty ? 'var(--bg-primary)' : 'var(--text-muted)',
              }}
            >
              Save
            </button>
            {dirty
              ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Unsaved changes</span>
              : saved
                ? <span style={{ fontSize: 12, color: 'var(--accent-green)' }}>✓ Saved</span>
                : null}
          </div>
        )}
      </div>
    </div>
  );
};
