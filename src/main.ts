import { app, BrowserWindow, Menu, shell, dialog, clipboard, systemPreferences } from 'electron';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';

// TEMP crash diagnostics: capture any catchable main-process failure (e.g. while
// creating a WSL terminal) to ~/splitgrid-terminal-debug.log alongside the shell
// manager's spawn trace. A native node-pty crash won't reach here.
function crashDbg(msg: string): void {
  try {
    appendFileSync(path.join(homedir(), 'splitgrid-terminal-debug.log'), `[${new Date().toISOString()}] [main] ${msg}\n`);
  } catch { /* best-effort */ }
}
process.on('unhandledRejection', (reason) => {
  crashDbg(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
import started from 'electron-squirrel-startup';
import { TerminalManager } from './main/terminal-manager';
import { ConnectionStore } from './main/connection-store';
import { WorkspaceStore } from './main/workspace-store';
import { registerIPCHandlers, type IPCHandlersAPI } from './main/ipc-handlers';
import { startActivityReceiver, stopActivityReceiver, addReceiverInterface } from './main/agent-activity-receiver';
import { detectWslDistros, wslHostInterfaceIp } from './main/wsl';
import { startBrowserBridge } from './main/agent-browser-bridge';
import { startTerminalBridge } from './main/agent-terminal-bridge';
import { startSqlBridge } from './main/agent-sql-bridge';
import { startFileBridge } from './main/agent-file-bridge';
import { initAgentIntegrations, migrateLegacyAgentArtifacts } from './main/agent-integrations';
import { AppSettingsStore } from './main/app-settings-store';
import { initWorkosAuth, handleDeepLinkArgv } from './main/workos-auth';
import { migrateLegacyUserData } from './main/userdata-migration';
import { TEMP_DISABLE_INPUT_INTERCEPTS } from './shared/runtime-flags';
import { getQuickChatHotkey, getFocusModeHotkey, isCapturingQuickChatHotkey } from './main/quick-chat-hotkey-state';
import { hotkeyMatchesInput } from './shared/quick-chat-hotkey';





if (started) {
  app.quit();
}

// Single-instance: a second launch must NOT spawn another process. Two processes
// would fight over the OTel receiver port (19558), and because Codex's telemetry
// endpoint is a single global port (~/.codex/config.toml), cross-process routing
// can't work regardless. Instead, the already-running instance opens a fresh
// window (matching the in-app "Open New Window" behaviour). Multiple environments
// already live as multiple windows inside one process.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// Prevent SSH/SFTP connection errors from crashing the entire app.
// These are recoverable — the SFTPSyncManager will reconnect on next attempt.
process.on('uncaughtException', (err) => {
  const msg = err?.message ?? '';
  crashDbg(`uncaughtException: ${err?.stack ?? msg}`);
  if (
    msg.includes('Connection terminated') ||
    msg.includes('ECONNRESET') ||
    msg.includes('EPIPE') ||
    msg.includes('Channel open failure') ||
    msg.includes('Keepalive timeout')
  ) {
    console.warn('[main] suppressed SSH error:', msg);
    return;
  }
  // Re-throw non-SSH errors so they surface normally
  console.error('[main] uncaughtException:', err);
  throw err;
});

// xterm's fast renderer depends on hardware accelerated WebGL. Keep GPU
// acceleration enabled by default; use SPLITGRID_DISABLE_GPU=1 only as a fallback
// for machines that still hit Electron GPU compositor instability.
if (process.env.SPLITGRID_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
} else {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

const terminalManager = new TerminalManager();
let connectionStore: ConnectionStore;
let workspaceStore: WorkspaceStore;
let ipcAPI: IPCHandlersAPI;
const windowSetByWebContentsId = new Map<number, string>();
const DEFAULT_WORKSPACE_SET_ID = 'default';
const createTransientEnvironmentRef = () => `env-${Date.now().toString(36)}`;

const focusWindow = (win: BrowserWindow) => {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
};

const openEnvironmentPickerInFocusedWindow = () => {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && !focused.webContents.isDestroyed()) {
    focused.webContents.send('environment:open-picker');
    return;
  }
  const created = createWindow();
  created.window.webContents.once('did-finish-load', () => {
    if (!created.window.isDestroyed() && !created.window.webContents.isDestroyed()) {
      created.window.webContents.send('environment:open-picker');
    }
  });
};

const broadcastEnvironmentStateChanged = () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send('environment:state-changed');
  }
};

const findWindowByEnvironmentId = (environmentId: string): BrowserWindow | null => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    const mapped = windowSetByWebContentsId.get(win.webContents.id);
    if (mapped === environmentId) return win;
  }
  return null;
};

