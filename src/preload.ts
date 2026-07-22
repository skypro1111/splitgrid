import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import type { ElectronAPI, SftpTransferProgress } from './shared/types';

const api: ElectronAPI = {
  // SSH session
  createSession: (config) => ipcRenderer.invoke('terminal:create-ssh', config),
  // Local terminal
  createLocalTerminal: (config) => ipcRenderer.invoke('terminal:create-local', config),
  // Common
  closeSession: (sessionId) => ipcRenderer.invoke('terminal:close', sessionId),
  sendData: (sessionId, data) => ipcRenderer.send('terminal:send-data', sessionId, data),
  resize: (sessionId, cols, rows) => ipcRenderer.send('terminal:resize', sessionId, cols, rows),

  // Events
  onData: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, data: string) =>
      callback(id, data);
    ipcRenderer.on('terminal:on-data', handler);
    return () => ipcRenderer.removeListener('terminal:on-data', handler);
  },
  onSessionReady: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string) => callback(id);
    ipcRenderer.on('terminal:on-ready', handler);
    return () => ipcRenderer.removeListener('terminal:on-ready', handler);
  },
  onSessionClosed: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, exitedCleanly: boolean) => callback(id, exitedCleanly);
    ipcRenderer.on('terminal:on-close', handler);
    return () => ipcRenderer.removeListener('terminal:on-close', handler);
  },
  onError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, msg: string) => callback(id, msg);
    ipcRenderer.on('terminal:on-error', handler);
    return () => ipcRenderer.removeListener('terminal:on-error', handler);
  },
  onClaudeResponse: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on('terminal:claude-response', handler);
    return () => ipcRenderer.removeListener('terminal:claude-response', handler);
  },

  // Saved connections
  getSavedConnections: () => ipcRenderer.invoke('connections:list'),
  saveConnection: (config) => ipcRenderer.invoke('connections:save', config),
  updateConnection: (id, config) => ipcRenderer.invoke('connections:update', id, config),
  deleteSavedConnection: (id) => ipcRenderer.invoke('connections:delete', id),
  connectSaved: (id) => ipcRenderer.invoke('connections:connect', id),
  testSavedConnection: (id) => ipcRenderer.invoke('connections:test', id),
  applyMouseScrollToHost: (id) => ipcRenderer.invoke('connections:apply-mouse-scroll', id),
  forgetHostKey: (host, port) => ipcRenderer.invoke('connections:forget-host-key', host, port),

  // Session recovery
  getActiveSessions: () => ipcRenderer.invoke('terminal:get-active'),
  getSessionBuffer: (sessionId) => ipcRenderer.invoke('terminal:get-buffer', sessionId),
  getResourceSnapshot: () => ipcRenderer.invoke('diagnostics:get-resource-snapshot'),
  killProcess: (sessionId, pid, signal) => ipcRenderer.invoke('diagnostics:kill-process', { sessionId, pid, signal }),
  getTerminalProcessTree: (sessionId) => ipcRenderer.invoke('terminal:get-process-tree', sessionId),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  freezeWorkspace: (sessionIds) => ipcRenderer.invoke('workspace:freeze', sessionIds),
  unfreezeWorkspace: (sessionIds) => ipcRenderer.invoke('workspace:unfreeze', sessionIds),

  // File system
  readDirectory: (dirPath) => ipcRenderer.invoke('fs:read-directory', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', filePath, content),
  writeFileWithSync: (filePath, content, options) =>
    ipcRenderer.invoke('fs:write-file-with-sync', filePath, content, options),
  moveFile: (src, dest) => ipcRenderer.invoke('fs:move', src, dest),
  moveFileWithSync: (src, dest, options) =>
    ipcRenderer.invoke('fs:move-with-sync', src, dest, options),
  createFile: (filePath) => ipcRenderer.invoke('fs:create-file', filePath),
  createDirectory: (dirPath) => ipcRenderer.invoke('fs:create-directory', dirPath),
  createFileWithSync: (filePath, options) =>
    ipcRenderer.invoke('fs:create-file-with-sync', filePath, options),
  createDirectoryWithSync: (dirPath, options) =>
    ipcRenderer.invoke('fs:create-directory-with-sync', dirPath, options),
  copyFile: (src, dest) => ipcRenderer.invoke('fs:copy', src, dest),
  statFile: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
  trashItem: (filePath) => ipcRenderer.invoke('fs:trash', filePath),
  trashItemWithSync: (filePath, options) =>
    ipcRenderer.invoke('fs:trash-with-sync', filePath, options),
  runWorkspaceSyncNow: (options) => ipcRenderer.invoke('sync:run-now', options),
  sftpPushPaths: (filePaths: string[], options: any) =>
    ipcRenderer.invoke('sftp:push-paths', filePaths, options),
  sftpPullPaths: (localPaths: string[], options: any) =>
    ipcRenderer.invoke('sftp:pull-paths', localPaths, options),
  cancelSftpSync: (syncId: string) => ipcRenderer.invoke('sftp:cancel-sync', syncId),
  onSftpProgress: (callback: (info: { direction: 'push' | 'pull'; file: string; current: number; total: number }) => void) => {
    const handler = (_event: any, info: any) => callback(info);
    ipcRenderer.on('sftp:progress', handler);
    return () => { ipcRenderer.removeListener('sftp:progress', handler); };
  },

  // SFTP file manager (per-pane remote browsing)
  sftpStatDir: (target, path) => ipcRenderer.invoke('sftp:stat-dir', target, path),
  sftpMkdir: (target, path) => ipcRenderer.invoke('sftp:mkdir', target, path),
  sftpRename: (target, oldPath, newPath) => ipcRenderer.invoke('sftp:rename', target, oldPath, newPath),
  sftpDeletePath: (target, path) => ipcRenderer.invoke('sftp:delete-path', target, path),
  sftpReadFile: (target, path) => ipcRenderer.invoke('sftp:read-file', target, path),
  sftpWriteFile: (target, path, content) => ipcRenderer.invoke('sftp:write-file', target, path, content),
  sftpRealpath: (target, path) => ipcRenderer.invoke('sftp:realpath', target, path),

  // SFTP file manager: local listing + cross-pane transfers
  statDirectory: (dirPath) => ipcRenderer.invoke('fs:stat-directory', dirPath),
  homeDir: () => ipcRenderer.invoke('fs:home-dir'),
  sftpUpload: (target, localPaths, remoteDir, transferId) =>
    ipcRenderer.invoke('sftp:fm-upload', target, localPaths, remoteDir, transferId),
  sftpDownload: (target, items, localDir, transferId) =>
    ipcRenderer.invoke('sftp:fm-download', target, items, localDir, transferId),
  cancelSftpTransfer: (transferId) => ipcRenderer.invoke('sftp:cancel-transfer', transferId),
  onSftpFmProgress: (cb: (info: SftpTransferProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, info: SftpTransferProgress) => cb(info);
    ipcRenderer.on('sftp:fm-progress', handler);
    return () => { ipcRenderer.removeListener('sftp:fm-progress', handler); };
  },

  // File watching
  watchFile: (filePath: string) => ipcRenderer.invoke('fs:watch-file', filePath),
  unwatchFile: (filePath: string) => ipcRenderer.invoke('fs:unwatch-file', filePath),
  onFileChanged: (callback: (filePath: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, filePath: string) => callback(filePath);
    ipcRenderer.on('fs:file-changed', handler);
    return () => ipcRenderer.removeListener('fs:file-changed', handler);
  },

  // Directory watching (recursive — for file tree + editor live reload)
  watchDirectory: (watchId: string, dirPath: string) => ipcRenderer.invoke('fs:watch-directory', watchId, dirPath),
  unwatchDirectory: (watchId: string) => ipcRenderer.invoke('fs:unwatch-directory', watchId),
  onDirectoriesChanged: (callback: (dirs: string[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, dirs: string[]) => callback(dirs);
    ipcRenderer.on('fs:directories-changed', handler);
    return () => ipcRenderer.removeListener('fs:directories-changed', handler);
  },
  onFilesChanged: (callback: (files: string[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, files: string[]) => callback(files);
    ipcRenderer.on('fs:files-changed', handler);
    return () => ipcRenderer.removeListener('fs:files-changed', handler);
  },

  // Workspace auto-sync watcher
  syncWatchWorkspace: (options: any) => ipcRenderer.invoke('sync:watch-workspace', options),
  syncUnwatchWorkspace: (workspaceId: string) => ipcRenderer.invoke('sync:unwatch-workspace', workspaceId),
  syncUpdateWatchOptions: (options: any) => ipcRenderer.invoke('sync:update-watch-options', options),
  onAutoSynced: (callback: (info: { workspaceId: string; synced: number; removed: number; errors: number; total: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, info: any) => callback(info);
    ipcRenderer.on('sync:auto-synced', handler);
    return () => ipcRenderer.removeListener('sync:auto-synced', handler);
  },

  // Dialogs
  selectPrivateKeyFile: () => ipcRenderer.invoke('dialog:select-private-key'),
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  clipboardHasImage: () => ipcRenderer.invoke('clipboard:has-image'),
  clipboardSaveImageTemp: (target?: 'wsl' | null) =>
    ipcRenderer.invoke('clipboard:save-image-temp', target ?? null),
  clipboardReadFilePaths: (target?: 'wsl' | null) =>
    ipcRenderer.invoke('clipboard:read-file-paths', target ?? null),
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text'),
  // Electron 32+ removed File.path; this is the supported way to resolve the
  // absolute path of a dropped/selected OS file (used by drag-and-drop).
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Window zoom
  getWindowZoom: () => webFrame.getZoomLevel(),
  setWindowZoom: (level) => webFrame.setZoomLevel(level),

  // Fullscreen
  onFullScreenChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, isFullScreen: boolean) => callback(isFullScreen);
    ipcRenderer.on('window:fullscreen-change', handler);
    return () => ipcRenderer.removeListener('window:fullscreen-change', handler);
  },
  onEnvironmentStateChange: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('environment:state-changed', handler);
    return () => ipcRenderer.removeListener('environment:state-changed', handler);
  },
  onOpenEnvironmentPicker: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('environment:open-picker', handler);
    return () => ipcRenderer.removeListener('environment:open-picker', handler);
  },

  // Per-container zoom
  onContainerZoom: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, direction: 'in' | 'out' | 'reset') => callback(direction);
    ipcRenderer.on('container-zoom', handler);
    return () => ipcRenderer.removeListener('container-zoom', handler);
  },

  onFocusModeToggle: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('focus-mode:toggle', handler);
    return () => ipcRenderer.removeListener('focus-mode:toggle', handler);
  },

  getWorkspaceSetContext: () => ipcRenderer.invoke('workspace-set:get-context'),
  openWorkspaceSetWindow: (setId) => ipcRenderer.invoke('workspace-set:open-window', setId),
  listEnvironments: () => ipcRenderer.invoke('environment:list'),
  pickEnvironmentFile: () => ipcRenderer.invoke('environment:pick-file'),
  setEnvironmentName: (environmentId, name) =>
    ipcRenderer.invoke('environment:set-name', environmentId, name),
  deleteEnvironment: (environmentId) =>
    ipcRenderer.invoke('environment:delete', environmentId),

  // SQL
  sqlConnect: (config) => ipcRenderer.invoke('sql:connect', config),
  sqlTestConnection: (config) => ipcRenderer.invoke('sql:test-connection', config),
  sqlConnectSaved: (savedId) => ipcRenderer.invoke('sql:connect-saved', savedId),
  sqlConnectSavedToDatabase: (savedId, database) =>
    ipcRenderer.invoke('sql:connect-saved-database', savedId, database),
  sqlDisconnect: (connectionId) => ipcRenderer.invoke('sql:disconnect', connectionId),
  sqlExecute: (connectionId, sql) => ipcRenderer.invoke('sql:execute', connectionId, sql),
  sqlListSchemas: (connectionId) => ipcRenderer.invoke('sql:list-schemas', connectionId),
  sqlListDatabases: (connectionId) => ipcRenderer.invoke('sql:list-databases', connectionId),
  sqlListColumns: (connectionId) => ipcRenderer.invoke('sql:list-columns', connectionId),
  sqlGetDdl: (connectionId, schema, name, kind) =>
    ipcRenderer.invoke('sql:get-ddl', connectionId, schema, name, kind),
  sqlGetPrimaryKey: (connectionId, schema, table) =>
    ipcRenderer.invoke('sql:get-primary-key', connectionId, schema, table),
  sqlListIndexes: (connectionId, schema, table) =>
    ipcRenderer.invoke('sql:list-indexes', connectionId, schema, table),
  sqlListKeys: (connectionId, schema, table) =>
    ipcRenderer.invoke('sql:list-keys', connectionId, schema, table),
  sqlListTriggers: (connectionId, schema, table) =>
    ipcRenderer.invoke('sql:list-triggers', connectionId, schema, table),
  sqlRenameObject: (connectionId, kind, schema, name, newName) =>
    ipcRenderer.invoke('sql:rename-object', connectionId, kind, schema, name, newName),
  sqlDropObject: (connectionId, kind, schema, name, opts) =>
    ipcRenderer.invoke('sql:drop-object', connectionId, kind, schema, name, opts),
  sqlApplyEdits: (connectionId, changes) =>
    ipcRenderer.invoke('sql:apply-edits', connectionId, changes),
  sqlBeginTx: (connectionId) => ipcRenderer.invoke('sql:begin-tx', connectionId),
  sqlCommitTx: (connectionId) => ipcRenderer.invoke('sql:commit-tx', connectionId),
  sqlRollbackTx: (connectionId) => ipcRenderer.invoke('sql:rollback-tx', connectionId),
  sqlExport: (connectionId, options) => ipcRenderer.invoke('sql:export', connectionId, options),
  sqlImportRows: (connectionId, request) => ipcRenderer.invoke('sql:import-rows', connectionId, request),
  sqlPickImportFile: () => ipcRenderer.invoke('sql:pick-import-file'),
  sqlGetSavedConnections: () => ipcRenderer.invoke('sql-connections:list'),
  sqlSaveConnection: (connection) => ipcRenderer.invoke('sql-connections:save', connection),
  sqlUpdateConnection: (savedId, patch) => ipcRenderer.invoke('sql-connections:update', savedId, patch),
  sqlDeleteConnection: (savedId) => ipcRenderer.invoke('sql-connections:delete', savedId),

  loadWorkspaceState: () => ipcRenderer.invoke('workspace-state:load'),
  saveWorkspaceState: (state) => ipcRenderer.invoke('workspace-state:save', state),
  listRecentWorkspaces: () => ipcRenderer.invoke('workspace-recent:list'),
  addRecentWorkspace: (workspace) => ipcRenderer.invoke('workspace-recent:add', workspace),

  getAppSettings: () => ipcRenderer.invoke('app-settings:get'),
  saveAppSettings: (settings) => ipcRenderer.invoke('app-settings:save', settings),
  listShells: () => ipcRenderer.invoke('shells:list'),

  // Fast chat (OpenAI-compatible streaming)
  fastChatAsk: (requestId, messages, model) => ipcRenderer.invoke('quick-chat:ask', requestId, messages, model),
  fastChatCancel: (requestId) => ipcRenderer.send('quick-chat:cancel', requestId),
  quickChatSetCapturing: (capturing) => ipcRenderer.send('quick-chat:set-capturing', capturing),
  onToggleQuickChat: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('quick-chat:toggle', handler);
    return () => ipcRenderer.removeListener('quick-chat:toggle', handler);
  },
  onFastChatChunk: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { requestId: string; delta: string }) => callback(payload);
    ipcRenderer.on('quick-chat:chunk', handler);
    return () => ipcRenderer.removeListener('quick-chat:chunk', handler);
  },
  onFastChatDone: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { requestId: string }) => callback(payload);
    ipcRenderer.on('quick-chat:done', handler);
    return () => ipcRenderer.removeListener('quick-chat:done', handler);
  },
  onFastChatError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { requestId: string; error: string }) => callback(payload);
    ipcRenderer.on('quick-chat:error', handler);
    return () => ipcRenderer.removeListener('quick-chat:error', handler);
  },
  quickChatHistoryList: () => ipcRenderer.invoke('quick-chat-history:list'),
  quickChatHistorySave: (conversation) => ipcRenderer.invoke('quick-chat-history:save', conversation),
  quickChatHistoryDelete: (id) => ipcRenderer.invoke('quick-chat-history:delete', id),
  quickChatHistoryClear: () => ipcRenderer.invoke('quick-chat-history:clear'),

  // Agent activity (working/idle/waiting) reported by lifecycle hooks per terminal
  getClaudeActivity: () => ipcRenderer.invoke('claude-activity:get'),
  onAgentNotify: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on('agent:notify', handler);
    return () => ipcRenderer.removeListener('agent:notify', handler);
  },
  onTerminalWebInput: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on('terminal:web-input', handler);
    return () => ipcRenderer.removeListener('terminal:web-input', handler);
  },
  onClaudeActivity: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { terminalId: string; state: 'working' | 'idle' | 'waiting' }) => callback(payload);
    ipcRenderer.on('claude-activity:state', handler);
    return () => ipcRenderer.removeListener('claude-activity:state', handler);
  },

  // Agent browser control: main relays an agent's browser command here; the
  // renderer resolves the target webview, runs it, and replies via the result
  // channel keyed by reqId (the main-side bridge awaits it).
  onBrowserCommand: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { reqId: string; terminal: string; argv: string[] }) => callback(payload);
    ipcRenderer.on('browser:command', handler);
    return () => ipcRenderer.removeListener('browser:command', handler);
  },
  sendBrowserResult: (payload) => ipcRenderer.send('browser:result', payload),

  // Agent terminal control: main relays an agent's terminal command here; the
  // renderer resolves the caller's workspace, runs it against the in-scope
  // terminals, and replies via the result channel keyed by reqId.
  onTerminalCommand: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { reqId: string; terminal: string; argv: string[] }) => callback(payload);
    ipcRenderer.on('terminal-agent:command', handler);
    return () => ipcRenderer.removeListener('terminal-agent:command', handler);
  },
  sendTerminalResult: (payload) => ipcRenderer.send('terminal-agent:result', payload),

  // Agent SQL control: main relays an agent's SQL command here; the renderer
  // resolves the caller's workspace, runs it against the in-scope SQL
  // connections, and replies via the result channel keyed by reqId.
  onSqlCommand: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { reqId: string; terminal: string; argv: string[]; writeAllowed: boolean }) => callback(payload);
    ipcRenderer.on('sql:command', handler);
    return () => ipcRenderer.removeListener('sql:command', handler);
  },
  sendSqlResult: (payload) => ipcRenderer.send('sql:result', payload),

  // Agent SFTP access: main relays an agent's SFTP command here; the renderer
  // resolves the caller's workspace, picks the target host (a sync target or an
  // SSH pane), runs the transfer and replies keyed by reqId.
  onSftpCommand: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { reqId: string; terminal: string; argv: string[]; writeAllowed: boolean }) => callback(payload);
    ipcRenderer.on('sftp-agent:command', handler);
    return () => ipcRenderer.removeListener('sftp-agent:command', handler);
  },
  sendSftpResult: (payload) => ipcRenderer.send('sftp-agent:result', payload),

  // Static platform marker (resolved once at preload load time). Lets
  // renderer code branch on macOS vs Windows vs Linux without IPC churn.
  platform: process.platform,

  // Window controls for frameless platforms (Linux) — the custom WorkspaceBar
  // draws the buttons and drives this window via these.
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  isFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),

  // SSH saved-password prompt offer (payload carries no password).
  onSshPasswordPrompt: (callback: (p: { sessionId: string; label: string; source: 'sudo' | 'login' }) => void) => {
    const handler = (_e: unknown, p: { sessionId: string; label: string; source: 'sudo' | 'login' }) => callback(p);
    ipcRenderer.on('ssh:password-prompt', handler);
    return () => ipcRenderer.removeListener('ssh:password-prompt', handler);
  },
  applySshPassword: (sessionId: string) => ipcRenderer.send('ssh:apply-password', sessionId),

  // Web streaming auth (WorkOS). Tokens stay in main; the renderer only gets the
  // user profile via authGetSession / onAuthChanged.
  authGetSession: () => ipcRenderer.invoke('auth:get-session'),
  authLogin: () => ipcRenderer.invoke('auth:login'),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  onAuthChanged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, session: import('./shared/types').AuthSession | null) => callback(session);
    ipcRenderer.on('auth:changed', handler);
    return () => ipcRenderer.removeListener('auth:changed', handler);
  },

  // Web streaming producer: per-terminal share toggle + connection status.
  relaySetShare: (sessionId, enabled, meta) => ipcRenderer.send('relay:set-share', sessionId, enabled, meta),
  onRelayStatus: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, status: import('./shared/types').RelayStatus) => callback(status);
    ipcRenderer.on('relay:status', handler);
    return () => ipcRenderer.removeListener('relay:status', handler);
  },

  // file:// URL of the bundled webview focus-bridge preload. Resolved
  // synchronously at load so a <webview> can set its `preload` attribute before
  // attaching (a guest click can't reach the host window, so the preload posts a
  // host message to focus the owning pane). Empty string if unavailable.
  webviewPreloadUrl: (() => {
    try {
      return (ipcRenderer.sendSync('browser:webview-preload-url') as string) || '';
    } catch {
      return '';
    }
  })(),
};

contextBridge.exposeInMainWorld('electronAPI', api);
