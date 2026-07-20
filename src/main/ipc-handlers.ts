import { ipcMain, BrowserWindow, dialog, shell, clipboard } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { readdir, readFile, writeFile, stat, lstat, rename, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import ignore from 'ignore';
import chokidar from 'chokidar';
import { TerminalManager } from './terminal-manager';
import { detectShells } from './local-shell-manager';
import { ConnectionStore } from './connection-store';
import { WorkspaceStore } from './workspace-store';
import { SFTPSyncManager } from './sftp-sync-manager';
import { SQLManager } from './sql-manager';
import { SQLConnectionStore } from './sql-connection-store';
import { extensionFor } from './sql/export';
import { AppSettingsStore } from './app-settings-store';
import { applyAgentIntegrations } from './agent-integrations';
import { applyTerminalMouseConfig } from './terminal-mouse-config';
import { setTerminalOwnerResolver } from './agent-terminal-bridge';
import { setBrowserOwnerResolver } from './agent-browser-bridge';
import { setSqlOwnerResolver } from './agent-sql-bridge';
import { knownHostsStore } from './known-hosts-store';
import { QuickChatManager } from './quick-chat';
import { QuickChatHistoryStore } from './quick-chat-history-store';
import { setQuickChatHotkey, setFocusModeHotkey, setCapturingQuickChatHotkey } from './quick-chat-hotkey-state';
import { relayFeed, relayResize, relayDropSession, relaySetShare, relaySetInputHandler, relaySetBufferProvider } from './relay-producer';
import type { RelayShareMeta } from '../shared/types';
import { scanOscNotify, clearOscNotify } from './osc-notify';
import type {
  SSHConnectionConfig,
  LocalShellConfig,
  WorkspaceState,
  Workspace,
  WorkspaceSyncConfig,
  EnvironmentSummary,
  SQLConnectionConfig,
  SavedSQLConnection,
  SQLSchemaObjectKind,
  SQLEditChange,
  SQLExportOptions,
  SQLImportRequest,
  AppSettings,
  FastChatMessage,
  SftpTarget,
  SftpTransferProgress,
  RemoteDirEntry,
} from '../shared/types';
import { joinRemote } from '../shared/sftp-format';

interface WriteWithSyncOptions {
  workspaceId: string;
  localRootPath: string;
  sync: WorkspaceSyncConfig | null;
  // Optional client-generated id for a cancellable bulk sync (push/pull/run-now).
  // The renderer keeps it so it can call sftp:cancel-sync mid-flight; the handler
  // registers an AbortController under it for the duration of the run.
  syncId?: string;
}

// In-flight cancellable syncs, keyed by the renderer-supplied syncId. A bulk
// push/pull/run-now registers its AbortController here for its lifetime so a
// later sftp:cancel-sync can stop it; the handler deletes it in a finally.
const activeSyncs = new Map<string, AbortController>();

const sftpSyncManager = new SFTPSyncManager();
const sqlManager = new SQLManager();
const sqlConnectionStore = new SQLConnectionStore();
const appSettingsStore = new AppSettingsStore();
const quickChatManager = new QuickChatManager();
const quickChatHistoryStore = new QuickChatHistoryStore();
// Seed the in-memory hotkey cache from persisted settings at module load so
// before-input-event matching is correct from the first keystroke.
setQuickChatHotkey(appSettingsStore.get().quickChatHotkey);
setFocusModeHotkey(appSettingsStore.get().focusModeHotkey);

export interface IPCHandlersAPI {
  closeSessionsForWindow(webContentsId: number): void;
  // End every cached SFTP client (each holds a keepalive). Call on app quit so
  // connections don't linger; closeSessionsForWindow already does this when the
  // last window goes away.
  closeAllSftpSessions(): void;
}

export function registerIPCHandlers(
  terminalManager: TerminalManager,
  connectionStore: ConnectionStore,
  workspaceStore: WorkspaceStore,
  deps: {
    getWindowByWebContentsId: (id: number) => BrowserWindow | null;
    getWorkspaceSetIdByWebContentsId: (id: number) => string;
    openWorkspaceWindow: (setId?: string) => { setId: string };
    listEnvironments: () => EnvironmentSummary[];
    listOpenEnvironmentIds: () => string[];
    isEnvironmentOpen: (environmentId: string) => boolean;
    addRecentEnvironmentPath: (filePath: string) => void;
    toEnvironmentRefFromPath: (filePath: string) => string;
    onRecentEnvironmentsChanged: () => void;
    setEnvironmentName: (envId: string, name: string) => void;
    deleteEnvironment: (envId: string) => void;
  }
) {
  const getWinForEvent = (event: Electron.IpcMainInvokeEvent) =>
    deps.getWindowByWebContentsId(event.sender.id);
  const broadcast = (channel: string, ...args: unknown[]) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, ...args);
    }
  };

  // --- Session-to-window tracking (for cleanup on window close) ---
  const sessionOwner = new Map<string, number>(); // sessionId → webContentsId
  // Latest known PTY geometry per session (from terminal:resize). Used to correct
  // the cols/rows a terminal is shared with — the renderer-supplied size on share
  // can be a default/stale, which garbles a TUI mirror on the web viewer.
  const lastTermSize = new Map<string, { cols: number; rows: number }>();

  // Let the agent terminal bridge route a /terminal command to the window that
  // OWNS the calling terminal (not just the focused one), so cross-window setups
  // resolve the caller's workspace correctly. Reuses sessionOwner, which is
  // already kept current on terminal create/close and window close.
  setTerminalOwnerResolver((terminalId) => sessionOwner.get(terminalId));
  // Same routing for the agent browser bridge: a /browser command targets the
  // window that owns the calling terminal, not whichever window is focused.
  setBrowserOwnerResolver((terminalId) => sessionOwner.get(terminalId));
  // Same routing for the agent SQL bridge: a /sql command targets the window
  // that owns the calling terminal, not whichever window is focused.
  setSqlOwnerResolver((terminalId) => sessionOwner.get(terminalId));

  const sendToWebContents = (webContentsId: number, channel: string, ...args: unknown[]) => {
    const win = deps.getWindowByWebContentsId(webContentsId);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
    win.webContents.send(channel, ...args);
    return true;
  };

  const sendToSessionOwner = (sessionId: string, channel: string, ...args: unknown[]) => {
    const ownerId = sessionOwner.get(sessionId);
    if (ownerId !== undefined) {
      if (!sendToWebContents(ownerId, channel, ...args)) {
        sessionOwner.delete(sessionId);
      }
      return;
    }
    // Fallback preserves lifecycle events that can fire before ownership is set.
    broadcast(channel, ...args);
  };

  const buildIgnoreMatcher = async (localRoot: string, useGitIgnore: boolean) => {
    if (!useGitIgnore) return null;
    try {
      const rules = await readFile(path.join(localRoot, '.gitignore'), 'utf-8');
      return ignore().add(rules);
    } catch {
      return null;
    }
  };

  // A direct push (Cmd+S save, explorer create/move) writes the file to disk,
  // which the auto-sync watcher also observes. To avoid uploading the same file
  // twice, the direct push stamps the path here and the watcher skips paths
  // stamped within the suppression window.
  const recentDirectSync = new Map<string, number>();
  const DIRECT_SYNC_SUPPRESS_MS = 2500;
  const markDirectlySynced = (absoluteFilePath: string) => {
    recentDirectSync.set(path.resolve(absoluteFilePath), Date.now());
  };
  const wasRecentlySynced = (absoluteFilePath: string): boolean => {
    const key = path.resolve(absoluteFilePath);
    const at = recentDirectSync.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > DIRECT_SYNC_SUPPRESS_MS) {
      recentDirectSync.delete(key);
      return false;
    }
    return true;
  };
  const pruneRecentDirectSync = () => {
    const now = Date.now();
    for (const [key, at] of recentDirectSync) {
      if (now - at > DIRECT_SYNC_SUPPRESS_MS) recentDirectSync.delete(key);
    }
  };

  const syncRelativePathToTargets = async (
    absoluteFilePath: string,
    relativePosix: string,
    options: WriteWithSyncOptions
  ) => {
    const sync = options.sync;
    const targetResults: Array<{ targetId: string; ok: boolean; error?: string }> = [];
    if (!sync?.enabled || !sync.targets?.length || !options.localRootPath || !options.workspaceId) {
      return { synced: false, targetResults, skippedByGitIgnore: false };
    }

    const matcher = await buildIgnoreMatcher(path.resolve(options.localRootPath), sync.useGitIgnore);
    if (matcher?.ignores(relativePosix)) {
      return { synced: false, targetResults, skippedByGitIgnore: true };
    }

    const activeTargets = sync.targets.filter(
      (t) => t.enabled && t.connectionId && t.remotePath.trim().length > 0
    );
    for (const target of activeTargets) {
      const saved = connectionStore.getAll().find((c) => c.id === target.connectionId);
      if (!saved) {
        targetResults.push({ targetId: target.id, ok: false, error: 'Saved SSH connection not found.' });
        continue;
      }

      try {
        const cfg = connectionStore.toConnectionConfig(saved);
        const remoteRoot = target.remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
        const remoteFile = `${remoteRoot}/${relativePosix}`.replace(/\/{2,}/g, '/');
        await sftpSyncManager.syncFile(options.workspaceId, target.id, cfg, absoluteFilePath, remoteFile);
        targetResults.push({ targetId: target.id, ok: true });
      } catch (error) {
        targetResults.push({ targetId: target.id, ok: false, error: (error as Error).message });
      }
    }

    const synced = targetResults.some((r) => r.ok);
    // Suppress the watcher's echo of this same write (see recentDirectSync).
    if (synced) markDirectlySynced(absoluteFilePath);
    return {
      synced,
      targetResults,
      skippedByGitIgnore: false,
    };
  };

  // Mirror of syncRelativePathToTargets for removals: deletes a (now absent)
  // local path's remote counterpart on every active target. Used by the
  // auto-sync watcher when a file/dir is deleted on disk.
  const deleteRelativePathFromTargets = async (
    relativePosix: string,
    options: WriteWithSyncOptions
  ) => {
    const sync = options.sync;
    const targetResults: Array<{ targetId: string; ok: boolean; error?: string }> = [];
    if (!sync?.enabled || !sync.targets?.length || !options.localRootPath || !options.workspaceId) {
      return { removed: false, targetResults, skippedByGitIgnore: false };
    }

    const matcher = await buildIgnoreMatcher(path.resolve(options.localRootPath), sync.useGitIgnore);
    if (matcher?.ignores(relativePosix)) {
      return { removed: false, targetResults, skippedByGitIgnore: true };
    }

    const activeTargets = sync.targets.filter(
      (t) => t.enabled && t.connectionId && t.remotePath.trim().length > 0
    );
    for (const target of activeTargets) {
      const saved = connectionStore.getAll().find((c) => c.id === target.connectionId);
      if (!saved) {
        targetResults.push({ targetId: target.id, ok: false, error: 'Saved SSH connection not found.' });
        continue;
      }
      try {
        const cfg = connectionStore.toConnectionConfig(saved);
        const remoteRoot = target.remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
        const remoteFile = `${remoteRoot}/${relativePosix}`.replace(/\/{2,}/g, '/');
        // deleteRemotePath is recursive and no-ops if the path is already gone.
        await sftpSyncManager.deleteRemotePath(options.workspaceId, target.id, cfg, remoteFile);
        targetResults.push({ targetId: target.id, ok: true });
      } catch (error) {
        targetResults.push({ targetId: target.id, ok: false, error: (error as Error).message });
      }
    }

    return {
      removed: targetResults.some((r) => r.ok),
      targetResults,
      skippedByGitIgnore: false,
    };
  };

  // Creates a (possibly empty) directory's remote counterpart on every active
  // target. Non-empty dirs get created implicitly when files inside them are
  // pushed; this is what mirrors EMPTY dirs the watcher sees via addDir.
  const ensureRelativeDirOnTargets = async (
    relativePosix: string,
    options: WriteWithSyncOptions
  ) => {
    const sync = options.sync;
    const targetResults: Array<{ targetId: string; ok: boolean; error?: string }> = [];
    if (!sync?.enabled || !sync.targets?.length || !options.localRootPath || !options.workspaceId) {
      return { created: false, targetResults, skippedByGitIgnore: false };
    }

    const matcher = await buildIgnoreMatcher(path.resolve(options.localRootPath), sync.useGitIgnore);
    if (matcher?.ignores(relativePosix)) {
      return { created: false, targetResults, skippedByGitIgnore: true };
    }

    const activeTargets = sync.targets.filter(
      (t) => t.enabled && t.connectionId && t.remotePath.trim().length > 0
    );
    for (const target of activeTargets) {
      const saved = connectionStore.getAll().find((c) => c.id === target.connectionId);
      if (!saved) {
        targetResults.push({ targetId: target.id, ok: false, error: 'Saved SSH connection not found.' });
        continue;
      }
      try {
        const cfg = connectionStore.toConnectionConfig(saved);
        const remoteRoot = target.remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
        const remoteDir = `${remoteRoot}/${relativePosix}`.replace(/\/{2,}/g, '/');
        // ensureRemoteDir is mkdir -p style and no-ops if the dir already exists.
        await sftpSyncManager.ensureRemoteDir(options.workspaceId, target.id, cfg, remoteDir);
        targetResults.push({ targetId: target.id, ok: true });
      } catch (error) {
        targetResults.push({ targetId: target.id, ok: false, error: (error as Error).message });
      }
    }

    return {
      created: targetResults.some((r) => r.ok),
      targetResults,
      skippedByGitIgnore: false,
    };
  };

  // --- Claude Code response detection ---
  // Claude Code outputs specific patterns when it finishes a response:
  // - The prompt char "❯" or ">" after a response block
  // - Status line updates with specific escape sequences
  // - The "╰─" closing border of a response box
  // We track per-session state and emit an event when response completes.
  const claudeDetectorState = new Map<string, { buffer: string; responding: boolean }>();

  function detectClaudeResponse(sessionId: string, data: string) {
    let state = claudeDetectorState.get(sessionId);
    if (!state) {
      state = { buffer: '', responding: false };
      claudeDetectorState.set(sessionId, state);
    }

    // Append to rolling buffer (keep last 500 chars for pattern matching)
    state.buffer = (state.buffer + data).slice(-500);
    const buf = state.buffer;

    // Detect Claude Code is actively responding (thinking/writing indicator or response content)
    // Claude Code shows "╭─" at start of response blocks
    if (buf.includes('╭') || buf.includes('Thinking') || buf.includes('Writing')) {
      state.responding = true;
    }

    // Detect response completion: prompt reappears after a response
    // Claude Code prompt: "❯ " or the input prompt after response
    // Also detect "╰─" closing border followed by prompt
    if (state.responding) {
      // Strip ANSI escape sequences for cleaner matching
      const clean = buf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      // Claude Code shows ❯ prompt after completing
      if (clean.includes('❯') && (clean.lastIndexOf('❯') > clean.lastIndexOf('╭'))) {
        state.responding = false;
        state.buffer = '';
        sendToSessionOwner(sessionId, 'terminal:claude-response', sessionId);
      }
    }
  }

  // Persistent callbacks — survive renderer reload
  terminalManager.setCallbacks({
    onData: (sessionId, data) => {
      sendToSessionOwner(sessionId, 'terminal:on-data', sessionId, data);
      // Mirror output to the web relay (no-op unless this terminal is shared).
      relayFeed(sessionId, data);
      detectClaudeResponse(sessionId, data);
      // Agent-agnostic attention signal (any tool emitting a notify OSC).
      if (scanOscNotify(sessionId, data)) {
        broadcast('agent:notify', sessionId);
      }
    },
    onReady: (sessionId) => {
      sendToSessionOwner(sessionId, 'terminal:on-ready', sessionId);
    },
    onClose: (sessionId, info) => {
      sendToSessionOwner(sessionId, 'terminal:on-close', sessionId, !!info?.exitedCleanly);
      relayDropSession(sessionId);
      sessionOwner.delete(sessionId);
      lastTermSize.delete(sessionId);
      claudeDetectorState.delete(sessionId);
      clearOscNotify(sessionId);
    },
    onError: (sessionId, message) => {
      sendToSessionOwner(sessionId, 'terminal:on-error', sessionId, message);
    },
    onPasswordPrompt: (sessionId, label, source) => {
      // Carries NO password — just a signal for the renderer to offer it.
      sendToSessionOwner(sessionId, 'ssh:password-prompt', { sessionId, label, source });
    },
  });

  // Keystrokes from a web viewer (relay → producer) are written straight to the
  // PTY here, the same path as local input. relay-producer already gates this to
  // terminals the user is actively streaming.
  relaySetInputHandler((sessionId, data) => {
    terminalManager.sendData(sessionId, data);
    // Tell the renderer the user is actively driving this terminal FROM THE WEB.
    // The "done" notification is suppressed while a terminal is being viewed
    // (active workspace + focused window); web interaction is invisible to that
    // check, so without this a keystroke from the web (and the agent's reply to
    // it) would fire a desktop completion sound even though the user is present.
    broadcast('terminal:web-input', sessionId);
  });

  // Lets a newly-shared terminal arrive on the web with its current screen
  // already drawn, instead of staying blank until the next output byte.
  relaySetBufferProvider((sessionId) => terminalManager.getBuffer(sessionId));

  // User confirmed the offer — inject the saved password into the PTY (the
  // password is resolved + written entirely in main; never crosses to renderer).
  ipcMain.on('ssh:apply-password', (_event, sessionId: string) => {
    terminalManager.getSSHManager().applyStoredPassword(sessionId);
  });

  // --- SSH Sessions ---

  ipcMain.handle(
    'terminal:create-ssh',
    async (event, configWithoutId: Omit<SSHConnectionConfig, 'id'>) => {
      const config: SSHConnectionConfig = { ...configWithoutId, id: uuidv4() };
      sessionOwner.set(config.id, event.sender.id);
      try {
        return await terminalManager.createSSHSession(config);
      } catch (error) {
        sessionOwner.delete(config.id);
        throw error;
      }
    }
  );

  // --- Local Shell ---

  ipcMain.handle(
    'terminal:create-local',
    async (event, config?: LocalShellConfig) => {
      const sessionId = uuidv4();
      sessionOwner.set(sessionId, event.sender.id);
      // New terminals with no explicit shell inherit the user's default (Windows
      // shell picker in Settings); restored terminals already carry their shell.
      let resolved = config;
      if (!resolved?.shell) {
        const def = appSettingsStore.get().windowsDefaultShell;
        if (def) resolved = { ...(config ?? {}), shell: def };
      }
      try {
        return terminalManager.createLocalShell(resolved, sessionId);
      } catch (error) {
        sessionOwner.delete(sessionId);
        throw error;
      }
    }
  );

  // --- Window controls (frameless platforms: the renderer's WorkspaceBar draws
  // min/max/close and drives the sender's own window through these) ---

  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on('window:toggle-maximize', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  // Current fullscreen state, queried on renderer mount: a window can enter
  // fullscreen before its renderer subscribes to 'window:fullscreen-change'
  // (e.g. a new window spawned into an existing fullscreen space), missing the
  // event — so the renderer reconciles by asking.
  ipcMain.handle('window:is-fullscreen', (event) =>
    BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
  );

  // --- Common terminal ops ---

  ipcMain.handle('terminal:close', async (_event, sessionId: string) => {
    terminalManager.closeSession(sessionId);
  });

  ipcMain.on('terminal:send-data', (_event, sessionId: string, data: string) => {
    terminalManager.sendData(sessionId, data);
  });

  ipcMain.on(
    'terminal:resize',
    (_event, sessionId: string, cols: number, rows: number) => {
      terminalManager.resize(sessionId, cols, rows);
      lastTermSize.set(sessionId, { cols, rows });
      relayResize(sessionId, cols, rows);
    }
  );

  // Web streaming: enable/disable streaming a terminal to the relay. Correct the
  // cols/rows with the size main actually knows (the renderer's value on share can
  // be stale/default), so the web viewer mirrors the real PTY geometry.
  ipcMain.on(
    'relay:set-share',
    (_event, sessionId: string, enabled: boolean, meta?: RelayShareMeta) => {
      if (enabled && meta) {
        const size = lastTermSize.get(sessionId);
        if (size) {
          meta.cols = size.cols;
          meta.rows = size.rows;
        }
      }
      relaySetShare(sessionId, enabled, meta);
    }
  );

  // --- Session recovery ---

  ipcMain.handle('terminal:get-active', async () => {
    return terminalManager.getAllSessions();
  });

  ipcMain.handle('terminal:get-buffer', async (_event, sessionId: string) => {
    return terminalManager.getBuffer(sessionId);
  });

  ipcMain.handle('diagnostics:get-resource-snapshot', async () => {
    return terminalManager.getResourceSnapshot();
  });

  ipcMain.handle(
    'diagnostics:kill-process',
    async (_event, payload: { sessionId: string; pid: number; signal?: 'TERM' | 'KILL' }) => {
      return terminalManager.killProcess(payload.sessionId, payload.pid, payload.signal);
    },
  );

  ipcMain.handle('terminal:get-process-tree', async (_event, sessionId: string) => {
    return terminalManager.getProcessTree(sessionId);
  });

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    // Only allow web/file schemes — never arbitrary protocol handlers.
    if (typeof url === 'string' && /^(https?|file):\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('workspace:freeze', async (_event, sessionIds: string[]) => {
    const results: Array<{ id: string; supported: boolean; frozen: boolean }> = [];
    for (const id of sessionIds ?? []) {
      results.push({ id, ...(await terminalManager.pauseSession(id)) });
    }
    return results;
  });

  ipcMain.handle('workspace:unfreeze', async (_event, sessionIds: string[]) => {
    const results: Array<{ id: string; supported: boolean; frozen: boolean }> = [];
    for (const id of sessionIds ?? []) {
      results.push({ id, ...(await terminalManager.resumeSession(id)) });
    }
    return results;
  });

  // --- Saved connections ---

  ipcMain.handle('connections:list', async () => {
    return connectionStore.getAll();
  });

  ipcMain.handle(
    'connections:save',
    async (_event, config: Omit<SSHConnectionConfig, 'id'>) => {
      return connectionStore.add(config);
    }
  );

  ipcMain.handle(
    'connections:update',
    async (_event, id: string, config: Omit<SSHConnectionConfig, 'id'>) => {
      const updated = connectionStore.update(id, config);
      if (!updated) throw new Error('Connection not found');
      return updated;
    }
  );

  ipcMain.handle('connections:delete', async (_event, id: string) => {
    connectionStore.delete(id);
  });

  ipcMain.handle('connections:connect', async (event, savedId: string) => {
    const saved = connectionStore.getAll().find((c) => c.id === savedId);
    if (!saved) throw new Error('Saved connection not found');

    const decrypted = connectionStore.toConnectionConfig(saved);
    const config: SSHConnectionConfig = { ...decrypted, id: uuidv4() };
    sessionOwner.set(config.id, event.sender.id);
    try {
      return await terminalManager.createSSHSession(config);
    } catch (error) {
      sessionOwner.delete(config.id);
      throw error;
    }
  });

  // Forget a pinned host key so the next connect re-pins whatever the server
  // now presents (TOFU accept-new). Used by the renderer's "the key changed —
  // accept the new one?" recovery prompt after the user has eyeballed the
  // new fingerprint. A deliberate security decision, never automatic.
  ipcMain.handle('connections:forget-host-key', async (_event, host: string, port: number) => {
    knownHostsStore.forget(host, port);
  });

  ipcMain.handle('connections:test', async (_event, savedId: string) => {
    const saved = connectionStore.getAll().find((c) => c.id === savedId);
    if (!saved) return { ok: false, error: 'Saved connection not found' };
    try {
      await sftpSyncManager.testConnection(connectionStore.toConnectionConfig(saved));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  // Enable mouse-wheel scrolling for tmux/screen on the REMOTE host by writing
  // SplitGrid's managed block into that host's ~/.tmux.conf & ~/.screenrc. The
  // local Settings toggle only edits local config; this is the SSH counterpart.
  ipcMain.handle('connections:apply-mouse-scroll', async (_event, savedId: string) => {
    const saved = connectionStore.getAll().find((c) => c.id === savedId);
    if (!saved) return { ok: false, error: 'Saved connection not found' };
    try {
      await sftpSyncManager.applyMouseScrollConfig(connectionStore.toConnectionConfig(saved));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  // --- Workspace state persistence ---

  ipcMain.handle('workspace-state:load', async (event) => {
    const setId = deps.getWorkspaceSetIdByWebContentsId(event.sender.id);
    return workspaceStore.load(setId);
  });

  ipcMain.handle('workspace-state:save', async (event, state: WorkspaceState) => {
    const setId = deps.getWorkspaceSetIdByWebContentsId(event.sender.id);
    workspaceStore.save(state, setId);
  });

  ipcMain.handle('workspace-recent:list', async (event) => {
    const setId = deps.getWorkspaceSetIdByWebContentsId(event.sender.id);
    return workspaceStore.listRecentWorkspaces(setId);
  });

  ipcMain.handle('workspace-recent:add', async (event, workspace: Workspace) => {
    const setId = deps.getWorkspaceSetIdByWebContentsId(event.sender.id);
    try {
      workspaceStore.addRecentWorkspace(workspace, setId);
    } catch (err) {
      console.error('[recent] failed to record workspace:', (err as Error).message);
    }
  });

  ipcMain.handle('app-settings:get', async () => appSettingsStore.get());

  ipcMain.handle('app-settings:save', async (_event, settings: AppSettings) => {
    const prev = appSettingsStore.get();
    appSettingsStore.save(settings);
    const next = appSettingsStore.get();
    // Refresh the cached hotkey so the change takes effect immediately, without
    // an app restart. Re-read (not the raw arg) so it's the normalized value.
    setQuickChatHotkey(next.quickChatHotkey);
    setFocusModeHotkey(next.focusModeHotkey);
    // Install/uninstall the global agent artifacts when either the master opt-in
    // or the terminal-control sub-opt-in flips (the latter installs/removes just
    // the terminal skill + env while the master stays on).
    if (!!prev.agentIntegrations !== !!next.agentIntegrations ||
        !!prev.agentTerminalControl !== !!next.agentTerminalControl ||
        !!prev.agentSqlControl !== !!next.agentSqlControl ||
        !!prev.agentSqlWrite !== !!next.agentSqlWrite) {
      applyAgentIntegrations(
        !!next.agentIntegrations,
        !!next.agentTerminalControl,
        !!next.agentSqlControl,
        !!next.agentSqlWrite,
      );
    }
    // Write/remove the managed mouse-mode block in ~/.tmux.conf & ~/.screenrc when
    // the toggle flips, so the wheel scrolls tmux/screen on this machine.
    if (!!prev.terminalMouseScroll !== !!next.terminalMouseScroll) {
      applyTerminalMouseConfig(!!next.terminalMouseScroll);
    }
  });

  // Fast chat: start a streamed completion. The key/model/url live in the saved
  // app settings (never sent from the renderer). Returns a requestId the
  // renderer correlates chunk/done/error events against; counterpart cancel below.
  ipcMain.handle('quick-chat:ask', async (event, requestId: string, messages: FastChatMessage[], model?: string) => {
    const cfg = appSettingsStore.get().fastChat;
    if (!cfg || !cfg.baseUrl || !cfg.model) {
      return { ok: false, error: 'Fast chat is not configured. Open Settings → Fast chat.' };
    }
    // Honor the per-chat model selection only when it's one the user configured;
    // otherwise fall back to the default model (undefined → stream uses default).
    const allowed = cfg.models && cfg.models.length ? cfg.models : [cfg.model];
    const override = typeof model === 'string' && allowed.includes(model) ? model : undefined;
    // Fire-and-forget: output flows through event.sender events keyed by requestId.
    void quickChatManager.stream(event.sender, requestId, cfg, messages, override);
    return { ok: true };
  });

  ipcMain.on('quick-chat:cancel', (_event, requestId: string) => {
    quickChatManager.cancel(requestId);
  });

  ipcMain.on('quick-chat:set-capturing', (_event, capturing: boolean) => {
    setCapturingQuickChatHotkey(!!capturing);
  });

  ipcMain.handle('quick-chat-history:list', async () => quickChatHistoryStore.list());
  ipcMain.handle('quick-chat-history:save', async (_event, conversation: { id: string; messages: FastChatMessage[] }) => {
    quickChatHistoryStore.save(conversation, appSettingsStore.get().quickChatHistoryLimit);
  });
  ipcMain.handle('quick-chat-history:delete', async (_event, id: string) => {
    quickChatHistoryStore.delete(id);
  });
  ipcMain.handle('quick-chat-history:clear', async () => {
    quickChatHistoryStore.clear();
  });

  ipcMain.handle('shells:list', async () => detectShells());

  ipcMain.handle('workspace-set:get-context', async (event) => {
    const currentSetId = deps.getWorkspaceSetIdByWebContentsId(event.sender.id);
    return {
      currentSetId,
      setIds: workspaceStore.listSetIds(),
    };
  });

  ipcMain.handle('workspace-set:open-window', async (_event, setId?: string) => {
    return deps.openWorkspaceWindow(setId);
  });

  ipcMain.handle('environment:list', async () => {
    const base = deps.listEnvironments();
    const known = new Set(base.map((env) => env.id));
    const openOnly = deps
      .listOpenEnvironmentIds()
      .filter((id) => !known.has(id))
      .map((id) => ({
        id,
        name: id === 'default' ? 'Default Environment' : id,
        source: 'internal' as const,
      }));
    return [...base, ...openOnly].map((env) => ({
      ...env,
      isOpen: deps.isEnvironmentOpen(env.id),
    }));
  });

  ipcMain.handle('environment:pick-file', async (event) => {
    const win = getWinForEvent(event);
    const dialogOpts: Electron.OpenDialogOptions = {
      title: 'Open Environment',
      properties: ['openFile'],
      filters: [{ name: 'Environment', extensions: ['json', 'env'] }, { name: 'All Files', extensions: ['*'] }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (result.canceled) return null;
    const envPath = result.filePaths[0];
    if (!envPath) return null;
    deps.addRecentEnvironmentPath(envPath);
    deps.onRecentEnvironmentsChanged();
    return deps.toEnvironmentRefFromPath(envPath);
  });

  ipcMain.handle('environment:set-name', async (_event, environmentId: string, name: string) => {
    deps.setEnvironmentName(environmentId, name);
  });

  ipcMain.handle('environment:delete', async (_event, environmentId: string) => {
    if (deps.isEnvironmentOpen(environmentId)) {
      throw new Error('Cannot delete an environment that is currently open');
    }
    deps.deleteEnvironment(environmentId);
    deps.onRecentEnvironmentsChanged();
  });

  // --- SQL ---

  ipcMain.handle('sql:connect', async (_event, config: SQLConnectionConfig) => {
    return sqlManager.connect(config);
  });

  // Attempt a connection purely to validate the config, then immediately drop it.
  // Returns { ok, serverVersion? } or throws with the driver error.
  ipcMain.handle('sql:test-connection', async (_event, config: SQLConnectionConfig) => {
    const info = await sqlManager.connect(config);
    try {
      return { ok: true as const, serverVersion: info.serverVersion };
    } finally {
      await sqlManager.disconnect(info.id).catch(() => {});
    }
  });

  ipcMain.handle('sql:connect-saved', async (_event, savedId: string) => {
    const config = sqlConnectionStore.toConnectionConfig(savedId);
    return sqlManager.connect(config);
  });

  ipcMain.handle('sql:connect-saved-database', async (_event, savedId: string, database: string) => {
    const config = sqlConnectionStore.toConnectionConfig(savedId, database);
    return sqlManager.connect(config);
  });

  ipcMain.handle('sql:disconnect', async (_event, connectionId: string) => {
    await sqlManager.disconnect(connectionId);
  });

  ipcMain.handle('sql:execute', async (_event, connectionId: string, sql: string) => {
    try {
      return await sqlManager.execute(connectionId, sql);
    } catch (err) {
      // Enrich the error MESSAGE only (contract unchanged): surface the
      // postgres `position`/`detail`/`hint` fields that IPC would otherwise drop,
      // so the renderer can place an inline marker at the failing character.
      const e = err as { message?: string; position?: string | number; detail?: string; hint?: string };
      const base = e?.message ?? 'Query failed';
      const extras: string[] = [];
      if (e?.position != null && String(e.position).length) extras.push(`Position: ${e.position}`);
      if (e?.detail) extras.push(`Detail: ${e.detail}`);
      if (e?.hint) extras.push(`Hint: ${e.hint}`);
      throw new Error(extras.length ? `${base}\n${extras.join('\n')}` : base);
    }
  });

  ipcMain.handle('sql:list-schemas', async (_event, connectionId: string) => {
    return sqlManager.listSchemas(connectionId);
  });

  ipcMain.handle('sql:list-databases', async (_event, connectionId: string) => {
    return sqlManager.listDatabases(connectionId);
  });

  ipcMain.handle('sql:list-columns', async (_event, connectionId: string) => {
    return sqlManager.listColumns(connectionId);
  });

  ipcMain.handle(
    'sql:get-ddl',
    async (_event, connectionId: string, schema: string, name: string, kind: SQLSchemaObjectKind) => {
      return sqlManager.getDDL(connectionId, schema, name, kind);
    }
  );

  ipcMain.handle('sql:get-primary-key', async (_event, connectionId: string, schema: string, table: string) => {
    return sqlManager.getPrimaryKey(connectionId, schema, table);
  });

  ipcMain.handle('sql:list-indexes', async (_event, connectionId: string, schema: string, table: string) => {
    return sqlManager.listIndexes(connectionId, schema, table);
  });

  ipcMain.handle('sql:list-keys', async (_event, connectionId: string, schema: string, table: string) => {
    return sqlManager.listKeys(connectionId, schema, table);
  });

  ipcMain.handle('sql:list-triggers', async (_event, connectionId: string, schema: string, table?: string) => {
    return sqlManager.listTriggers(connectionId, schema, table);
  });

  ipcMain.handle(
    'sql:rename-object',
    async (_event, connectionId: string, kind: SQLSchemaObjectKind, schema: string, name: string, newName: string) => {
      await sqlManager.renameObject(connectionId, kind, schema, name, newName);
    }
  );

  ipcMain.handle(
    'sql:drop-object',
    async (_event, connectionId: string, kind: SQLSchemaObjectKind, schema: string, name: string, opts?: { cascade?: boolean }) => {
      await sqlManager.dropObject(connectionId, kind, schema, name, opts);
    }
  );

  ipcMain.handle('sql:apply-edits', async (_event, connectionId: string, changes: SQLEditChange[]) => {
    return sqlManager.applyEdits(connectionId, changes);
  });

  ipcMain.handle('sql:begin-tx', async (_event, connectionId: string) => {
    await sqlManager.beginTx(connectionId);
  });

  ipcMain.handle('sql:commit-tx', async (_event, connectionId: string) => {
    await sqlManager.commitTx(connectionId);
  });

  ipcMain.handle('sql:rollback-tx', async (_event, connectionId: string) => {
    await sqlManager.rollbackTx(connectionId);
  });

  // Export a result set / full table. When options.filePath is empty, show a Save
  // dialog with a sensible default filename + per-format extension filter.
  ipcMain.handle('sql:export', async (event, connectionId: string | null, options: SQLExportOptions) => {
    let target = options.filePath;
    if (!target) {
      const win = getWinForEvent(event);
      const ext = extensionFor(options.format);
      const base = options.table?.name || 'export';
      const dialogOpts: Electron.SaveDialogOptions = {
        title: 'Export data',
        defaultPath: `${base}.${ext}`,
        filters: [{ name: options.format.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
      };
      const result = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts);
      if (result.canceled || !result.filePath) return { ok: false, filePath: '', rowCount: 0 };
      target = result.filePath;
    }
    return sqlManager.exportData(connectionId, { ...options, filePath: target });
  });

  // Batched, transactional CSV → table import.
  ipcMain.handle('sql:import-rows', async (_event, connectionId: string, request: SQLImportRequest) => {
    return sqlManager.importRows(connectionId, request);
  });

  // Open-file dialog for picking a CSV to import.
  ipcMain.handle('sql:pick-import-file', async (event) => {
    const win = getWinForEvent(event);
    const dialogOpts: Electron.OpenDialogOptions = {
      title: 'Import CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }, { name: 'All Files', extensions: ['*'] }],
    };
    const result = win ? await dialog.showOpenDialog(win, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('sql-connections:list', async () => {
    return sqlConnectionStore.getAll();
  });

  ipcMain.handle(
    'sql-connections:save',
    async (
      _event,
      payload: Omit<SavedSQLConnection, 'id'> & {
        password: string;
      }
    ) => {
      return sqlConnectionStore.add(payload);
    }
  );

  ipcMain.handle(
    'sql-connections:update',
    async (
      _event,
      savedId: string,
      patch: Partial<Pick<SavedSQLConnection, 'label' | 'host' | 'port' | 'user' | 'database' | 'ssl' | 'filePath'>>
    ) => {
      return sqlConnectionStore.update(savedId, patch);
    }
  );

  ipcMain.handle('sql-connections:delete', async (_event, savedId: string) => {
    sqlConnectionStore.delete(savedId);
  });

  // --- File system ---

  const MAX_READ_FILE_BYTES = 50 * 1024 * 1024; // 50 MB hard limit for readFile

  ipcMain.handle('fs:read-directory', async (_event, dirPath: string) => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.name !== '.DS_Store')
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
      .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  });

  // Rich local listing for the SFTP file manager's local pane. Returns the
  // same shape as sftp:stat-dir (RemoteDirEntry) so both panes share the
  // renderer-side formatters; mtime is in SECONDS to match ssh2.
  ipcMain.handle('fs:stat-directory', async (_event, dirPath: string): Promise<RemoteDirEntry[]> => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const out: RemoteDirEntry[] = [];
    for (const e of entries) {
      try {
        const s = await lstat(path.join(dirPath, e.name));
        out.push({
          filename: e.name,
          isDirectory: s.isDirectory(),
          isSymlink: s.isSymbolicLink(),
          size: s.size,
          mtime: Math.floor(s.mtimeMs / 1000),
          mode: s.mode,
        });
      } catch {
        // skip entries that disappear or can't be stat'ed
      }
    }
    return out;
  });

  ipcMain.handle('fs:home-dir', () => homedir());

  ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
    const stats = await stat(filePath);
    if (stats.size > MAX_READ_FILE_BYTES) {
      throw new Error(`File too large (${Math.round(stats.size / 1024 / 1024)}MB). Maximum is ${MAX_READ_FILE_BYTES / 1024 / 1024}MB.`);
    }
    return readFile(filePath, 'utf-8');
  });

  ipcMain.handle('fs:write-file', async (_event, filePath: string, content: string) => {
    await writeFile(filePath, content, 'utf-8');
  });

  ipcMain.handle(
    'fs:write-file-with-sync',
    async (_event, filePath: string, content: string, options: WriteWithSyncOptions) => {
      await writeFile(filePath, content, 'utf-8');
      const localRoot = path.resolve(options.localRootPath);
      const absoluteFile = path.resolve(filePath);
      const relativePath = path.relative(localRoot, absoluteFile);
      const relativePosix = relativePath.split(path.sep).join(path.posix.sep);
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return { synced: false, targetResults: [] };
      }
      return syncRelativePathToTargets(absoluteFile, relativePosix, options);
    }
  );

  ipcMain.handle(
    'fs:move-with-sync',
    async (_event, srcPath: string, destPath: string, options: WriteWithSyncOptions) => {
      await rename(srcPath, destPath);
      const localRoot = path.resolve(options.localRootPath);
      const absoluteSrc = path.resolve(srcPath);
      const absoluteFile = path.resolve(destPath);
      const oldRelative = path.relative(localRoot, absoluteSrc).split(path.sep).join(path.posix.sep);
      const relativePath = path.relative(localRoot, absoluteFile);
      const relativePosix = relativePath.split(path.sep).join(path.posix.sep);
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return { targetResults: [] };
      }
      const sync = options.sync;
      if (sync?.enabled && sync.targets?.length) {
        const activeTargets = sync.targets.filter(
          (t) => t.enabled && t.connectionId && t.remotePath.trim().length > 0
        );
        for (const target of activeTargets) {
          const saved = connectionStore.getAll().find((c) => c.id === target.connectionId);
          if (!saved) continue;
          const cfg = connectionStore.toConnectionConfig(saved);
          const remoteRoot = target.remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
          const oldRemote = `${remoteRoot}/${oldRelative}`.replace(/\/{2,}/g, '/');
          await sftpSyncManager.deleteRemotePath(options.workspaceId, target.id, cfg, oldRemote).catch(() => {
            // best effort
          });
        }
      }
      const result = await syncRelativePathToTargets(absoluteFile, relativePosix, options);
      return { targetResults: result.targetResults };
    }
  );

  ipcMain.handle('fs:move', async (_event, srcPath: string, destPath: string) => {
    await rename(srcPath, destPath);
  });

  ipcMain.handle('fs:create-file', async (_event, filePath: string) => {
    await writeFile(filePath, '', 'utf-8');
  });

  ipcMain.handle(
    'fs:create-file-with-sync',
    async (_event, filePath: string, options: WriteWithSyncOptions) => {
      await writeFile(filePath, '', 'utf-8');
      const localRoot = path.resolve(options.localRootPath);
      const absoluteFile = path.resolve(filePath);
      const relativePath = path.relative(localRoot, absoluteFile);
      const relativePosix = relativePath.split(path.sep).join(path.posix.sep);
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return { targetResults: [] };
      }
      const result = await syncRelativePathToTargets(absoluteFile, relativePosix, options);
      return { targetResults: result.targetResults };
    }
  );

  ipcMain.handle('fs:create-directory', async (_event, dirPath: string) => {
    await mkdir(dirPath, { recursive: true }).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
  });

  ipcMain.handle(
    'fs:create-directory-with-sync',
    async (_event, dirPath: string, options: WriteWithSyncOptions) => {
      await mkdir(dirPath, { recursive: true }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const localRoot = path.resolve(options.localRootPath);
      const absoluteDir = path.resolve(dirPath);
      const relativePath = path.relative(localRoot, absoluteDir);
      const relativePosix = relativePath.split(path.sep).join(path.posix.sep);
      if (!options.sync?.enabled || !relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return { targetResults: [] };
      }
      const matcher = await buildIgnoreMatcher(localRoot, options.sync.useGitIgnore);
      if (matcher?.ignores(relativePosix)) return { targetResults: [] };

      const targetResults: Array<{ targetId: string; ok: boolean; error?: string }> = [];
      const activeTargets = options.sync.targets.filter(
        (t) => t.enabled && t.connectionId && t.remotePath.trim().length > 0
      );
      for (const target of activeTargets) {
        const saved = connectionStore.getAll().find((c) => c.id === target.connectionId);
        if (!saved) {
          targetResults.push({ targetId: target.id, ok: false, error: 'Saved SSH connection not found.' });
          continue;
        }
        try {
          const cfg = connectionStore.toConnectionConfig(saved);
          const remoteRoot = target.remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
          const remoteDir = `${remoteRoot}/${relativePosix}`.replace(/\/{2,}/g, '/');
          await sftpSyncManager.ensureRemoteDir(options.workspaceId, target.id, cfg, remoteDir);
          targetResults.push({ targetId: target.id, ok: true });
        } catch (error) {
          targetResults.push({ targetId: target.id, ok: false, error: (error as Error).message });
        }
      }
      return { targetResults };
    }
  );

  ipcMain.handle('fs:copy', async (_event, srcPath: string, destPath: string) => {
    const stats = await stat(srcPath);
    if (stats.isDirectory()) {
      await cp(srcPath, destPath, { recursive: true });
    } else {
      await copyFile(srcPath, destPath);
    }
  });

  ipcMain.handle('fs:stat', async (_event, filePath: string) => {
    const stats = await stat(filePath);
    return { isDirectory: stats.isDirectory(), size: stats.size };
  });

  ipcMain.handle('fs:trash', async (_event, filePath: string) => {
    await shell.trashItem(filePath);
  });

  ipcMain.handle(
    'fs:trash-with-sync',
    async (_event, filePath: string, options: WriteWithSyncOptions) => {
      await shell.trashItem(filePath);
      const localRoot = path.resolve(options.localRootPath);
      const absoluteFile = path.resolve(filePath);
      const relativePath = path.relative(localRoot, absoluteFile);
      const relativePosix = relativePath.split(path.sep).join(path.posix.sep);
      if (!options.sync?.enabled || !relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return { targetResults: [] };
      }
      const targetResults: Array<{ targetId: string; ok: boolean; error?: string }> = [];
      const activeTargets = options.sync.targets.filter(
        (t) => t.enabled && t.connectionId && t.remotePath.trim().length > 0
      );
      for (const target of activeTargets) {
        const saved = connectionStore.getAll().find((c) => c.id === target.connectionId);
        if (!saved) {
          targetResults.push({ targetId: target.id, ok: false, error: 'Saved SSH connection not found.' });
          continue;
        }
        try {
          const cfg = connectionStore.toConnectionConfig(saved);
          const remoteRoot = target.remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
          const remoteFile = `${remoteRoot}/${relativePosix}`.replace(/\/{2,}/g, '/');
          await sftpSyncManager.deleteRemotePath(options.workspaceId, target.id, cfg, remoteFile);
          targetResults.push({ targetId: target.id, ok: true });
        } catch (error) {
          targetResults.push({ targetId: target.id, ok: false, error: (error as Error).message });
        }
      }
      return { targetResults };
    }
  );

  ipcMain.handle('sync:run-now', async (_event, options: WriteWithSyncOptions) => {
    const sync = options?.sync;
    if (!sync?.enabled || !sync.targets?.length || !options?.workspaceId || !options?.localRootPath) {
      return { scanned: 0, uploaded: 0, skippedByGitIgnore: 0, targetResults: [] };
    }

    const localRoot = path.resolve(options.localRootPath);
    const matcher = await buildIgnoreMatcher(localRoot, sync.useGitIgnore);

    const syncId = options.syncId;
    const ac = new AbortController();
    if (syncId) activeSyncs.set(syncId, ac);
    try {
      const files: string[] = [];
      let skippedByGitIgnore = 0;
      const walk = async (dir: string) => {
        if (ac.signal.aborted) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (ac.signal.aborted) return;
          const full = path.join(dir, e.name);
          const rel = path.relative(localRoot, full).split(path.sep).join(path.posix.sep);
          if (e.name === '.git') continue; // never sync the git db
          if (matcher?.ignores(rel)) {
            skippedByGitIgnore += 1;
            continue;
          }
          if (e.isDirectory()) await walk(full);
          else if (e.isFile()) files.push(full);
        }
      };
      await walk(localRoot);

      const aggregate = new Map<string, { ok: boolean; uploaded: number; error?: string }>();
      for (const t of sync.targets) {
        aggregate.set(t.id, { ok: true, uploaded: 0 });
      }

      for (const file of files) {
        if (ac.signal.aborted) break;
        const relativePosix = path
          .relative(localRoot, file)
          .split(path.sep)
          .join(path.posix.sep);
        const result = await syncRelativePathToTargets(file, relativePosix, options);
        if (result.skippedByGitIgnore) {
          skippedByGitIgnore += 1;
        }
        for (const tr of result.targetResults) {
          const prev = aggregate.get(tr.targetId);
          if (!prev) continue;
          if (tr.ok) {
            prev.uploaded += 1;
          } else {
            prev.ok = false;
            prev.error = tr.error;
          }
        }
      }

      const targetResults = Array.from(aggregate.entries()).map(([targetId, s]) => ({
        targetId,
        ok: s.ok,
        uploaded: s.uploaded,
        error: s.error,
      }));
      return {
        scanned: files.length,
        uploaded: targetResults.reduce((acc, t) => acc + t.uploaded, 0),
        skippedByGitIgnore,
        cancelled: ac.signal.aborted,
        targetResults,
      };
    } finally {
      if (syncId) activeSyncs.delete(syncId);
    }
  });

  // --- Concurrency pool for parallel SFTP transfers ---
  const SFTP_CONCURRENCY = 10;

  async function asyncPool<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const executing = new Set<Promise<void>>();
    for (const item of items) {
      // Stop scheduling new transfers once cancelled; in-flight ones drain below.
      if (signal?.aborted) break;
      const p = fn(item).then(() => { executing.delete(p); });
      executing.add(p);
      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
  }

  // Cancel an in-flight bulk sync (push/pull/run-now) by its renderer-supplied id.
  ipcMain.handle('sftp:cancel-sync', (_event, syncId: string) => {
    const ac = typeof syncId === 'string' ? activeSyncs.get(syncId) : undefined;
    if (!ac) return { ok: false };
    ac.abort();
    return { ok: true };
  });

  // --- SFTP file manager (per-pane remote browsing) ---
  // Each pane passes a SftpTarget; (workspaceId, containerId) keys its own
  // cached SFTP session so panes don't share connection state.
  const resolveSftpConfig = (target: SftpTarget) => {
    const saved = connectionStore.getAll().find((c) => c.id === target.connectionId);
    if (!saved) throw new Error('Connection not found');
    return connectionStore.toConnectionConfig(saved);
  };

  ipcMain.handle('sftp:stat-dir', (_event, target: SftpTarget, path: string) =>
    sftpSyncManager.statRemoteDir(target.workspaceId, target.containerId, resolveSftpConfig(target), path));

  ipcMain.handle('sftp:mkdir', (_event, target: SftpTarget, path: string) =>
    sftpSyncManager.mkdirRemote(target.workspaceId, target.containerId, resolveSftpConfig(target), path));

  ipcMain.handle('sftp:rename', (_event, target: SftpTarget, oldPath: string, newPath: string) =>
    sftpSyncManager.renameRemote(target.workspaceId, target.containerId, resolveSftpConfig(target), oldPath, newPath));

  ipcMain.handle('sftp:delete-path', (_event, target: SftpTarget, path: string) =>
    sftpSyncManager.deleteRemotePath(target.workspaceId, target.containerId, resolveSftpConfig(target), path));

  ipcMain.handle('sftp:read-file', (_event, target: SftpTarget, path: string) =>
    sftpSyncManager.readRemoteFile(target.workspaceId, target.containerId, resolveSftpConfig(target), path));

  ipcMain.handle('sftp:write-file', (_event, target: SftpTarget, path: string, content: string) =>
    sftpSyncManager.writeRemoteFile(target.workspaceId, target.containerId, resolveSftpConfig(target), path, content));

  ipcMain.handle('sftp:realpath', (_event, target: SftpTarget, path: string) =>
    sftpSyncManager.realpathRemote(target.workspaceId, target.containerId, resolveSftpConfig(target), path));

  // --- SFTP file manager transfers (dual-pane upload/download) ---
  // Unlike sftp:push-paths / sftp:pull-paths these are NOT tied to the
  // workspace-sync model (no localRootPath, no gitignore, no targets): each
  // selected item is moved INTO the destination directory keeping its
  // basename. Cancellation reuses activeSyncs keyed by the renderer-supplied
  // transferId; per-file failures are collected, never thrown.

  ipcMain.handle(
    'sftp:fm-upload',
    async (_event, target: SftpTarget, localPaths: string[], remoteDir: string, transferId: string) => {
      const cfg = resolveSftpConfig(target);
      const ac = new AbortController();
      activeSyncs.set(transferId, ac);
      let done = 0;
      const errors: string[] = [];
      try {
        // Flatten the selection into { localFile, remoteFile } pairs. For a
        // directory, paths are made relative to its PARENT so the directory's
        // own name is recreated under remoteDir.
        const work: Array<{ localFile: string; remoteFile: string }> = [];
        const walkDir = async (dir: string, parent: string) => {
          if (ac.signal.aborted) return;
          const entries = await readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (ac.signal.aborted) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              await walkDir(full, parent);
            } else if (e.isFile()) {
              const rel = path.relative(parent, full).split(path.sep).join(path.posix.sep);
              work.push({ localFile: full, remoteFile: joinRemote(remoteDir, rel) });
            }
          }
        };
        for (const p of localPaths) {
          if (ac.signal.aborted) break;
          const full = path.resolve(p);
          try {
            const s = await stat(full);
            if (s.isDirectory()) await walkDir(full, path.dirname(full));
            else if (s.isFile()) work.push({ localFile: full, remoteFile: joinRemote(remoteDir, path.basename(full)) });
          } catch (err) {
            errors.push(`${p}: ${(err as Error).message}`);
          }
        }

        const total = work.length;
        await asyncPool(SFTP_CONCURRENCY, work, async ({ localFile, remoteFile }) => {
          if (ac.signal.aborted) return;
          const current = ++done;
          const progress: SftpTransferProgress = { transferId, direction: 'upload', file: remoteFile, current, total };
          broadcast('sftp:fm-progress', progress);
          try {
            // syncFileDirect ensures the remote parent dir before fastPut.
            await sftpSyncManager.syncFileDirect(target.workspaceId, target.containerId, cfg, localFile, remoteFile);
          } catch (err) {
            errors.push(`${remoteFile}: ${(err as Error).message}`);
          }
        }, ac.signal);

        return { ok: !ac.signal.aborted, transferred: done, total, errors };
      } finally {
        activeSyncs.delete(transferId);
      }
    }
  );

  ipcMain.handle(
    'sftp:fm-download',
    async (_event, target: SftpTarget, items: Array<{ path: string; isDirectory: boolean }>, localDir: string, transferId: string) => {
      const cfg = resolveSftpConfig(target);
      const ac = new AbortController();
      activeSyncs.set(transferId, ac);
      let done = 0;
      const errors: string[] = [];
      try {
        // Flatten the selection into { remoteFile, localFile } pairs; the
        // renderer already knows which items are directories, so only those
        // need a remote walk.
        const work: Array<{ remoteFile: string; localFile: string }> = [];
        // Security: a malicious/compromised server controls the remote names we
        // get back from readdir. Guard against path traversal — reject names
        // with separators / '..' / NUL, and verify every local target stays
        // inside the chosen download dir before writing to it.
        const downloadRoot = path.resolve(localDir);
        const isSafeName = (name: string) =>
          !!name && name !== '.' && name !== '..' &&
          !name.includes('/') && !name.includes('\\') && !name.includes('\0');
        const within = (p: string) => {
          const r = path.resolve(p);
          return r === downloadRoot || r.startsWith(downloadRoot + path.sep);
        };
        const walkRemote = async (remoteDir: string, localBase: string) => {
          if (ac.signal.aborted) return;
          const entries = await sftpSyncManager.statRemoteDir(target.workspaceId, target.containerId, cfg, remoteDir);
          for (const entry of entries) {
            if (ac.signal.aborted) return;
            if (!isSafeName(entry.filename)) { errors.push(`${joinRemote(remoteDir, entry.filename)}: unsafe name, skipped`); continue; }
            const rp = joinRemote(remoteDir, entry.filename);
            const lp = path.join(localBase, entry.filename);
            if (!within(lp)) { errors.push(`${rp}: target escapes download dir, skipped`); continue; }
            if (entry.isDirectory) await walkRemote(rp, lp);
            else work.push({ remoteFile: rp, localFile: lp });
          }
        };
        for (const item of items) {
          if (ac.signal.aborted) break;
          const base = path.posix.basename(item.path);
          if (!isSafeName(base)) { errors.push(`${item.path}: unsafe name, skipped`); continue; }
          const lp = path.join(localDir, base);
          if (!within(lp)) { errors.push(`${item.path}: target escapes download dir, skipped`); continue; }
          try {
            if (item.isDirectory) await walkRemote(item.path, lp);
            else work.push({ remoteFile: item.path, localFile: lp });
          } catch (err) {
            errors.push(`${item.path}: ${(err as Error).message}`);
          }
        }

        const total = work.length;
        await asyncPool(SFTP_CONCURRENCY, work, async ({ remoteFile, localFile }) => {
          if (ac.signal.aborted) return;
          const current = ++done;
          const progress: SftpTransferProgress = { transferId, direction: 'download', file: remoteFile, current, total };
          broadcast('sftp:fm-progress', progress);
          try {
            // pullFileDirect mkdir -p's the local parent before fastGet.
            await sftpSyncManager.pullFileDirect(target.workspaceId, target.containerId, cfg, remoteFile, localFile);
          } catch (err) {
            errors.push(`${remoteFile}: ${(err as Error).message}`);
          }
        }, ac.signal);

        return { ok: !ac.signal.aborted, transferred: done, total, errors };
      } finally {
        activeSyncs.delete(transferId);
      }
    }
  );

  ipcMain.handle('sftp:cancel-transfer', (_event, transferId: string) => {
    activeSyncs.get(transferId)?.abort();
    activeSyncs.delete(transferId);
    return { ok: true };
  });

  // Build a "should this path be excluded from sync?" predicate shared by the
  // push walk and the (remote) pull walk: never sync the `.git` directory, and
  // honour .gitignore when the matcher is present. `rel` is the POSIX path
  // relative to the local root; '' (the root itself) is never excluded.
  const makeSyncExcluder = (matcher: ReturnType<typeof ignore> | null) =>
    (name: string, rel: string): 'git' | 'ignore' | null => {
      if (name === '.git') return 'git';
      if (rel && matcher?.ignores(rel)) return 'ignore';
      return null;
    };

  // --- SFTP push specific paths ---

  ipcMain.handle('sftp:push-paths', async (_event, filePaths: string[], options: WriteWithSyncOptions) => {
    const sync = options?.sync;
    if (!sync?.enabled || !sync.targets?.length || !options?.workspaceId || !options?.localRootPath) {
      return { pushed: 0, total: 0, targetResults: [] };
    }

    const localRoot = path.resolve(options.localRootPath);
    const matcher = await buildIgnoreMatcher(localRoot, sync.useGitIgnore);
    const excluded = makeSyncExcluder(matcher);
    const relOf = (full: string) => path.relative(localRoot, full).split(path.sep).join(path.posix.sep);

    const syncId = options.syncId;
    const ac = new AbortController();
    if (syncId) activeSyncs.set(syncId, ac);
    try {
      const allFiles: string[] = [];
      let skippedByGitIgnore = 0;

      // Walk a directory, excluding .git and .gitignore'd paths so a folder push
      // doesn't dump node_modules / build output / the git db to the remote.
      const walkDir = async (dir: string) => {
        if (ac.signal.aborted) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (ac.signal.aborted) return;
          const ep = path.join(dir, e.name);
          const ex = excluded(e.name, relOf(ep));
          if (ex) { if (ex === 'ignore') skippedByGitIgnore += 1; continue; }
          if (e.isDirectory()) await walkDir(ep);
          else if (e.isFile()) allFiles.push(ep);
        }
      };

      for (const p of filePaths) {
        if (ac.signal.aborted) break;
        const full = path.resolve(p);
        // Filter directly-selected paths too (pushing the root folder honours
        // .gitignore); the root itself has an empty rel and is never excluded.
        const ex = excluded(path.basename(full), relOf(full));
        if (ex) { if (ex === 'ignore') skippedByGitIgnore += 1; continue; }
        try {
          const s = await stat(full);
          if (s.isDirectory()) await walkDir(full);
          else if (s.isFile()) allFiles.push(full);
        } catch {
          // skip inaccessible paths
        }
      }

      const aggregate = new Map<string, { ok: boolean; pushed: number; error?: string }>();
      for (const t of sync.targets) {
        if (t.enabled) aggregate.set(t.id, { ok: true, pushed: 0 });
      }

      const total = allFiles.length;
      let pushed = 0;

      // Resolve target configs once
      const activeTargets = sync.targets.filter(t => t.enabled && t.connectionId);
      const targetConfigs = new Map<string, { target: typeof activeTargets[0]; cfg: ReturnType<typeof connectionStore.toConnectionConfig> }>();
      for (const t of activeTargets) {
        const saved = connectionStore.getAll().find(c => c.id === t.connectionId);
        if (saved) targetConfigs.set(t.id, { target: t, cfg: connectionStore.toConnectionConfig(saved) });
      }

      await asyncPool(SFTP_CONCURRENCY, allFiles, async (file) => {
        if (ac.signal.aborted) return;
        const relativePosix = relOf(file);
        const current = ++pushed;
        broadcast('sftp:progress', { direction: 'push', file: relativePosix, current, total });
        for (const [targetId, { target: t, cfg }] of targetConfigs) {
          const remoteFile = `${t.remotePath.replace(/\/+$/, '')}/${relativePosix}`.replace(/\/{2,}/g, '/');
          try {
            await sftpSyncManager.syncFileDirect(options.workspaceId, t.id, cfg, file, remoteFile);
            const prev = aggregate.get(targetId);
            if (prev) prev.pushed += 1;
          } catch (err) {
            const prev = aggregate.get(targetId);
            if (prev) { prev.ok = false; prev.error = (err as Error).message; }
          }
        }
      }, ac.signal);

      const targetResults = Array.from(aggregate.entries()).map(([targetId, s]) => ({
        targetId, ok: s.ok, pushed: s.pushed, error: s.error,
      }));
      return {
        pushed,
        total,
        cancelled: ac.signal.aborted,
        skippedByGitIgnore,
        targetResults,
      };
    } finally {
      if (syncId) activeSyncs.delete(syncId);
    }
  });

  // --- SFTP pull specific paths ---

  ipcMain.handle('sftp:pull-paths', async (_event, localPaths: string[], options: WriteWithSyncOptions) => {
    const sync = options?.sync;
    if (!sync?.enabled || !sync.targets?.length || !options?.workspaceId || !options?.localRootPath) {
      return { pulled: 0, targetResults: [] };
    }

    const localRoot = path.resolve(options.localRootPath);
    // Use first enabled target for pull
    const target = sync.targets.find(t => t.enabled && t.connectionId && t.remotePath.trim().length > 0);
    if (!target) return { pulled: 0, targetResults: [] };

    const saved = connectionStore.getAll().find(c => c.id === target.connectionId);
    if (!saved) return { pulled: 0, targetResults: [{ targetId: target.id, ok: false, error: 'Connection not found' }] };

    const cfg = connectionStore.toConnectionConfig(saved);
    const remoteRoot = target.remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const matcher = await buildIgnoreMatcher(localRoot, sync.useGitIgnore);
    const excluded = makeSyncExcluder(matcher);
    const relOf = (full: string) => path.relative(localRoot, full).split(path.sep).join(path.posix.sep);
    let pulled = 0;
    let skippedByGitIgnore = 0;

    const syncId = options.syncId;
    const ac = new AbortController();
    if (syncId) activeSyncs.set(syncId, ac);
    try {
      // Phase 1: Collect all remote files to pull (sequential walk, fast)
      const filesToPull: Array<{ remotePath: string; localPath: string }> = [];

      const collectPath = async (localPath: string) => {
        if (ac.signal.aborted) return;
        const full = path.resolve(localPath);
        // Filter directly-selected paths too; the root has an empty rel.
        const exTop = excluded(path.basename(full), relOf(full));
        if (exTop) { if (exTop === 'ignore') skippedByGitIgnore += 1; return; }
        const relativePosix = relOf(full);
        const remotePath = `${remoteRoot}/${relativePosix}`.replace(/\/{2,}/g, '/');

        let isDir = false;
        try {
          const s = await stat(full);
          isDir = s.isDirectory();
        } catch {
          // Local path doesn't exist — check if it's a directory on the remote
          try {
            await sftpSyncManager.listRemoteDir(options.workspaceId, target.id, cfg, remotePath);
            isDir = true;
          } catch {
            isDir = false;
          }
        }

        if (isDir) {
          // Don't pull .git or .gitignore'd paths back down either.
          const walkRemote = async (remDir: string, locDir: string) => {
            if (ac.signal.aborted) return;
            await mkdir(locDir, { recursive: true }).catch(() => {});
            const entries = await sftpSyncManager.listRemoteDir(options.workspaceId, target.id, cfg, remDir);
            for (const entry of entries) {
              if (ac.signal.aborted) return;
              const rp = `${remDir}/${entry.filename}`.replace(/\/{2,}/g, '/');
              const lp = path.join(locDir, entry.filename);
              const ex = excluded(entry.filename, relOf(lp));
              if (ex) { if (ex === 'ignore') skippedByGitIgnore += 1; continue; }
              if (entry.isDirectory) await walkRemote(rp, lp);
              else filesToPull.push({ remotePath: rp, localPath: lp });
            }
          };
          await walkRemote(remotePath, full);
        } else {
          filesToPull.push({ remotePath, localPath: full });
        }
      };

      for (const lp of localPaths) {
        if (ac.signal.aborted) break;
        await collectPath(lp);
      }

      if (filesToPull.length === 0) {
        return { pulled: 0, cancelled: ac.signal.aborted, skippedByGitIgnore, targetResults: [{ targetId: target.id, ok: true, pulled: 0 }] };
      }

      // Phase 2: Pull files in parallel (10 concurrent streams)
      const total = filesToPull.length;
      const errors: string[] = [];
      await asyncPool(SFTP_CONCURRENCY, filesToPull, async ({ remotePath: rp, localPath: lp }) => {
        if (ac.signal.aborted) return;
        const current = ++pulled;
        const relFile = relOf(lp);
        broadcast('sftp:progress', { direction: 'pull', file: relFile, current, total });
        try {
          await sftpSyncManager.pullFileDirect(options.workspaceId, target.id, cfg, rp, lp);
        } catch (fileErr) {
          console.error(`[sftp:pull] failed ${rp} -> ${lp}:`, (fileErr as Error).message);
          errors.push(`${relFile}: ${(fileErr as Error).message}`);
        }
      }, ac.signal);

      const ok = errors.length === 0;
      return {
        pulled: pulled - errors.length,
        cancelled: ac.signal.aborted,
        skippedByGitIgnore,
        targetResults: [{
          targetId: target.id,
          ok,
          pulled: pulled - errors.length,
          ...(errors.length ? { error: errors.slice(0, 5).join('; ') } : {}),
        }],
      };
    } catch (error) {
      console.error('[sftp:pull] fatal:', (error as Error).message);
      return { pulled, cancelled: ac.signal.aborted, skippedByGitIgnore, targetResults: [{ targetId: target.id, ok: false, pulled, error: (error as Error).message }] };
    } finally {
      if (syncId) activeSyncs.delete(syncId);
    }
  });

  // --- Dialogs ---

  ipcMain.handle('dialog:select-private-key', async (event) => {
    const win = getWinForEvent(event);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: 'Select SSH Private Key',
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('dialog:select-directory', async (event) => {
    const win = getWinForEvent(event);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Working Directory',
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // --- File watching (for IDE external changes) ---
  const fileWatchers = new Map<string, ReturnType<typeof watch>>();

  ipcMain.handle('fs:watch-file', async (_event, filePath: string) => {
    if (fileWatchers.has(filePath)) return; // already watching
    try {
      const watcher = watch(filePath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          broadcast('fs:file-changed', filePath);
        }
      });
      watcher.on('error', () => {
        fileWatchers.delete(filePath);
      });
      fileWatchers.set(filePath, watcher);
    } catch {
      // file may not exist yet
    }
  });

  ipcMain.handle('fs:unwatch-file', async (_event, filePath: string) => {
    const watcher = fileWatchers.get(filePath);
    if (watcher) {
      watcher.close();
      fileWatchers.delete(filePath);
    }
  });

  // --- Recursive directory watcher (for file tree + editor live reload) ---
  interface DirWatcher {
    watcher: ReturnType<typeof watch>;
    /** Directories that changed — debounced then broadcast */
    pendingDirs: Set<string>;
    /** Files that changed — debounced then broadcast */
    pendingFiles: Set<string>;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    localRoot: string;
  }
  const dirWatchers = new Map<string, DirWatcher>();
  const DIR_WATCH_DEBOUNCE_MS = 300;

  const flushDirChanges = (watchId: string) => {
    const dw = dirWatchers.get(watchId);
    if (!dw) return;
    dw.debounceTimer = null;

    if (dw.pendingDirs.size > 0) {
      const dirs = Array.from(dw.pendingDirs);
      dw.pendingDirs.clear();
      broadcast('fs:directories-changed', dirs);
    }
    if (dw.pendingFiles.size > 0) {
      const files = Array.from(dw.pendingFiles);
      dw.pendingFiles.clear();
      broadcast('fs:files-changed', files);
    }
  };

  ipcMain.handle('fs:watch-directory', async (_event, watchId: string, dirPath: string) => {
    // Close existing watcher for this ID
    const existing = dirWatchers.get(watchId);
    if (existing) {
      existing.watcher.close();
      if (existing.debounceTimer) clearTimeout(existing.debounceTimer);
      dirWatchers.delete(watchId);
    }

    const localRoot = path.resolve(dirPath);
    try {
      const watcher = watch(localRoot, { recursive: true, persistent: false }, (_eventType, filename) => {
        if (!filename) return;

        const dw = dirWatchers.get(watchId);
        if (!dw) return;

        // Skip hidden/system files and common non-source dirs
        const parts = filename.split(path.sep);
        if (parts.some(p => p.startsWith('.') || p === 'node_modules' || p === '__pycache__' || p === 'target')) return;

        const absolutePath = path.join(localRoot, filename);
        const parentDir = path.dirname(absolutePath);

        // Queue both file and directory changes
        dw.pendingFiles.add(absolutePath);
        dw.pendingDirs.add(parentDir);

        if (dw.debounceTimer) clearTimeout(dw.debounceTimer);
        dw.debounceTimer = setTimeout(() => flushDirChanges(watchId), DIR_WATCH_DEBOUNCE_MS);
      });

      watcher.on('error', () => {
        dirWatchers.delete(watchId);
      });

      dirWatchers.set(watchId, {
        watcher,
        pendingDirs: new Set(),
        pendingFiles: new Set(),
        debounceTimer: null,
        localRoot,
      });
    } catch (err) {
      console.error('[fs:watch-directory] failed:', (err as Error).message);
    }
  });

  ipcMain.handle('fs:unwatch-directory', async (_event, watchId: string) => {
    const dw = dirWatchers.get(watchId);
    if (dw) {
      dw.watcher.close();
      if (dw.debounceTimer) clearTimeout(dw.debounceTimer);
      dirWatchers.delete(watchId);
    }
  });

  // --- Workspace auto-sync watcher (mirror local → remote on any change) ---
  // A chokidar watcher per workspace. Unlike raw fs.watch it reports normalised,
  // cross-platform events (add/change/unlink/unlinkDir), reliably catches new
  // files and atomic saves (write-temp + rename), and recurses on Linux too —
  // so disk changes from ANY source (editor save, terminal, build tool, an AI
  // agent writing files) propagate, not just Monaco's Cmd+S.
  interface WorkspaceWatcher {
    watcher: chokidar.FSWatcher;
    localRoot: string;
    syncOptions: WriteWithSyncOptions;
    pendingUpserts: Set<string>; // absolute file paths created/changed → push
    pendingDirCreates: Set<string>; // absolute dir paths created → mkdir on remote
    pendingDeletes: Set<string>; // absolute file/dir paths removed → delete remote
    debounceTimer: ReturnType<typeof setTimeout> | null;
  }
  const workspaceWatchers = new Map<string, WorkspaceWatcher>();
  const SYNC_DEBOUNCE_MS = 400;
  // Dirs we never watch — huge and/or noise; saves CPU and avoids accidental
  // syncing of VCS internals. .gitignore (when enabled) filters the rest.
  const ALWAYS_IGNORE_SEGMENTS = new Set(['.git', 'node_modules', '__pycache__', 'target', '.DS_Store']);

  const flushWorkspaceSync = async (workspaceId: string) => {
    const ww = workspaceWatchers.get(workspaceId);
    if (!ww) return;
    ww.debounceTimer = null;
    pruneRecentDirectSync();

    const upserts = Array.from(ww.pendingUpserts);
    ww.pendingUpserts.clear();
    const dirCreates = Array.from(ww.pendingDirCreates);
    ww.pendingDirCreates.clear();
    const deletes = Array.from(ww.pendingDeletes);
    ww.pendingDeletes.clear();
    if (upserts.length === 0 && dirCreates.length === 0 && deletes.length === 0) return;

    const localRoot = ww.localRoot;
    let synced = 0;
    let removed = 0;
    let errors = 0;

    const toRelPosix = (absPath: string): string | null => {
      const rel = path.relative(localRoot, absPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return rel.split(path.sep).join(path.posix.sep);
    };

    // Mirror created (possibly empty) dirs first, so they exist before any file
    // pushes/removals reference them.
    for (const absoluteDir of dirCreates) {
      const relativePosix = toRelPosix(absoluteDir);
      if (!relativePosix) continue;
      try {
        const result = await ensureRelativeDirOnTargets(relativePosix, ww.syncOptions);
        if (result.created) synced++;
        else if (!result.skippedByGitIgnore && result.targetResults.some((r) => !r.ok)) errors++;
      } catch {
        errors++;
      }
    }

    // Pushes next, then removals.
    for (const absoluteFile of upserts) {
      // A direct Cmd+S / explorer push already uploaded this exact write —
      // don't upload it a second time off the watcher echo.
      if (wasRecentlySynced(absoluteFile)) continue;
      try {
        const s = await stat(absoluteFile);
        if (!s.isFile()) continue;
      } catch {
        continue; // vanished before we got to it — its unlink event handles it
      }
      const relativePosix = toRelPosix(absoluteFile);
      if (!relativePosix) continue;
      try {
        const result = await syncRelativePathToTargets(absoluteFile, relativePosix, ww.syncOptions);
        if (result.synced) synced++;
        else if (!result.skippedByGitIgnore && result.targetResults.some((r) => !r.ok)) errors++;
      } catch {
        errors++;
      }
    }

    for (const absolutePath of deletes) {
      const relativePosix = toRelPosix(absolutePath);
      if (!relativePosix) continue;
      try {
        const result = await deleteRelativePathFromTargets(relativePosix, ww.syncOptions);
        if (result.removed) removed++;
        else if (!result.skippedByGitIgnore && result.targetResults.some((r) => !r.ok)) errors++;
      } catch {
        errors++;
      }
    }

    if (synced > 0 || removed > 0 || errors > 0) {
      broadcast('sync:auto-synced', {
        workspaceId,
        synced,
        removed,
        errors,
        total: upserts.length + dirCreates.length + deletes.length,
      });
    }
  };

  const scheduleWorkspaceFlush = (ww: WorkspaceWatcher, workspaceId: string) => {
    if (ww.debounceTimer) clearTimeout(ww.debounceTimer);
    ww.debounceTimer = setTimeout(() => void flushWorkspaceSync(workspaceId), SYNC_DEBOUNCE_MS);
  };

  const queueUpsert = (workspaceId: string, absPath: string) => {
    const ww = workspaceWatchers.get(workspaceId);
    if (!ww) return;
    ww.pendingDeletes.delete(absPath);
    ww.pendingUpserts.add(absPath);
    scheduleWorkspaceFlush(ww, workspaceId);
  };

  const queueDirCreate = (workspaceId: string, absPath: string) => {
    const ww = workspaceWatchers.get(workspaceId);
    if (!ww) return;
    ww.pendingDeletes.delete(absPath);
    ww.pendingDirCreates.add(absPath);
    scheduleWorkspaceFlush(ww, workspaceId);
  };

  const queueDelete = (workspaceId: string, absPath: string) => {
    const ww = workspaceWatchers.get(workspaceId);
    if (!ww) return;
    ww.pendingUpserts.delete(absPath);
    ww.pendingDirCreates.delete(absPath);
    ww.pendingDeletes.add(absPath);
    scheduleWorkspaceFlush(ww, workspaceId);
  };

  const stopWorkspaceWatcher = async (workspaceId: string) => {
    const ww = workspaceWatchers.get(workspaceId);
    if (!ww) return;
    if (ww.debounceTimer) clearTimeout(ww.debounceTimer);
    workspaceWatchers.delete(workspaceId);
    await ww.watcher.close().catch(() => {});
  };

  ipcMain.handle('sync:watch-workspace', async (_event, options: WriteWithSyncOptions) => {
    const { workspaceId, localRootPath } = options;
    await stopWorkspaceWatcher(workspaceId);

    if (!options.sync?.enabled) return;

    const localRoot = path.resolve(localRootPath);
    // Build the .gitignore matcher once so chokidar can skip ignored paths at
    // the source (no wasted watches). Per-file pushes re-check .gitignore fresh,
    // so toggling it mid-session still takes effect on the next change.
    const matcher = await buildIgnoreMatcher(localRoot, !!options.sync.useGitIgnore);
    const isIgnored = (absPath: string): boolean => {
      const rel = path.relative(localRoot, absPath);
      if (!rel) return false; // the root itself
      if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
      const parts = rel.split(path.sep);
      if (parts.some((p) => ALWAYS_IGNORE_SEGMENTS.has(p))) return true;
      return matcher?.ignores(parts.join(path.posix.sep)) ?? false;
    };

    try {
      const watcher = chokidar.watch(localRoot, {
        ignoreInitial: true, // existing tree is synced via explicit "Sync now", not on watch start
        persistent: true,
        followSymlinks: false,
        ignored: (p: string) => isIgnored(p),
        // Wait for writes to settle so we never upload a half-written file.
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      });

      workspaceWatchers.set(workspaceId, {
        watcher,
        localRoot,
        syncOptions: options,
        pendingUpserts: new Set(),
        pendingDirCreates: new Set(),
        pendingDeletes: new Set(),
        debounceTimer: null,
      });

      watcher
        .on('add', (p) => queueUpsert(workspaceId, p))
        .on('change', (p) => queueUpsert(workspaceId, p))
        .on('addDir', (p) => queueDirCreate(workspaceId, p))
        .on('unlink', (p) => queueDelete(workspaceId, p))
        .on('unlinkDir', (p) => queueDelete(workspaceId, p))
        .on('error', (err) => console.error('[sync:watch-workspace] watcher error:', err));
    } catch (err) {
      console.error('[sync:watch-workspace] failed to start watcher:', (err as Error).message);
    }
  });

  ipcMain.handle('sync:unwatch-workspace', async (_event, workspaceId: string) => {
    await stopWorkspaceWatcher(workspaceId);
  });

  ipcMain.handle('sync:update-watch-options', async (_event, options: WriteWithSyncOptions) => {
    const ww = workspaceWatchers.get(options.workspaceId);
    if (ww) {
      ww.syncOptions = options;
    }
  });

  // --- Clipboard ---
  let clipboardImageCounter = 0;
  ipcMain.handle('clipboard:has-image', async () => {
    const image = clipboard.readImage();
    return !image.isEmpty();
  });

  // Materialize the clipboard image to a temp PNG and return its path (null when
  // the clipboard holds no image). Terminals type this path in — mimicking a file
  // drag-drop — so the AI CLI (Claude Code / Codex / Cursor) reads it as an image.
  // This is how image paste works everywhere EXCEPT the macOS native pasteboard
  // path: on Windows/Linux the CLI can't reach the OS clipboard through the PTY.
  //   target='wsl': the session runs inside WSL, so translate the Windows temp
  //   path (C:\…\file.png) to the /mnt/<drive>/… form the Linux CLI can open.
  ipcMain.handle(
    'clipboard:save-image-temp',
    async (_e, target?: 'wsl' | null): Promise<string | null> => {
      const image = clipboard.readImage();
      if (image.isEmpty()) return null;
      const png = image.toPNG();
      if (!png || png.length === 0) return null;

      const dir = path.join(tmpdir(), 'splitgrid-clipboard');
      await mkdir(dir, { recursive: true });

      // Best-effort prune of stale pastes (>1h) so this dir never grows unbounded.
      try {
        const now = Date.now();
        for (const name of await readdir(dir)) {
          const full = path.join(dir, name);
          const info = await stat(full).catch(() => null);
          if (info && now - info.mtimeMs > 60 * 60 * 1000) {
            await rm(full).catch(() => {});
          }
        }
      } catch {
        // Pruning is optional — never block a paste on cleanup failure.
      }

      clipboardImageCounter += 1;
      const file = path.join(dir, `paste-${Date.now()}-${clipboardImageCounter}.png`);
      await writeFile(file, png);

      if (target === 'wsl') {
        const m = /^([A-Za-z]):[\\/](.*)$/.exec(file);
        if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
      }
      return file;
    },
  );

  ipcMain.handle('clipboard:write-text', async (_e, text: string) => {
    if (typeof text === 'string' && text.length > 0) {
      clipboard.writeText(text);
    }
  });

  ipcMain.handle('clipboard:read-text', async () => {
    return clipboard.readText();
  });

  // --- API for main.ts ---
  return {
    closeSessionsForWindow(webContentsId: number) {
      const toClose: string[] = [];
      for (const [sessionId, ownerId] of sessionOwner) {
        if (ownerId === webContentsId) toClose.push(sessionId);
      }
      for (const sessionId of toClose) {
        terminalManager.closeSession(sessionId);
        sessionOwner.delete(sessionId);
      }
      // Clean up workspace watchers
      for (const [wid, ww] of workspaceWatchers) {
        ww.watcher.close();
        if (ww.debounceTimer) clearTimeout(ww.debounceTimer);
        workspaceWatchers.delete(wid);
      }
      // Clean up directory watchers
      for (const [did, dw] of dirWatchers) {
        dw.watcher.close();
        if (dw.debounceTimer) clearTimeout(dw.debounceTimer);
        dirWatchers.delete(did);
      }
      // Clean up file watchers
      for (const [fp, w] of fileWatchers) {
        w.close();
        fileWatchers.delete(fp);
      }
      // SFTP sessions are keyed by workspace, not window, so we can't scope them
      // to one window. When the LAST window closes (common on macOS, where the
      // app keeps running with no UI), reap every cached SFTP client so their
      // keepalives stop burning CPU in the background.
      if (BrowserWindow.getAllWindows().length === 0) {
        sftpSyncManager.closeAll();
      }
    },
    closeAllSftpSessions() {
      sftpSyncManager.closeAll();
    },
  } satisfies IPCHandlersAPI;
}