const listOpenEnvironmentIds = (): string[] =>
  Array.from(new Set(windowSetByWebContentsId.values()));

const loadWindowContent = (win: BrowserWindow, query?: Record<string, string>) => {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    win.loadURL(url.toString());
    return;
  }
  win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
    query,
  });
};

const buildApplicationMenu = () => {
  const recentPaths = workspaceStore?.listRecentEnvironmentPaths?.() ?? [];
  const openRecentSubmenu: Electron.MenuItemConstructorOptions[] =
    recentPaths.length > 0
      ? recentPaths.map((envPath) => ({
          label: path.basename(envPath),
          sublabel: envPath,
          enabled: !findWindowByEnvironmentId(workspaceStore.toEnvironmentRefFromPath(envPath)),
          click: () => {
            const envRef = workspaceStore.toEnvironmentRefFromPath(envPath);
            openWorkspaceWindow(envRef);
          },
        }))
      : [{ label: 'No Recent Environments', enabled: false }];

  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => openWorkspaceWindow(createTransientEnvironmentRef()),
        },
        { type: 'separator' },
        {
          label: 'Open Env...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            openEnvironmentPickerInFocusedWindow();
          },
        },
        {
          label: 'Open Recent',
          submenu: openRecentSubmenu,
        },
        { type: 'separator' },
        { role: 'close', label: 'Close Window' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Window',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            BrowserWindow.getFocusedWindow()?.reload();
          },
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Reset Workspace Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (!focused || focused.isDestroyed() || focused.webContents.isDestroyed()) return;
            focused.webContents.send('container-zoom', 'reset');
          },
        },
        {
          label: 'Zoom Workspace In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (!focused || focused.isDestroyed() || focused.webContents.isDestroyed()) return;
            focused.webContents.send('container-zoom', 'in');
          },
        },
        {
          label: 'Zoom Workspace Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (!focused || focused.isDestroyed() || focused.webContents.isDestroyed()) return;
            focused.webContents.send('container-zoom', 'out');
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  return template;
};

const refreshApplicationMenu = () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenu()));
};

const createWindow = (setId = DEFAULT_WORKSPACE_SET_ID) => {
  const normalizedSetId = (setId || DEFAULT_WORKSPACE_SET_ID).trim() || DEFAULT_WORKSPACE_SET_ID;
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'SplitGrid',
    // Title bar per platform — the custom WorkspaceBar provides the drag region
    // (and, on Linux, the min/max/close controls):
    //   • macOS: hiddenInset — keep the inset native traffic lights.
    //   • Linux: frameless — `titleBarStyle:'hiddenInset'` is a macOS-only value
    //     and is ignored on Linux (the native header would show through), so drop
    //     the frame entirely.
    //   • Windows: keep the native frame (WorkspaceBar is hidden there).
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    ...(process.platform === 'linux' ? { frame: false } : {}),
    backgroundColor: '#141414',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  const webContentsId = win.webContents.id;
  windowSetByWebContentsId.set(webContentsId, normalizedSetId);
  refreshApplicationMenu();
  broadcastEnvironmentStateChanged();

  // A window.open() in the app renderer (e.g. clicking a URL in a terminal via
  // xterm's web-links addon) otherwise makes Electron spawn a blank in-app
  // BrowserWindow — which reads as a stray second SplitGrid window. Never open
  // app windows from renderer requests: route web/mail links to the OS browser
  // and deny everything else.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  loadWindowContent(win);

  // Disable app/window close via Cmd/Ctrl+W and reload via Cmd/Ctrl+R.
  win.webContents.on('before-input-event', (event, input) => {
    // The Fast chat palette hotkey (default ⌘/Ctrl+K, user-configurable). Handled
    // in main (not the renderer's window keydown) so it fires no matter which
    // inner surface has focus — terminals, the Monaco editor (which would
    // otherwise swallow the chord), etc. Webview guests get the same treatment in
    // the web-contents-created handler.
    if (!isCapturingQuickChatHotkey() && hotkeyMatchesInput(getQuickChatHotkey(), input)) {
      event.preventDefault();
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('quick-chat:toggle');
      return;
    }
    if (TEMP_DISABLE_INPUT_INTERCEPTS) return;
    const key = input.key.toLowerCase();
    if ((input.meta || input.control) && (key === 'w' || key === 'r')) {
      event.preventDefault();
    }
    if ((input.meta || input.control) && input.shift && key === 'n') {
      event.preventDefault();
      createWindow(createTransientEnvironmentRef());
    }
  });

  // Self-heal if renderer process exits unexpectedly.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] renderer process gone:', details.reason);
    if (!win.isDestroyed()) {
      win.reload();
    }
  });

  const safeSendToWindow = (channel: string, ...args: unknown[]) => {
    if (win.isDestroyed()) return;
    if (win.webContents.isDestroyed()) return;
    win.webContents.send(channel, ...args);
  };
  win.on('enter-full-screen', () => {
    safeSendToWindow('window:fullscreen-change', true);
  });
  win.on('leave-full-screen', () => {
    safeSendToWindow('window:fullscreen-change', false);
  });

  win.on('closed', () => {
    // Kill all PTY sessions owned by this window to prevent orphan processes
    ipcAPI?.closeSessionsForWindow(webContentsId);
    windowSetByWebContentsId.delete(webContentsId);
    refreshApplicationMenu();
    broadcastEnvironmentStateChanged();
  });
  return { window: win, setId: normalizedSetId };
};

const openWorkspaceWindow = (setId?: string) => {
  const targetSetId =
    setId && setId.trim().length > 0
      ? setId.trim()
      : createTransientEnvironmentRef();
  const existing = findWindowByEnvironmentId(targetSetId);
  if (existing) {
    focusWindow(existing);
    return { setId: targetSetId };
  }
  return createWindow(targetSetId);
};

// A second launch of the binary lands here (we hold the single-instance lock):
// open a new window in this process instead of starting a rival one.
if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    // Not every "second instance" is the user opening the app. On Windows,
    // node-pty (ConPTY) enumerates the console process list by spawning its
    // `conpty_console_list_agent` helper via process.execPath — i.e. SplitGrid.exe.
    // With the RunAsNode fuse disabled, that boots a full Electron instance
    // instead of a Node script, firing this event whenever a terminal is
    // used/closed. Chromium likewise relaunches its own helpers (--type=...).
    // None of these are a user launch, so they must not spawn a window.
    const isInternalRelaunch = Array.isArray(argv) && argv.some((a) =>
      typeof a === 'string' && (a.startsWith('--type=') || a.includes('conpty_console_list_agent')));
    if (isInternalRelaunch) return;
    // A WorkOS login callback (workos-auth://) lands here on Windows/Linux as a
    // launch argument: handle the OAuth exchange and focus an existing window
    // instead of opening a new one.
    if (handleDeepLinkArgv(argv)) {
      const existing = BrowserWindow.getAllWindows()[0];
      if (existing) focusWindow(existing);
      return;
    }
    openWorkspaceWindow();
  });
}

app.on('ready', () => {
  // A second launch (incl. node-pty's conpty agent running SplitGrid.exe as a
  // pseudo-node) reaches here too; without the lock it must do nothing but quit,
  // so it never builds windows/stores or flashes a stray window.
  if (!gotSingleInstanceLock) {
    app.quit();
    return;
  }
  app.setName('SplitGrid');

  // One-time rename migration: bring forward the previous version's data
  // (settings, saved connections + passwords, workspaces) before any store
  // reads. No-op once migrated or on a fresh install.
  migrateLegacyUserData();
  // Remove agent skills/hooks the previous (differently-named) build installed
  // into ~/.claude & ~/.codex so they don't linger beside the renamed ones.
  migrateLegacyAgentArtifacts();

  connectionStore = new ConnectionStore();
  workspaceStore = new WorkspaceStore();
  refreshApplicationMenu();
  ipcAPI = registerIPCHandlers(terminalManager, connectionStore, workspaceStore, {
    getWindowByWebContentsId: (id) =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.id === id) ?? null,
    getWorkspaceSetIdByWebContentsId: (id) =>
      windowSetByWebContentsId.get(id) ?? DEFAULT_WORKSPACE_SET_ID,
    openWorkspaceWindow: (setId) => {
      return openWorkspaceWindow(setId);
    },
    listEnvironments: () => workspaceStore.listEnvironments(),
    listOpenEnvironmentIds: () => listOpenEnvironmentIds(),
    isEnvironmentOpen: (environmentId) => !!findWindowByEnvironmentId(environmentId),
    addRecentEnvironmentPath: (filePath) => workspaceStore.addRecentEnvironmentPath(filePath),
    toEnvironmentRefFromPath: (filePath) => workspaceStore.toEnvironmentRefFromPath(filePath),
    onRecentEnvironmentsChanged: () => refreshApplicationMenu(),
    setEnvironmentName: (envId, name) => workspaceStore.setEnvironmentName(envId, name),
    deleteEnvironment: (envId) => workspaceStore.deleteEnvironment(envId),
  });
  createWindow();
  startActivityReceiver();
  // If WSL distros are installed, add a receiver listener on the WSL vEthernet IP
  // so agents inside a distro (default NAT networking, which reaches the host via
  // that gateway) can report. Host↔WSL subnet only — never widened to the LAN.
  // Async + non-blocking: the first `wsl -l` wakes the WSL service; native
  // terminals keep using 127.0.0.1 throughout. No-op under mirrored networking
  // (no such adapter) where 127.0.0.1 already reaches the host.
  if (process.platform === 'win32') {
    detectWslDistros()
      .then((distros) => {
        const ip = distros.length ? wslHostInterfaceIp() : undefined;
        if (ip) addReceiverInterface(ip);
      })
      .catch(() => { /* no WSL / detection failed — stay on loopback */ });
  }
  // Agent browser control: register the IPC result channel + screenshot scratch.
  startBrowserBridge();
  // Agent terminal control: register the IPC result channel for the relay that
  // lets an agent drive/inspect the other terminals in its workspace.
  startTerminalBridge();
  // Agent SQL control: register the IPC result channel for the relay that lets an
  // agent query/inspect/export against the SQL component in its workspace.
  startSqlBridge();
  // WSL file bridge: hooks/browser requests from inside a distro arrive as files
  // (the localhost receiver is unreachable across the NAT + Windows Firewall).
  startFileBridge();
  // Web streaming auth: register the workos-auth:// protocol, the macOS deep-link
  // listener, and the auth IPC. Login is always initiated from the running app,
  // so the OAuth callback arrives here (open-url / second-instance) post-ready.
  initWorkosAuth();
  // Agent integrations (lifecycle hooks, the splitgrid-browser skill, WSL copies,
  // and the SPLITGRID_* terminal env) are a single opt-in: on launch we apply the
  // user's persisted choice and otherwise touch nothing. Default is off.
  const persistedSettings = new AppSettingsStore().get();
  initAgentIntegrations(
    persistedSettings.agentIntegrations ?? false,
    persistedSettings.agentTerminalControl ?? false,
    persistedSettings.agentSqlControl ?? false,
    persistedSettings.agentSqlWrite ?? false,
  );
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cmd+Q / menu Quit / programmatic quit: confirm before tearing everything down,
// since quitting closes every window's terminals and SSH sessions. Skip the
// prompt when there are no windows (startup single-instance/squirrel quits, or
// after all windows were already closed). Cleanup runs only once the user
// confirms, so cancelling leaves the running sessions untouched.
let quitConfirmed = false;
app.on('before-quit', (event) => {
  if (quitConfirmed || BrowserWindow.getAllWindows().length === 0) {
    stopActivityReceiver();
    terminalManager.shutdownForAppExit();
    ipcAPI?.closeAllSftpSessions();
    return;
  }
  event.preventDefault();
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const choice = dialog.showMessageBoxSync(focused, {
    type: 'question',
    buttons: ['Cancel', 'Quit'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    message: 'Quit SplitGrid?',
    detail: 'This closes all windows and ends every terminal and SSH session.',
  });
  if (choice === 1) {
    quitConfirmed = true;
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Prevent Cmd/Ctrl+W from closing app window when focus is inside <webview>.
// Keep other webview shortcuts isolated to browser content.
// Permissions granted to browser-pane guest pages. `media` is the umbrella
// getUserMedia permission (Chromium reports mic/camera as 'media'); the *Capture
// entries cover Electron builds that split them out. The rest are the everyday
// web capabilities a general-purpose browser is expected to have.
const GRANTED_GUEST_PERMISSIONS = new Set<string>([
  'media',
  'audioCapture',
  'videoCapture',
  'mediaKeySystem',
  'fullscreen',
  'clipboard-read',
  'clipboard-sanitized-write',
  'pointerLock',
  'display-capture',
]);

function configureGuestPermissions(sess: Electron.Session): void {
  sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const allow = GRANTED_GUEST_PERMISSIONS.has(permission);
    // On macOS the renderer's getUserMedia only succeeds once the app itself
    // holds OS-level (TCC) mic/camera access. Await the system prompt (its text
    // comes from the Info.plist usage strings in extendInfo) before resolving,
    // so the very first request doesn't race the dialog and fail. Only ask for
    // the media type actually requested.
    if (allow && process.platform === 'darwin' && permission === 'media') {
      const kinds: Array<'microphone' | 'camera'> = [];
      const mediaTypes = (details as { mediaTypes?: string[] })?.mediaTypes ?? ['audio'];
      if (mediaTypes.includes('audio')) kinds.push('microphone');
      if (mediaTypes.includes('video')) kinds.push('camera');
      void (async () => {
        for (const kind of kinds) {
          try { await systemPreferences.askForMediaAccess(kind); }
          catch { /* denied / unavailable — still let the web request resolve */ }
        }
        callback(true);
      })();
      return;
    }
    callback(allow);
  });
  sess.setPermissionCheckHandler((_wc, permission) => GRANTED_GUEST_PERMISSIONS.has(permission));
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  // Same guard as the app window: a target=_blank / window.open inside a browser
  // pane must not spawn a SplitGrid-chrome window. Send web/mail links to the OS
  // browser; deny the rest.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  // Media (mic/camera) + related permissions for guest pages. Without a handler
  // Electron denies getUserMedia by default, so audio/video input never works in
  // the browser pane (voice/video calls, dictation, WebRTC). The webview session
  // is shared per-partition; setting the same pure handler on each webview
  // attach just overwrites it, which is harmless. Configured here (not once per
  // partition) so custom per-workspace partitions are covered automatically.
  configureGuestPermissions(contents.session);
  // Guest webviews get no context menu by default — build a standard one so the
  // user can copy/paste, navigate, reload and (crucially) inspect via DevTools.
  contents.on('context-menu', (_e, params) => {
    const canCopy = !!params.editFlags?.canCopy && !!params.selectionText;
    const canPaste = !!params.editFlags?.canPaste;
    const canCut = !!params.editFlags?.canCut && !!params.selectionText;
    const { isEditable, linkURL } = params;

    const template: Electron.MenuItemConstructorOptions[] = [];

    if (linkURL) {
      // linkURL is page-controlled — only hand web/mail schemes to the OS
      // (mirrors the setWindowOpenHandler allowlist); never file:// or custom
      // protocol handlers, which shell.openExternal would happily launch.
      let safeLinkURL: string | null = null;
      try {
        const u = new URL(linkURL);
        if (/^(https?|mailto):$/i.test(u.protocol)) safeLinkURL = u.toString();
      } catch { /* unparseable URL — leave disallowed */ }

      if (safeLinkURL) {
        template.push({ label: 'Open Link in Browser', click: () => { void shell.openExternal(safeLinkURL!); } });
      }
      template.push(
        { label: 'Copy Link Address', click: () => clipboard.writeText(linkURL) },
        { type: 'separator' },
      );
    }

    if (isEditable || canCopy) {
      if (canCut) template.push({ label: 'Cut', role: 'cut' });
      template.push({ label: 'Copy', role: 'copy', enabled: canCopy });
      if (isEditable) template.push({ label: 'Paste', role: 'paste', enabled: canPaste });
      template.push({ type: 'separator' });
    }

    template.push(
      { label: 'Back', enabled: contents.canGoBack(), click: () => contents.goBack() },
      { label: 'Forward', enabled: contents.canGoForward(), click: () => contents.goForward() },
      { label: 'Reload', click: () => contents.reload() },
      { type: 'separator' },
      { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) },
      {
        label: contents.isDevToolsOpened() ? 'Close DevTools' : 'Open DevTools',
        click: () => {
          if (contents.isDevToolsOpened()) contents.closeDevTools();
          else contents.openDevTools({ mode: 'detach' });
        },
      },
    );

    Menu.buildFromTemplate(template).popup();
  });
  contents.on('before-input-event', (event, input) => {
    // The Fast chat hotkey from inside a browser pane (a separate web contents
    // whose keys never reach the host window) — forward the toggle to the
    // embedder window.
    if (!isCapturingQuickChatHotkey() && hotkeyMatchesInput(getQuickChatHotkey(), input)) {
      event.preventDefault();
      const host = contents.hostWebContents;
      if (host && !host.isDestroyed()) host.send('quick-chat:toggle');
      return;
    }
    // Focus-mode toggle hotkey from inside a browser pane: its keys never reach
    // the host window's keydown listener, so forward it like the Fast chat
    // hotkey. The host window covers all other surfaces directly.
    if (!isCapturingQuickChatHotkey() && hotkeyMatchesInput(getFocusModeHotkey(), input)) {
      event.preventDefault();
      const host = contents.hostWebContents;
      if (host && !host.isDestroyed()) host.send('focus-mode:toggle');
      return;
    }
    if (TEMP_DISABLE_INPUT_INTERCEPTS) return;
    const key = input.key.toLowerCase();
    const isReloadShortcut =
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      key === 'r';
    const isCloseShortcut =
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      key === 'w';
    if (isReloadShortcut) {
      event.preventDefault();
      if (!contents.isDestroyed()) {
        contents.reload();
      }
      return;
    }
    if (isCloseShortcut) {
      event.preventDefault();
    }
  });
});

