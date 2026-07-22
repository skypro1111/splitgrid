import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTerminals } from './hooks/useTerminals';
import { useWorkspace } from './hooks/useWorkspace';
import { useClaudeActivity } from './hooks/useClaudeActivity';
import { useAgentNotify } from './hooks/useAgentNotify';
import { useWorkspaceActivity } from './hooks/useWorkspaceActivity';
import { useAppSettings } from './hooks/useAppSettings';
import { useNotificationSound } from './hooks/useNotificationSound';
import { SOUNDS, SILENT_SOUND_ID, playSound } from './sounds';
import { WorkspaceBar } from './components/WorkspaceBar';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { StatusBar } from './components/StatusBar';
import { WorkspaceGrid } from './components/WorkspaceGrid';
import { WorkspaceTaskManager } from './components/WorkspaceTaskManager';
import { LayoutContainer } from './components/LayoutContainer';
import { TerminalPortal } from './components/TerminalPortal';
import { BrowserPortal } from './components/BrowserPortal';
import { EnvironmentPicker } from './components/EnvironmentPicker';
import { IDEPortal } from './components/ide';
import { SettingsModal } from './components/SettingsModal';
import { Card, Row, Toggle, PInput, PSelect, ghostBtnStyle, primaryBtnStyle } from './components/settings-ui';
import { QuickChatPalette } from './components/QuickChatPalette';
import { SplitHorizontalIcon, SplitVerticalIcon } from './components/Icons';
import type { Container, IDEContainerState, Workspace, WorkspaceSyncConfig, WorkspaceSyncTarget } from '../shared/types';
import { useBrowserAgentBridge } from './hooks/useBrowserAgentBridge';
import { useTerminalAgentBridge } from './hooks/useTerminalAgentBridge';
import { useSqlAgentBridge } from './hooks/useSqlAgentBridge';
import { useSftpAgentBridge } from './hooks/useSftpAgentBridge';
import { setCommandListener } from './utils/commandCapture';

// After an automatic reconnect, ignore further drops on the same container for
// this long — stops a flapping connection from auto-reconnecting in a tight loop.
const AUTO_RECONNECT_COOLDOWN_MS = 10_000;

// Workspace Settings edit a local draft and only persist on Save (mirrors the
// global SettingsModal). Holds just the editable fields — runtime sync data
// (logs, fileStates, per-target status) stays live on the workspace.
interface WorkspaceSettingsDraft {
  workingDirectory: string | null;
  enabled: boolean;
  useGitIgnore: boolean;
  targets: WorkspaceSyncTarget[];
  // Per-workspace "Done" notification overrides (unset fields inherit the app
  // defaults). Edited here, persisted via setWorkspaceNotify on Save.
  notifyMuted: boolean;
  notifySoundId: string | null;
  notifyVolume: number | null;
}

const App: React.FC = () => {
  const terminals = useTerminals();
  const workspace = useWorkspace();
  const claudeActivity = useClaudeActivity();
  const agentNotify = useAgentNotify();
  // Per-session working/stopped from output content-diff — used for non-Claude
  // terminals (Claude terminals are driven by claudeActivity/OTel instead).
  const outputActivity = useWorkspaceActivity(
    workspace.workspaces,
    workspace.activeWorkspaceId,
    terminals.getLastOutputAt,
  );
  const appSettings = useAppSettings();
  // Play a "Done" sound when a terminal finishes in the background (inactive
  // workspace or unfocused window). Sound/volume resolve per-workspace → global.
  const playDoneSound = useNotificationSound({
    getSettings: () => appSettings.settings,
    getWorkspace: (id) => workspace.workspaces.find((w) => w.id === id),
  });
  // Let agents in terminals drive their own browser panes (open/navigate/get/
  // screenshot/console/eval) via the bundled splitgrid-browser helper.
  useBrowserAgentBridge({
    workspaces: workspace.workspaces,
    createBrowserContainer: workspace.createBrowserContainer,
    updateContainerContent: workspace.updateContainerContent,
    removeContainer: workspace.removeContainer,
  });
  // Agent terminal control: an agent in a splitgrid terminal can list/read/drive the
  // OTHER terminals in its workspace — and open/close terminals (local + SSH) —
  // via the bundled splitgrid-terminal helper.
  useTerminalAgentBridge({
    workspaces: workspace.workspaces,
    createContainer: workspace.createBrowserContainer, // content-agnostic creator
    removeContainer: workspace.removeContainerAnywhere,
    createLocalTerminal: terminals.createLocalTerminal,
    connectSaved: terminals.connectSaved,
    closeSession: terminals.closeSession,
    savedConnections: terminals.savedConnections,
  });
  // Agent SQL control: an agent in a splitgrid terminal can run queries, inspect
  // schema, export/import against the SQL pane in its workspace via the bundled
  // splitgrid-sql helper. Drives the live SqlWorkbench (results surface in the UI).
  useSqlAgentBridge({
    workspaces: workspace.workspaces,
    createContainer: workspace.createBrowserContainer, // content-agnostic creator
  });
  // Agent SFTP access: an agent in a splitgrid terminal can move files between
  // this machine and its workspace's remote hosts (sync targets + the hosts of
  // its SSH panes) via the bundled splitgrid-sftp helper — instead of base64-ing
  // files through a shell or standing up a web server to get them across.
  useSftpAgentBridge({
    workspaces: workspace.workspaces,
    savedConnections: terminals.savedConnections,
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const [showEnvironmentPicker, setShowEnvironmentPicker] = useState(false);
  const [connectionTestStatus, setConnectionTestStatus] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});
  const [syncNowStatus, setSyncNowStatus] = useState<string>('');
  // Id of an in-flight "Sync now" run, so the button can offer Cancel. Null = idle.
  const [syncNowId, setSyncNowId] = useState<string | null>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [appSettingsTab, setAppSettingsTab] = useState<'general' | 'ssh' | 'fastChat'>('general');
  const [showQuickChat, setShowQuickChat] = useState(false);
  // Whether a WorkOS account is signed in — gates per-terminal web streaming
  // (the relay requires an access token). Mirrors Settings → Account.
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let alive = true;
    window.electronAPI.authGetSession()
      .then((s) => { if (alive) setSignedIn(!!s); })
      .catch(() => { /* signed out */ });
    const off = window.electronAPI.onAuthChanged((s) => setSignedIn(!!s));
    return () => { alive = false; off?.(); };
  }, []);

  useEffect(() => {
    if (!showResources && !showSettings && !showAppSettings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setShowResources(false);
      setShowSettings(false);
      setShowAppSettings(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showResources, showSettings, showAppSettings]);

  // ⌘K / Ctrl+K toggles the Fast chat palette. The keystroke is intercepted in
  // the main process (see before-input-event) and forwarded here, so it fires
  // regardless of which inner surface — terminal, editor, browser pane — is
  // focused, not only when the host window has DOM focus.
  useEffect(() => window.electronAPI.onToggleQuickChat(() => setShowQuickChat((v) => !v)), []);
  const restoringTerminalContainersRef = useRef(new Set<string>());
  const isHydratedRef = useRef(false);

  // --- Web streaming (relay) ---
  // Cache the current environment (set) id/name once for relay share metadata.
  const relayEnvRef = useRef<{ envId: string; envName: string } | null>(null);
  // Sessions we've already (re)shared this run, so the resume effect doesn't
  // re-issue relaySetShare on every render. Cleared when a session stops.
  const sharedSessionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ctx = await window.electronAPI.getWorkspaceSetContext();
        const envs = await window.electronAPI.listEnvironments();
        if (cancelled) return;
        const envName = envs.find((e) => e.id === ctx.currentSetId)?.name ?? 'Environment';
        relayEnvRef.current = { envId: ctx.currentSetId, envName };
      } catch {
        // Best effort — meta falls back to defaults if unresolved.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Resolve cached env info, lazily refreshing if not yet available.
  const resolveRelayEnv = useCallback(async (): Promise<{ envId: string; envName: string }> => {
    if (relayEnvRef.current) return relayEnvRef.current;
    try {
      const ctx = await window.electronAPI.getWorkspaceSetContext();
      const envs = await window.electronAPI.listEnvironments();
      const envName = envs.find((e) => e.id === ctx.currentSetId)?.name ?? 'Environment';
      relayEnvRef.current = { envId: ctx.currentSetId, envName };
    } catch {
      relayEnvRef.current = { envId: '', envName: 'Environment' };
    }
    return relayEnvRef.current;
  }, []);

  const ensureSyncConfig = useCallback(() => {
    return workspace.activeWorkspace?.sync ?? {
      enabled: false,
      useGitIgnore: true,
      targets: [],
      fileStates: {},
      logs: [],
    };
  }, [workspace.activeWorkspace?.sync]);

  // --- Workspace Settings draft (edit-then-Save, like the global settings) ---
  const [wsSettingsDraft, setWsSettingsDraft] = useState<WorkspaceSettingsDraft | null>(null);
  const [wsSettingsSaved, setWsSettingsSaved] = useState(false);

  // (Re)seed the draft from the live workspace whenever the modal opens or the
  // active workspace changes. Keyed on the id (not the workspace object) so live
  // runtime updates — sync logs/status — don't clobber an in-progress edit.
  useEffect(() => {
    if (!showSettings) return;
    const ws = workspace.activeWorkspace;
    const sync = ws?.sync;
    setWsSettingsDraft({
      workingDirectory: ws?.workingDirectory ?? null,
      enabled: !!sync?.enabled,
      useGitIgnore: sync?.useGitIgnore ?? true,
      targets: (sync?.targets ?? []).map((t) => ({ ...t })),
      notifyMuted: !!ws?.notifyMuted,
      notifySoundId: ws?.notifySoundId ?? null,
      notifyVolume: ws?.notifyVolume ?? null,
    });
    setWsSettingsSaved(false);
  }, [showSettings, workspace.activeWorkspaceId]);

  const patchWsDraft = useCallback((patch: Partial<WorkspaceSettingsDraft>) => {
    setWsSettingsDraft((d) => (d ? { ...d, ...patch } : d));
    setWsSettingsSaved(false);
  }, []);
  const patchWsTarget = useCallback((targetId: string, patch: Partial<WorkspaceSyncTarget>) => {
    setWsSettingsDraft((d) =>
      d ? { ...d, targets: d.targets.map((t) => (t.id === targetId ? { ...t, ...patch } : t)) } : d
    );
    setWsSettingsSaved(false);
  }, []);

  // Save lights up only when the draft's config differs from what's persisted
  // (runtime status fields on targets are ignored).
  const targetConfigKey = (t: WorkspaceSyncTarget) =>
    `${t.id}|${t.name}|${t.enabled ? 1 : 0}|${t.connectionId ?? ''}|${t.remotePath}`;
  const wsSettingsDirty = useMemo(() => {
    const d = wsSettingsDraft;
    if (!d) return false;
    const ws = workspace.activeWorkspace;
    const sync = ws?.sync;
    if ((d.workingDirectory ?? null) !== (ws?.workingDirectory ?? null)) return true;
    if (d.enabled !== !!sync?.enabled) return true;
    if (d.useGitIgnore !== (sync?.useGitIgnore ?? true)) return true;
    if (d.notifyMuted !== !!ws?.notifyMuted) return true;
    if ((d.notifySoundId ?? null) !== (ws?.notifySoundId ?? null)) return true;
    if ((typeof d.notifyVolume === 'number' ? d.notifyVolume : null) !== (typeof ws?.notifyVolume === 'number' ? ws.notifyVolume : null)) return true;
    const live = sync?.targets ?? [];
    if (d.targets.length !== live.length) return true;
    const liveKeys = new Map(live.map((t) => [t.id, targetConfigKey(t)]));
    return d.targets.some((t) => liveKeys.get(t.id) !== targetConfigKey(t));
  }, [wsSettingsDraft, workspace.activeWorkspace]);

  const saveWorkspaceSettings = useCallback(() => {
    const draft = wsSettingsDraft;
    const id = workspace.activeWorkspaceId;
    if (!draft || !id) return;
    if ((draft.workingDirectory ?? null) !== (workspace.activeWorkspace?.workingDirectory ?? null)) {
      workspace.setWorkspaceWorkingDirectory(id, draft.workingDirectory);
    }
    workspace.setWorkspaceNotify(id, {
      notifyMuted: draft.notifyMuted,
      notifySoundId: draft.notifySoundId,
      notifyVolume: draft.notifyVolume,
    });
    const liveSync = workspace.activeWorkspace?.sync;
    // Carry over runtime data — logs, fileStates, and per-target sync status —
    // so saving the config never wipes it.
    const liveTargetById = new Map((liveSync?.targets ?? []).map((t) => [t.id, t]));
    workspace.setWorkspaceSyncConfig(id, {
      enabled: draft.enabled,
      useGitIgnore: draft.useGitIgnore,
      targets: draft.targets.map((t) => {
        const live = liveTargetById.get(t.id);
        return {
          ...t,
          lastSyncAt: live?.lastSyncAt,
          lastSyncStatus: live?.lastSyncStatus,
          lastSyncError: live?.lastSyncError,
        };
      }),
      fileStates: liveSync?.fileStates ?? {},
      logs: liveSync?.logs ?? [],
    });
    setWsSettingsSaved(true);
  }, [wsSettingsDraft, workspace.activeWorkspaceId, workspace.activeWorkspace, workspace.setWorkspaceWorkingDirectory, workspace.setWorkspaceSyncConfig, workspace.setWorkspaceNotify]);

  const shellQuote = useCallback((value: string) => {
    // POSIX shells (bash/zsh): single-quote with embedded `'\''` for any
    // literal quote. cmd.exe / PowerShell on Windows treat single quotes
    // as part of the path, so wrap in double quotes there and double-up
    // any inner double quotes (works for both cmd and PowerShell paths
    // without quotes embedded — vanishingly rare in real usage).
    if (window.electronAPI.platform === 'win32') {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }, []);

  const applyWorkingDirectoryToTerminal = useCallback((terminalId: string, cwd: string | null) => {
    if (!cwd) return;
    // Best effort for terminals that don't support cwd at creation time (e.g. SSH).
    setTimeout(() => {
      terminals.sendData(terminalId, `cd ${shellQuote(cwd)}\n`);
    }, 120);
  }, [shellQuote, terminals]);

  // Paste a saved/recent command into the focused terminal of the active
  // workspace (execute=true also presses Enter). Falls back to the first
  // terminal in the workspace when nothing terminal-like is focused.
  const runCommandInTerminal = useCallback((command: string, execute: boolean) => {
    const active = workspace.activeWorkspace;
    if (!active) return;
    const isTerm = (c: Container) => c.content.type === 'terminal' && !!c.content.terminalId;
    const focused = active.containers.find((c) => c.id === active.focusedContainerId && isTerm(c));
    const target = focused ?? active.containers.find(isTerm);
    const terminalId = target?.content.terminalId;
    if (!terminalId) return;
    terminals.sendData(terminalId, execute ? `${command}\n` : command);
  }, [workspace.activeWorkspace, terminals]);

  // Feed heuristically-captured terminal commands into the environment recent feed.
  useEffect(() => {
    setCommandListener((_sessionId, command) => workspace.recordRecentCommand(command));
    return () => setCommandListener(null);
  }, [workspace.recordRecentCommand]);

  useEffect(() => {
    // Reconcile the initial state: a window can enter fullscreen before the
    // renderer mounts this listener (e.g. a new window opened into an existing
    // fullscreen space), so the enter-full-screen event is missed.
    window.electronAPI.isFullScreen().then(setIsFullScreen).catch(() => {});
    return window.electronAPI.onFullScreenChange(setIsFullScreen);
  }, []);

  useEffect(() => {
    return window.electronAPI.onOpenEnvironmentPicker(() => {
      setShowEnvironmentPicker(true);
    });
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const saved = await window.electronAPI.loadWorkspaceState();
        workspace.hydrateState(saved);
      } catch (error) {
        console.error('Failed to load workspace state:', error);
      } finally {
        isHydratedRef.current = true;
      }
    })();
  }, []);

  // Strip volatile terminal output before persisting to disk to avoid
  // saving sensitive data (passwords, tokens) and reduce I/O churn.
  const buildPersistableState = useCallback(() => {
    return {
      activeWorkspaceId: workspace.activeWorkspaceId,
      workspaces: workspace.workspaces.map((ws) => ({
        ...ws,
        containers: ws.containers.map((c) =>
          c.content.type === 'terminal' && c.content.terminalOutput
            ? { ...c, content: { ...c.content, terminalOutput: undefined } }
            : c
        ),
      })),
      envTodos: workspace.envTodos,
      envCommandFavorites: workspace.envCommandFavorites,
      recentCommands: workspace.recentCommands,
      envPrompts: workspace.envPrompts,
    };
  }, [workspace.activeWorkspaceId, workspace.workspaces, workspace.envTodos, workspace.envCommandFavorites, workspace.recentCommands, workspace.envPrompts]);

  useEffect(() => {
    if (!isHydratedRef.current) return;
    const id = setTimeout(() => {
      window.electronAPI.saveWorkspaceState(buildPersistableState()).catch((error) => {
        console.error('Failed to save workspace state:', error);
      });
    }, 350);
    return () => clearTimeout(id);
  }, [buildPersistableState]);

  useEffect(() => {
    const flush = () => {
      if (!isHydratedRef.current) return;
      window.electronAPI.saveWorkspaceState(buildPersistableState()).catch(() => {
        // best effort during unload
      });
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [buildPersistableState]);

  // React to a session ending, in whichever workspace it lives:
  //  • clean exit (logout / `exit`)  → close the terminal and its container;
  //  • network drop                  → make ONE automatic reconnect attempt;
  //    afterwards the user reconnects with the SSH reload button. A short
  //    cooldown stops a flapping connection from auto-reconnecting in a loop.
  // Refs keep the IPC subscription stable across workspace edits.
  const workspacesRef = useRef(workspace.workspaces);
  workspacesRef.current = workspace.workspaces;
  const handleReconnectRef = useRef<((id: string) => Promise<void>) | null>(null);
  const autoReconnectInFlightRef = useRef<Set<string>>(new Set());
  const autoReconnectAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    return window.electronAPI.onSessionClosed((sessionId, exitedCleanly) => {
      let container: Container | undefined;
      for (const ws of workspacesRef.current) {
        const c = ws.containers.find(
          (x) => x.content.type === 'terminal' && x.content.terminalId === sessionId,
        );
        if (c) { container = c; break; }
      }
      if (!container) return;
      const containerId = container.id;

      if (exitedCleanly) {
        terminals.closeSession(sessionId).catch(() => {});
        workspace.removeContainerAnywhere(containerId);
        return;
      }

      // Network drop: only an SSH terminal with a saved connection can reconnect.
      if (container.content.terminalType !== 'ssh' || !container.content.connectionId) return;
      if (autoReconnectInFlightRef.current.has(containerId)) return;
      const now = Date.now();
      const last = autoReconnectAtRef.current.get(containerId) ?? 0;
      if (now - last < AUTO_RECONNECT_COOLDOWN_MS) return; // flapping → leave it for the button
      autoReconnectAtRef.current.set(containerId, now);
      autoReconnectInFlightRef.current.add(containerId);
      void handleReconnectRef.current?.(containerId).finally(() => {
        autoReconnectInFlightRef.current.delete(containerId);
      });
    });
  }, [terminals.closeSession, workspace.removeContainerAnywhere]);

  // Add first empty container
  const handleAddFirst = useCallback(() => {
    workspace.addFirstContainer({ type: 'empty' });
  }, [workspace]);

  // Fill a container with a local terminal
  const handleAddLocal = useCallback(
    async (containerId: string) => {
      try {
        const cwd = workspace.activeWorkspace?.workingDirectory ?? undefined;
        const info = await terminals.createLocalTerminal(cwd ? { cwd } : undefined);
        workspace.updateContainerContent(containerId, {
          type: 'terminal',
          terminalId: info.id,
          terminalType: 'local',
          label: info.label,
          cwd: cwd ?? info.cwd,
          shell: info.shell,
        });
      } catch (e) {
        console.error('Failed to create local terminal:', e);
      }
    },
    [terminals, workspace]
  );

  // Fill a container with IDE
  const handleAddIDE = useCallback(
    async (containerId: string) => {
      let dir = workspace.activeWorkspace?.workingDirectory ?? null;
      if (!dir) {
        dir = await window.electronAPI.selectDirectory();
        if (!dir) return;
        if (workspace.activeWorkspaceId) {
          workspace.setWorkspaceWorkingDirectory(workspace.activeWorkspaceId, dir);
        }
      }
      workspace.updateContainerContent(containerId, {
        type: 'ide',
        rootPath: dir,
        label: dir.split('/').pop() || 'IDE',
      });
    },
    [workspace]
  );

  // Fill a container with a browser
  const handleAddBrowser = useCallback(
    (containerId: string) => {
      workspace.updateContainerContent(containerId, {
        type: 'browser',
        browserUrl: 'https://www.google.com',
        browserPartition: 'persist:browser',
        label: 'Browser',
      });
    },
    [workspace]
  );

  // Fill a container with SQL client
  const handleAddSQL = useCallback(
    (containerId: string) => {
      const defaultTabId = `query-${Date.now().toString(36)}`;
      workspace.updateContainerContent(containerId, {
        type: 'sql',
        label: 'SQL Client',
        sqlState: {
          connectionId: null,
          savedConnectionId: null,
          connectionName: 'Postgres',
          host: '127.0.0.1',
          port: 5432,
          user: 'postgres',
          database: 'postgres',
          ssl: false,
          tabs: [
            {
              id: defaultTabId,
              type: 'query' as const,
              title: 'Query 1',
              query: 'SELECT now();',
              database: 'postgres',
              schema: 'public',
              savedConnectionId: null,
            },
          ],
          activeTabId: defaultTabId,
          schema: 'public',
          history: [],
        },
      });
    },
    [workspace]
  );

  // ── Dev-only screenshot/test seam ───────────────────────────────────────────
  // Exposes window.__sgTest for the screenshot harness (scripts/sql-shots.mjs) to
  // deterministically open a SQL pane already wired to a saved connection so it
  // auto-connects on mount (SqlWorkbench reconnects when initialState.savedConnectionId
  // is set). GUARDED: only attaches when localStorage 'SG_TEST'==='1' (the harness
  // sets this before reloading). Never present in normal use. Safe to delete.
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      if (window.localStorage.getItem('SG_TEST') !== '1') return;
    } catch {
      return;
    }
    (window as unknown as { __sgTest?: unknown }).__sgTest = {
      // Create a fresh SQL container in the active workspace, pre-wired to the
      // given saved connection (auto-connects) with an optional initial query.
      addSqlConnected: (savedId: string, query?: string, schema = 'public') => {
        const wsId = workspace.activeWorkspaceId;
        if (!wsId) throw new Error('no active workspace');
        const tabId = `query-${Date.now().toString(36)}`;
        const id = workspace.createBrowserContainer(wsId, {
          type: 'sql',
          label: 'SQL Client',
          sqlState: {
            connectionId: null,
            savedConnectionId: savedId,
            connectionName: 'shop demo',
            host: '127.0.0.1',
            port: 55455,
            user: 'postgres',
            database: 'shop',
            ssl: false,
            tabs: [
              {
                id: tabId,
                type: 'query' as const,
                title: 'Query 1',
                query: query ?? 'SELECT now();',
                database: 'shop',
                schema,
                savedConnectionId: savedId,
              },
            ],
            activeTabId: tabId,
            schema,
            history: [],
          },
        });
        workspace.focusContainerInWorkspace(wsId, id);
        return id;
      },
    };
  }, [workspace]);

  // Fill a container with an SFTP file-manager pane (it shows its own connection chooser).
  const handleAddSFTP = useCallback((containerId: string) => {
    workspace.updateContainerContent(containerId, { type: 'sftp', label: 'SFTP' });
  }, [workspace]);

  // Fill a container with the embedded SSH connection picker (replaces the old
  // full-screen NewSessionDialog modal). Choosing a connection connects a
  // terminal and swaps the container to it (see handleSSHConnect).
  const handleAddSSH = useCallback((containerId: string) => {
    workspace.updateContainerContent(containerId, { type: 'ssh-connect', label: 'SSH' });
  }, [workspace]);

  const handleSSHConnect = useCallback(async (containerId: string, savedId: string) => {
    const info = await terminals.connectSaved(savedId);
    workspace.updateContainerContent(containerId, {
      type: 'terminal', terminalId: info.id, terminalType: 'ssh', label: info.label, connectionId: savedId,
    });
    applyWorkingDirectoryToTerminal(info.id, workspace.activeWorkspace?.workingDirectory ?? null);
    if (workspace.activeWorkspaceId) workspace.recordConnectionUse(workspace.activeWorkspaceId, savedId);
  }, [terminals, workspace, applyWorkingDirectoryToTerminal]);

  // Set/clear a terminal's custom name (shown in its pane header). null resets
  // to the auto-derived name. Resolves the container across all workspaces.
  const handleRenameTerminal = useCallback((containerId: string, name: string | null) => {
    const ws = workspace.workspaces.find((w) => w.containers.some((c) => c.id === containerId));
    const container = ws?.containers.find((c) => c.id === containerId);
    if (!container || container.content.type !== 'terminal') return;
    workspace.updateContainerContent(containerId, { ...container.content, customName: name ?? undefined });

    // If this terminal is streaming, push the new title to the relay right away.
    // The re-share effect skips already-shared sessions, so without this an
    // in-place rename would never reach the web viewer (the old name would
    // linger, looking like a stale/duplicate session). cols/rows are corrected
    // by the main process from the live PTY size.
    const sessionId = container.content.terminalId;
    if (container.content.streamToWeb && sessionId) {
      const session = terminals.sessions.find((s) => s.id === sessionId);
      const title = name?.trim() || session?.label || 'terminal';
      const workspaceName = ws?.name || 'Workspace';
      const wsId = ws?.id ?? '';
      void resolveRelayEnv().then(({ envId, envName }) => {
        window.electronAPI.relaySetShare(sessionId, true, {
          title, envId, envName, workspaceId: wsId, workspaceName, cols: 80, rows: 24,
        });
      });
    }
  }, [workspace, terminals.sessions, resolveRelayEnv]);

  // Toggle streaming a terminal's output to the web relay. Persists the flag on
  // the container and starts/stops the relay producer for its live session.
  const handleToggleStreaming = useCallback(
    async (
      workspaceId: string,
      container: Container,
      enabled: boolean,
      live: { cols: number; rows: number },
    ) => {
      if (container.content.type !== 'terminal') return;
      // Persist the flag with the workspace.
      workspace.updateContainerContent(container.id, { ...container.content, streamToWeb: enabled });

      const sessionId = container.content.terminalId;
      if (!sessionId) return;

      if (!enabled) {
        sharedSessionIdsRef.current.delete(sessionId);
        window.electronAPI.relaySetShare(sessionId, false);
        return;
      }

      const session = terminals.sessions.find((s) => s.id === sessionId);
      const sessionLabel = session?.label;
      const title = container.content.customName?.trim() || sessionLabel || 'terminal';
      const workspaceName = workspace.workspaces.find((w) => w.id === workspaceId)?.name || 'Workspace';
      const { envId, envName } = await resolveRelayEnv();

      sharedSessionIdsRef.current.add(sessionId);
      window.electronAPI.relaySetShare(sessionId, true, {
        title,
        envId,
        envName,
        workspaceId,
        workspaceName,
        cols: live.cols,
        rows: live.rows,
      });
    },
    [workspace, terminals.sessions, resolveRelayEnv],
  );

  // Update browser URL when navigating — skip if URL is unchanged to avoid re-render loops.
  const handleBrowserUrlChange = useCallback(
    (containerId: string, url: string) => {
      const container = workspace.activeWorkspace?.containers.find((c) => c.id === containerId);
      if (!container || container.content.type !== 'browser') return;
      if (container.content.browserUrl === url) return;
      workspace.updateContainerContent(containerId, {
        ...container.content,
        browserUrl: url,
      });
    },
    [workspace]
  );

  // Open the browser bound to an agent terminal. If it already has one
  // (browserOwnerTerminal === sid), switch to its workspace and focus it;
  // otherwise create a browser pane in the agent's workspace, owned by it.
  const handleOpenAgentBrowser = useCallback(
    (sessionId: string) => {
      for (const ws of workspace.workspaces) {
        const existing = ws.containers.find(
          (x) => x.content.type === 'browser' && x.content.browserOwnerTerminal === sessionId
        );
        if (existing) {
          workspace.focusContainerInWorkspace(ws.id, existing.id);
          return;
        }
      }
      // None yet — create one in the workspace that holds the agent's terminal.
      const ownerWs = workspace.workspaces.find((ws) =>
        ws.containers.some((x) => x.content.type === 'terminal' && x.content.terminalId === sessionId)
      );
      if (!ownerWs) return;
      const id = workspace.createBrowserContainer(ownerWs.id, {
        type: 'browser',
        browserUrl: 'https://www.google.com',
        browserPartition: 'persist:browser',
        browserOwnerTerminal: sessionId,
        label: 'Browser',
      });
      workspace.focusContainerInWorkspace(ownerWs.id, id);
    },
    [workspace]
  );

  // Close container (clean up terminal if present)
  const handleCloseContainer = useCallback(
    async (containerId: string) => {
      const container = workspace.activeWorkspace?.containers.find((c) => c.id === containerId);
      if (container?.content.terminalId) {
        await terminals.closeSession(container.content.terminalId);
      }
      workspace.removeContainer(containerId);
    },
    [terminals, workspace]
  );

  // Session map for active workspace
  const sessionMap = useMemo(() => {
    const map = new Map<string, any>();
    for (const s of terminals.sessions) {
      if (workspace.activeTerminalIds.has(s.id)) {
        map.set(s.id, s);
      }
    }
    return map;
  }, [terminals.sessions, workspace.activeTerminalIds]);

  const ideContainers = useMemo(
    () =>
      (workspace.activeWorkspace?.containers ?? []).filter(
        (c) => c.content.type === 'ide' && c.content.rootPath
      ),
    [workspace.activeWorkspace?.containers]
  );

  const handleIDEStateChange = useCallback(
    (containerId: string, ideState: IDEContainerState) => {
      const container = workspace.activeWorkspace?.containers.find((c) => c.id === containerId);
      if (!container || container.content.type !== 'ide') return;
      const prevSerialized = JSON.stringify(container.content.ideState ?? null);
      const nextSerialized = JSON.stringify(ideState);
      if (prevSerialized === nextSerialized) return;
      workspace.updateContainerContent(containerId, {
        ...container.content,
        ideState,
      });
    },
    [workspace]
  );

  const handleFocusedContainerChange = useCallback(
    (containerId: string | null) => {
      workspace.setFocusedContainer(containerId);
    },
    [workspace]
  );

  // Restore terminal sessions for the active workspace after state hydration/switch.
  useEffect(() => {
    const active = workspace.activeWorkspace;
    if (!active) return;
    // Wait until the live session list is known. Restoring against a not-yet-
    // loaded (empty) list would spawn duplicate shells for still-alive PTYs and
    // rebind their terminalId, desyncing it from the running $SPLITGRID_TERMINAL.
    if (!terminals.sessionsLoaded) return;

    const liveSessionIds = new Set(
      terminals.sessions
        .filter((s) => s.status === 'connected' || s.status === 'connecting')
        .map((s) => s.id)
    );
    const terminalContainers = active.containers.filter(
      (c) => c.content.type === 'terminal',
    );

    for (const container of terminalContainers) {
      const key = container.id;
      if (restoringTerminalContainersRef.current.has(key)) continue;

      const existingId = container.content.terminalId;
      if (existingId && liveSessionIds.has(existingId)) continue;

      restoringTerminalContainersRef.current.add(key);

      (async () => {
        try {
          if (container.content.terminalType === 'ssh') {
            let connectionId = container.content.connectionId;
            if (!connectionId) {
              // Backward compatibility for old workspaces where SSH container
              // was saved without connectionId.
              const byLabel = terminals.savedConnections.find(
                (c) => c.label === container.content.label
              );
              if (byLabel) {
                connectionId = byLabel.id;
              }
            }
            if (!connectionId) {
              console.warn('Cannot restore SSH terminal without saved connection id', container.id);
              workspace.updateContainerContent(container.id, {
                ...container.content,
                type: 'terminal',
                terminalType: 'ssh',
                connectionError: 'Saved connection not found. Re-create this terminal.',
              });
              return;
            }

            const info = await terminals.connectSaved(connectionId);
            workspace.updateContainerContent(container.id, {
              ...container.content,
              type: 'terminal',
              terminalType: 'ssh',
              terminalId: info.id,
              connectionId,
              label: container.content.label ?? info.label,
            });
            applyWorkingDirectoryToTerminal(
              info.id,
              active.workingDirectory ?? container.content.cwd ?? null
            );
            return;
          }

          // Default restore path: local terminal.
          const cwd = container.content.cwd ?? active.workingDirectory ?? undefined;
          const info = await terminals.createLocalTerminal({
            cwd,
            shell: container.content.shell,
            label: container.content.label,
          });
          workspace.updateContainerContent(container.id, {
            ...container.content,
            type: 'terminal',
            terminalType: 'local',
            terminalId: info.id,
            label: container.content.label ?? info.label,
            cwd: cwd ?? info.cwd,
            shell: container.content.shell ?? info.shell,
          });
        } catch (error) {
          console.error('Failed to restore terminal container:', container.id, error);
          const msg = error instanceof Error ? error.message : String(error);
          workspace.updateContainerContent(container.id, {
            ...container.content,
            type: 'terminal',
            connectionError: msg,
          });
        } finally {
          restoringTerminalContainersRef.current.delete(key);
        }
      })();
    }
  }, [
    workspace.activeWorkspace,
    terminals.sessions,
    terminals.sessionsLoaded,
    terminals.createLocalTerminal,
    terminals.connectSaved,
    terminals.savedConnections,
    workspace.updateContainerContent,
    applyWorkingDirectoryToTerminal,
  ]);

  // Render container content
  const renderContent = useCallback(
    (container: Container, onSplitRight: () => void, onSplitDown: () => void, zoomLevel: number) => {
      // Empty container — content picker
      if (container.content.type === 'empty' || !container.content.type) {
        return (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            width: '100%',
            background: 'var(--bg-primary)',
            overflow: 'hidden',
            border: '1px solid var(--border)',
          }}>
            <div
              className="container-drag-handle"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '0 10px',
                height: '32px',
                minHeight: '32px',
                background: 'var(--bg-titlebar)',
                borderBottom: '1px solid var(--border)',
                userSelect: 'none',
                cursor: 'grab',
              }}
            >
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => handleCloseContainer(container.id)}
                title="Close"
                style={{
                  width: '12px', height: '12px', borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '8px', color: 'transparent', background: 'var(--accent-red)',
                  border: 'none', cursor: 'pointer', flexShrink: 0, lineHeight: 1, opacity: 0.7,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--bg-primary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.color = 'transparent'; }}
              >
                x
              </button>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', flex: 1 }}>
                Empty Container
              </span>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={onSplitRight}
                title="Split right"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
              >
                <SplitHorizontalIcon size={14} />
              </button>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={onSplitDown}
                title="Split down"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
              >
                <SplitVerticalIcon size={14} />
              </button>
            </div>
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              padding: '12px',
            }}>
              {[
                { label: 'Terminal', icon: '$', color: 'var(--accent-green)', onClick: () => handleAddLocal(container.id) },
                { label: 'SSH', icon: '~', color: 'var(--accent)', onClick: () => handleAddSSH(container.id) },
                { label: 'IDE', icon: '</>', color: 'var(--accent-yellow)', onClick: () => handleAddIDE(container.id) },
                { label: 'Browser', icon: '\u2605', color: 'var(--accent-purple)', onClick: () => handleAddBrowser(container.id) },
                { label: 'SQL', icon: 'db', color: 'var(--accent-blue)', onClick: () => handleAddSQL(container.id) },
                { label: 'SFTP', icon: '⇆', color: 'var(--accent-orange)', onClick: () => handleAddSFTP(container.id) },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={item.onClick}
                  style={{
                    width: '100%', maxWidth: '160px', padding: '6px 12px', borderRadius: '5px',
                    fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)',
                    background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '8px',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = item.color; e.currentTarget.style.color = 'var(--text-primary)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                >
                  <span style={{ color: item.color, fontSize: '12px', width: '20px', textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        );
      }

      // Terminal container — rendering itself is hoisted to
      // <TerminalPortal> at the App root so it survives workspace switches.
      return (
        <LayoutContainer
          container={container}
          sessions={sessionMap}
          workspaceId={workspace.activeWorkspace?.id ?? ''}
          recentConnectionIds={workspace.activeWorkspace?.recentConnectionIds ?? []}
          onRecordConnectionUse={(id) => { if (workspace.activeWorkspaceId) workspace.recordConnectionUse(workspace.activeWorkspaceId, id); }}
          workspaceRootPath={workspace.activeWorkspace?.workingDirectory ?? null}
          savedConnections={terminals.savedConnections}
          onSSHConnect={handleSSHConnect}
          onCreateConnection={terminals.saveConnection}
          onDeleteSavedConnection={terminals.deleteSavedConnection}
          onClose={handleCloseContainer}
          onSplitRight={onSplitRight}
          onSplitDown={onSplitDown}
          onContentChange={(id, content) => {
            workspace.updateContainerContent(id, content);
          }}
          zoomLevel={zoomLevel}
        />
      );
    },
    [sessionMap, handleCloseContainer, handleAddLocal, handleAddSQL, handleAddSFTP, handleAddSSH, handleSSHConnect, terminals, handleBrowserUrlChange, workspace]
  );

  const handleReconnectContainer = useCallback(
    async (containerId: string) => {
      // Search every workspace, not just the active one — an SSH terminal can
      // drop and auto-reconnect while it sits in a background workspace.
      const c = workspace.workspaces
        .flatMap((ws) => ws.containers)
        .find((c) => c.id === containerId);
      const connectionId = c?.content.connectionId;
      if (!c || !connectionId) return;
      try {
        const info = await terminals.connectSaved(connectionId);
        workspace.updateContainerContent(containerId, {
          ...c.content,
          terminalId: info.id,
          connectionError: undefined,
        });
      } catch (e: any) {
        workspace.updateContainerContent(containerId, {
          ...c.content,
          connectionError: e?.message || 'Reconnect failed',
        });
      }
    },
    [workspace, terminals],
  );
  handleReconnectRef.current = handleReconnectContainer;

  // All terminal containers across every workspace. Each one keeps its own
  // <TerminalPortal> mounted for the lifetime of the container so the terminal
  // never unmounts — only its DOM wrapper is reparented when the workspace
  // grid swaps in.
  const allTerminalEntries = useMemo(() => {
    const out: Array<{ workspaceId: string; container: Container; zoomLevel: number }> = [];
    for (const ws of workspace.workspaces) {
      for (const c of ws.containers) {
        if (c.content.type !== 'terminal') continue;
        out.push({
          workspaceId: ws.id,
          container: c,
          zoomLevel: ws.containerZooms?.[c.id] ?? 13,
        });
      }
    }
    return out;
  }, [workspace.workspaces]);

  // Browser panes across all workspaces — like terminals, their <webview>
  // renderer is hoisted to a persistent <BrowserPortal> so it survives (and
  // doesn't reload on) workspace switches.
  const allBrowserEntries = useMemo(() => {
    const out: Array<{ workspaceId: string; container: Container; zoomLevel: number }> = [];
    for (const ws of workspace.workspaces) {
      for (const c of ws.containers) {
        if (c.content.type !== 'browser') continue;
        out.push({
          workspaceId: ws.id,
          container: c,
          zoomLevel: ws.containerZooms?.[c.id] ?? 13,
        });
      }
    }
    return out;
  }, [workspace.workspaces]);

  // Global session lookup — TerminalPortal needs sessions across all
  // workspaces, not just the one filtered by activeTerminalIds.
  const allSessionsMap = useMemo(() => {
    const map = new Map<string, typeof terminals.sessions[number]>();
    for (const s of terminals.sessions) map.set(s.id, s);
    return map;
  }, [terminals.sessions]);

  // Resume streaming for terminals persisted with streamToWeb === true, once
  // their live session exists. Tracks already-shared ids in a ref to avoid
  // duplicate relay calls; cols/rows default to 80x24 (a later resize corrects
  // them). Clears ids that are no longer marked as streaming.
  useEffect(() => {
    const stillStreaming = new Set<string>();
    for (const { workspaceId, container } of allTerminalEntries) {
      if (container.content.type !== 'terminal') continue;
      if (!container.content.streamToWeb) continue;
      const sessionId = container.content.terminalId;
      if (!sessionId) continue;
      const session = allSessionsMap.get(sessionId);
      if (!session) continue;

      stillStreaming.add(sessionId);
      if (sharedSessionIdsRef.current.has(sessionId)) continue;
      sharedSessionIdsRef.current.add(sessionId);

      const title = container.content.customName?.trim() || session.label || 'terminal';
      const workspaceName = workspace.workspaces.find((w) => w.id === workspaceId)?.name || 'Workspace';
      void resolveRelayEnv().then(({ envId, envName }) => {
        window.electronAPI.relaySetShare(sessionId, true, {
          title,
          envId,
          envName,
          workspaceId,
          workspaceName,
          cols: 80,
          rows: 24,
        });
      });
    }
    // Forget sessions that are no longer marked for streaming so a later
    // re-enable triggers a fresh share.
    for (const id of sharedSessionIdsRef.current) {
      if (!stillStreaming.has(id)) sharedSessionIdsRef.current.delete(id);
    }
  }, [allTerminalEntries, allSessionsMap, workspace.workspaces, resolveRelayEnv]);

  const terminalRowsByWorkspaceId = useMemo(() => {
    const rowsByWorkspace = new Map<
      string,
      Array<{ id: string; label: string; sessionId?: string; streamable: boolean; status?: string; streaming?: boolean }>
    >();

    for (const ws of workspace.workspaces) {
      const rows = ws.containers
        .filter((container) => container.content.type === 'terminal')
        .map((container) => {
          const content = container.content;
          const terminalId = content.terminalId;
          const session = terminalId ? allSessionsMap.get(terminalId) : undefined;
          const type = session?.type ?? content.terminalType ?? 'local';
          return {
            id: container.id,
            label: type === 'ssh' ? 'ssh' : 'terminal',
            customName: content.customName,
            sessionId: terminalId,
            streamable: true,
            status: session?.status ?? (content.connectionError ? 'error' : undefined),
            streaming: !!content.streamToWeb,
          };
        });

      if (rows.length > 0) rowsByWorkspace.set(ws.id, rows);
    }

    return rowsByWorkspace;
  }, [allSessionsMap, workspace.workspaces]);

  // Clear claude response notifications when switching to a workspace
  useEffect(() => {
    if (!workspace.activeWorkspace) return;
    const sessionIds = workspace.activeWorkspace.containers
      .map(c => c.content.terminalId)
      .filter((id): id is string => !!id);
    if (sessionIds.length > 0) terminals.clearClaudeResponsesForSessions(sessionIds);
  }, [workspace.activeWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update window title to active workspace name (visible in macOS Mission Control / Dock)
  useEffect(() => {
    const name = workspace.activeWorkspace?.name;
    document.title = name ? `${name} — SplitGrid` : 'SplitGrid';
  }, [workspace.activeWorkspace?.name]);

  // Auto-sync watchers: keep one chokidar watcher per workspace that has sync
  // enabled — including INACTIVE ones, so an agent editing files in a background
  // workspace still mirrors to its remote while you work elsewhere. We reconcile
  // a desired set against what's currently applied so unchanged watchers aren't
  // needlessly torn down (a restart re-scans the whole tree).
  const watchedSyncSigsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const desired = new Map<string, { dir: string; sync: WorkspaceSyncConfig; sig: string }>();
    for (const ws of workspace.workspaces) {
      if (!ws.id || !ws.workingDirectory) continue;
      const sync = ws.sync;
      const eligible = !!sync?.enabled && sync.targets.some((t) => t.enabled && t.connectionId);
      if (!eligible || !sync) continue;
      const sig = JSON.stringify({
        dir: ws.workingDirectory,
        gi: sync.useGitIgnore,
        targets: sync.targets.map((t) => `${t.id}:${t.enabled}:${t.connectionId}:${t.remotePath}`),
      });
      desired.set(ws.id, { dir: ws.workingDirectory, sync, sig });
    }

    const applied = watchedSyncSigsRef.current;
    // Start watchers for newly-eligible workspaces; restart when their relevant
    // config (root, .gitignore toggle, targets) changed.
    for (const [id, d] of desired) {
      if (applied.get(id) !== d.sig) {
        window.electronAPI.syncWatchWorkspace({ workspaceId: id, localRootPath: d.dir, sync: d.sync });
        applied.set(id, d.sig);
      }
    }
    // Stop watchers for workspaces that are gone or no longer eligible.
    for (const id of Array.from(applied.keys())) {
      if (!desired.has(id)) {
        window.electronAPI.syncUnwatchWorkspace(id);
        applied.delete(id);
      }
    }
  }, [
    // Re-run whenever any workspace's sync-relevant config changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(
      workspace.workspaces.map((w) => ({
        id: w.id,
        dir: w.workingDirectory,
        en: w.sync?.enabled ?? false,
        gi: w.sync?.useGitIgnore ?? false,
        t: w.sync?.targets?.map((t) => `${t.id}:${t.enabled}:${t.connectionId}:${t.remotePath}`) ?? [],
      }))
    ),
  ]);

  // Tear down every workspace watcher when the app unmounts.
  useEffect(() => {
    const applied = watchedSyncSigsRef.current;
    return () => {
      for (const id of applied.keys()) window.electronAPI.syncUnwatchWorkspace(id);
      applied.clear();
    };
  }, []);

  // Freeze: suspend a workspace's local terminal trees (SIGSTOP) so it stops
  // eating CPU. The active workspace is never frozen, and a frozen workspace
  // can't be switched into until unfrozen — so its state stays consistent.
  const handleFreezeWorkspace = useCallback(async (id: string) => {
    const ws = workspace.workspaces.find((w) => w.id === id);
    if (!ws) return;
    const sessionIds = ws.containers
      .map((c) => c.content.terminalId)
      .filter((x): x is string => !!x);
    if (sessionIds.length > 0) {
      try { await window.electronAPI.freezeWorkspace(sessionIds); } catch (e) { console.error('freeze failed', e); }
    }
    workspace.setWorkspaceFrozen(id, true);
  }, [workspace.workspaces, workspace.setWorkspaceFrozen]);

  const handleUnfreezeWorkspace = useCallback(async (id: string) => {
    const ws = workspace.workspaces.find((w) => w.id === id);
    workspace.setWorkspaceFrozen(id, false);
    if (!ws) return;
    const sessionIds = ws.containers
      .map((c) => c.content.terminalId)
      .filter((x): x is string => !!x);
    if (sessionIds.length > 0) {
      try { await window.electronAPI.unfreezeWorkspace(sessionIds); } catch (e) { console.error('unfreeze failed', e); }
    }
  }, [workspace.workspaces, workspace.setWorkspaceFrozen]);

  // Close a workspace: snapshot it into per-env "recent" history (so it can be
  // reopened) before removing it. Strip volatile terminal output like the save
  // path does, and clear frozen (its processes are gone).
  const handleCloseWorkspace = useCallback(async (id: string) => {
    const ws = workspace.workspaces.find((w) => w.id === id);
    if (ws) {
      const snapshot = {
        ...ws,
        frozen: false,
        containers: ws.containers.map((c) =>
          c.content.type === 'terminal' && c.content.terminalOutput
            ? { ...c, content: { ...c.content, terminalOutput: undefined } }
            : c
        ),
      };
      try {
        await window.electronAPI.addRecentWorkspace(snapshot);
      } catch (e) {
        console.error('record recent failed', e);
      }
    }
    workspace.deleteWorkspace(id);
  }, [workspace.workspaces, workspace.deleteWorkspace]);

  const handleOpenRecentWorkspace = useCallback((ws: Workspace) => {
    workspace.addWorkspace(ws);
  }, [workspace.addWorkspace]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      <WorkspaceBar
        isFullScreen={isFullScreen}
        workspaceName={workspace.activeWorkspace?.name}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <WorkspaceSidebar
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
          workspaces={workspace.workspaces}
          activeWorkspaceId={workspace.activeWorkspaceId}
          onSwitchWorkspace={workspace.switchWorkspace}
          onCreateWorkspace={workspace.createWorkspace}
          onDeleteWorkspace={handleCloseWorkspace}
          onRenameWorkspace={workspace.renameWorkspace}
          onSetWorkingDirectory={workspace.setWorkspaceWorkingDirectory}
          onReorderWorkspaces={workspace.reorderWorkspaces}
          onListRecentWorkspaces={() => window.electronAPI.listRecentWorkspaces()}
          onOpenRecentWorkspace={handleOpenRecentWorkspace}
          onOpenAppSettings={() => { setAppSettingsTab('general'); setShowAppSettings(true); }}
          onOpenSettings={(id) => { workspace.switchWorkspace(id); setShowSettings(true); }}
          envTodos={workspace.envTodos}
          onUpdateEnvTodos={workspace.updateEnvTodos}
          recentCommands={workspace.recentCommands}
          envCommandFavorites={workspace.envCommandFavorites}
          workspaceCommandFavorites={workspace.activeWorkspace?.commandFavorites ?? []}
          onRunCommand={runCommandInTerminal}
          onUpdateEnvCommandFavorites={workspace.updateEnvCommandFavorites}
          onUpdateWorkspaceCommandFavorites={(updater) => {
            if (workspace.activeWorkspace) workspace.updateWorkspaceCommandFavorites(workspace.activeWorkspace.id, updater);
          }}
          onRemoveRecentCommand={workspace.removeRecentCommand}
          onClearRecentCommands={workspace.clearRecentCommands}
          envPrompts={workspace.envPrompts}
          onUpdateEnvPrompts={workspace.updateEnvPrompts}
          onFreezeWorkspace={handleFreezeWorkspace}
          onUnfreezeWorkspace={handleUnfreezeWorkspace}
          terminalRowsByWorkspaceId={terminalRowsByWorkspaceId}
          claudeActivity={claudeActivity}
          sessionActivity={outputActivity.sessions}
          agentNotify={agentNotify}
          onUnviewedDone={playDoneSound}
          muteAll={appSettings.settings.muteAll}
          onToggleWorkspaceMute={(id, muted) => workspace.setWorkspaceNotify(id, { notifyMuted: muted })}
          onToggleMuteAll={(muted) => appSettings.update({ muteAll: muted })}
          onSetWorkspaceNotes={workspace.setWorkspaceNotes}
          onUpdateWorkspaceTodos={workspace.updateWorkspaceTodos}
        />

        <WorkspaceGrid
            key={workspace.activeWorkspace?.id ?? 'none'}
            tree={workspace.activeWorkspace?.layoutTree ?? null}
            containers={workspace.activeWorkspace?.containers ?? []}
            zoomLevels={workspace.activeWorkspace?.containerZooms ?? {}}
            focusedContainerId={workspace.activeWorkspace?.focusedContainerId ?? null}
            onTreeChange={workspace.updateLayoutTree}
            onZoomChange={workspace.setContainerZoom}
            onFocusedContainerChange={handleFocusedContainerChange}
            onSplit={workspace.splitContainer}
            onClose={handleCloseContainer}
            onSwap={workspace.swapContainers}
            onAddFirst={handleAddFirst}
            renderContent={renderContent}
            focusModeHotkey={appSettings.settings.focusModeHotkey}
          />

        {showSettings && wsSettingsDraft && (
          <div
            onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.55)', backdropFilter: 'blur(6px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '40px 20px',
            }}
          >
            <div style={{
              width: 760, maxWidth: '100%', height: '82vh', maxHeight: 680, background: 'var(--bg-surface)',
              border: '1px solid var(--border)', borderRadius: 16, display: 'flex', flexDirection: 'column',
              overflow: 'hidden', boxShadow: '0 24px 70px rgba(0, 0, 0, 0.55)',
            }}>
              {/* Header: workspace badge + title + close */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)', fontSize: 15, fontWeight: 700,
                }}>{(workspace.activeWorkspace?.name ?? '?').slice(0, 1).toUpperCase()}</div>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Workspace Settings</h2>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>{workspace.activeWorkspace?.name ?? 'N/A'}</div>
                </div>
                <button
                  onClick={() => setShowSettings(false)}
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
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--bg-primary)', padding: 20 }}>
                <Card title="Working directory" desc="New terminals and IDE containers open in this directory.">
                  <div style={{
                    padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg-primary)',
                    color: wsSettingsDraft.workingDirectory ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontSize: 12, fontFamily: 'var(--font-mono)', marginBottom: 12, wordBreak: 'break-all',
                  }}>
                    {wsSettingsDraft.workingDirectory ?? 'Not set'}
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      onClick={async () => {
                        const dir = await window.electronAPI.selectDirectory();
                        if (dir) patchWsDraft({ workingDirectory: dir });
                      }}
                      style={ghostBtnStyle}
                    >
                      Select directory
                    </button>
                    <button
                      onClick={() => patchWsDraft({ workingDirectory: null })}
                      style={{ ...ghostBtnStyle, background: 'transparent' }}
                    >
                      Clear
                    </button>
                  </div>
                </Card>

                <Card
                  title="Notifications"
                  desc="Sound when a terminal finishes (Done) here while this workspace is in the background or the window is unfocused. Unset values inherit the app defaults."
                >
                  <Toggle
                    label="Mute this workspace"
                    checked={wsSettingsDraft.notifyMuted}
                    onChange={(v) => patchWsDraft({ notifyMuted: v })}
                  />
                  <div style={{ opacity: wsSettingsDraft.notifyMuted ? 0.5 : 1, marginTop: 14 }}>
                    <Row label="Sound">
                      <PSelect
                        value={wsSettingsDraft.notifySoundId ?? ''}
                        onValue={(v) => patchWsDraft({ notifySoundId: v === '' ? null : v })}
                      >
                        <option value="">Inherit default</option>
                        {SOUNDS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                        <option value={SILENT_SOUND_ID}>Silent</option>
                      </PSelect>
                      <button
                        onClick={() => playSound(
                          (wsSettingsDraft.notifySoundId ?? '') === '' ? appSettings.settings.defaultSoundId : (wsSettingsDraft.notifySoundId as string),
                          wsSettingsDraft.notifyVolume ?? appSettings.settings.defaultVolume
                        )}
                        style={ghostBtnStyle}
                      >
                        ▶ Test
                      </button>
                    </Row>
                    <Row label="Volume">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                        <input
                          type="checkbox"
                          checked={typeof wsSettingsDraft.notifyVolume === 'number'}
                          onChange={(e) => patchWsDraft({ notifyVolume: e.target.checked ? appSettings.settings.defaultVolume : null })}
                          style={{ accentColor: 'var(--accent)' }}
                        />
                        Override
                      </label>
                      <input
                        type="range" min={0} max={1} step={0.05}
                        value={wsSettingsDraft.notifyVolume ?? appSettings.settings.defaultVolume}
                        disabled={typeof wsSettingsDraft.notifyVolume !== 'number'}
                        onChange={(e) => patchWsDraft({ notifyVolume: Number(e.target.value) })}
                        style={{ flex: 1, maxWidth: 200, opacity: typeof wsSettingsDraft.notifyVolume === 'number' ? 1 : 0.4, accentColor: 'var(--accent)' }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 38, textAlign: 'right' }}>
                        {Math.round((wsSettingsDraft.notifyVolume ?? appSettings.settings.defaultVolume) * 100)}%
                      </span>
                    </Row>
                  </div>
                </Card>

                <Card
                  title="SFTP auto sync"
                  desc="Upload files on save to one or more remote SFTP targets."
                  right={
                    <div style={{ display: 'flex', gap: 8 }}>
                      {syncNowId ? (
                        <button
                          onClick={() => { void window.electronAPI.cancelSftpSync(syncNowId); }}
                          style={{ ...ghostBtnStyle, padding: '7px 12px', color: 'var(--accent-red)' }}
                        >
                          Cancel
                        </button>
                      ) : (
                        <button
                          onClick={async () => {
                            if (wsSettingsDirty) {
                              setSyncNowStatus('Save changes first');
                              return;
                            }
                            if (!workspace.activeWorkspaceId || !workspace.activeWorkspace?.workingDirectory) {
                              setSyncNowStatus('Set Working Directory first');
                              return;
                            }
                            const syncId = crypto.randomUUID();
                            setSyncNowId(syncId);
                            setSyncNowStatus('Running sync...');
                            try {
                              const result = await window.electronAPI.runWorkspaceSyncNow({
                                workspaceId: workspace.activeWorkspaceId,
                                localRootPath: workspace.activeWorkspace.workingDirectory,
                                sync: ensureSyncConfig(),
                                syncId,
                              });
                              const now = Date.now();
                              for (const tr of result.targetResults) {
                                workspace.updateWorkspaceSyncTargetStatus(workspace.activeWorkspaceId, tr.targetId, {
                                  lastSyncAt: now,
                                  lastSyncStatus: tr.ok ? 'success' : 'error',
                                  lastSyncError: tr.ok ? undefined : tr.error ?? 'Sync failed',
                                });
                              }
                              workspace.updateWorkspaceSync(workspace.activeWorkspaceId, (sync) => {
                                const nextLogs = [...(sync.logs ?? [])];
                                nextLogs.push({
                                  id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
                                  at: now,
                                  action: 'sync-now',
                                  filePath: workspace.activeWorkspace?.workingDirectory ?? '.',
                                  ok: result.targetResults.every((t) => t.ok),
                                  message: `scanned ${result.scanned}, uploaded ${result.uploaded}, skipped ${result.skippedByGitIgnore}${result.cancelled ? ' (cancelled)' : ''}`,
                                });
                                if (nextLogs.length > 400) {
                                  nextLogs.splice(0, nextLogs.length - 400);
                                }
                                return { ...sync, logs: nextLogs };
                              });
                              setSyncNowStatus(
                                `${result.cancelled ? 'Cancelled' : 'Done'}: scanned ${result.scanned}, uploaded ${result.uploaded}, skipped ${result.skippedByGitIgnore}`
                              );
                            } finally {
                              setSyncNowId(null);
                            }
                          }}
                          style={{ ...ghostBtnStyle, padding: '7px 12px' }}
                        >
                          Sync now
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setWsSettingsDraft((d) => {
                            if (!d) return d;
                            const nextIndex = d.targets.length + 1;
                            return {
                              ...d,
                              targets: [
                                ...d.targets,
                                {
                                  id: `target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                                  name: `Target ${nextIndex}`,
                                  enabled: true,
                                  connectionId: null,
                                  remotePath: '',
                                },
                              ],
                            };
                          });
                          setWsSettingsSaved(false);
                        }}
                        style={{ ...ghostBtnStyle, padding: '7px 12px' }}
                      >
                        + Add target
                      </button>
                    </div>
                  }
                >
                  <Toggle
                    label="Enable SFTP sync on save"
                    checked={wsSettingsDraft.enabled}
                    onChange={(v) => patchWsDraft({ enabled: v })}
                  />
                  <div style={{ marginTop: 14 }}>
                    <Toggle
                      label="Use .gitignore to exclude files"
                      checked={wsSettingsDraft.useGitIgnore}
                      onChange={(v) => patchWsDraft({ useGitIgnore: v })}
                      desc={<>Skip anything matched by the project's <code>.gitignore</code> when syncing.</>}
                    />
                  </div>

                  {syncNowStatus && <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '14px 0 6px' }}>{syncNowStatus}</div>}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
                    {wsSettingsDraft.targets.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No targets configured.</div>
                    ) : (
                      wsSettingsDraft.targets.map((target) => (
                        <div key={target.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg-primary)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                            <PInput value={target.name} onValue={(v) => patchWsTarget(target.id, { name: v })} style={{ width: 200, fontWeight: 600 }} />
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
                                <input
                                  type="checkbox"
                                  checked={target.enabled}
                                  onChange={(e) => patchWsTarget(target.id, { enabled: e.target.checked })}
                                  style={{ accentColor: 'var(--accent)' }}
                                />
                                Enabled
                              </label>
                              <button
                                onClick={() => {
                                  setWsSettingsDraft((d) =>
                                    d ? { ...d, targets: d.targets.filter((t) => t.id !== target.id) } : d
                                  );
                                  setWsSettingsSaved(false);
                                }}
                                style={{ ...ghostBtnStyle, padding: '5px 9px', fontSize: 11, color: 'var(--accent-red)' }}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                          <div style={{ marginBottom: 8 }}>
                            <PSelect grow value={target.connectionId ?? ''} onValue={(v) => patchWsTarget(target.id, { connectionId: v || null })}>
                              <option value="">Select saved connection</option>
                              {terminals.savedConnections.map((conn) => (
                                <option key={conn.id} value={conn.id}>
                                  {conn.label} ({conn.username}@{conn.host}:{conn.port})
                                </option>
                              ))}
                            </PSelect>
                          </div>
                          <PInput grow value={target.remotePath} onValue={(v) => patchWsTarget(target.id, { remotePath: v })} placeholder="/var/www/project" />
                          <div style={{ marginTop: 8, fontSize: 11, color: target.lastSyncStatus === 'error' ? 'var(--accent-red)' : 'var(--text-muted)' }}>
                            {target.lastSyncAt
                              ? `Last sync: ${new Date(target.lastSyncAt).toLocaleTimeString()}${target.lastSyncStatus === 'error' ? ` (error: ${target.lastSyncError ?? 'unknown'})` : ' (ok)'}`
                              : 'No sync events yet'}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </Card>

                <Card
                  title="Sync logs"
                  right={
                    <button
                      onClick={() => {
                        if (!workspace.activeWorkspaceId) return;
                        workspace.updateWorkspaceSync(workspace.activeWorkspaceId, (sync) => ({ ...sync, logs: [] }));
                      }}
                      style={{ ...ghostBtnStyle, padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}
                    >
                      Clear logs
                    </button>
                  }
                >
                  <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg-primary)' }}>
                    {(workspace.activeWorkspace?.sync?.logs ?? []).length === 0 ? (
                      <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)' }}>No sync logs yet.</div>
                    ) : (
                      [...(workspace.activeWorkspace?.sync?.logs ?? [])]
                        .slice(-120)
                        .reverse()
                        .map((log) => (
                          <div
                            key={log.id}
                            style={{
                              padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: 11,
                              color: log.ok ? 'var(--text-secondary)' : 'var(--accent-red)',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                              <span>{log.action}</span>
                              <span style={{ color: 'var(--text-muted)' }}>{new Date(log.at).toLocaleTimeString()}</span>
                            </div>
                            <div style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {log.filePath}
                            </div>
                            <div>{log.message}</div>
                          </div>
                        ))
                    )}
                  </div>
                </Card>
              </div>

              {/* Footer: Save commits the draft, like the global settings. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '1px solid var(--border)' }}>
                <button onClick={saveWorkspaceSettings} disabled={!wsSettingsDirty} style={primaryBtnStyle(wsSettingsDirty)}>
                  Save
                </button>
                {wsSettingsDirty
                  ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Unsaved changes</span>
                  : wsSettingsSaved
                    ? <span style={{ fontSize: 12, color: 'var(--accent-green)' }}>✓ Saved</span>
                    : null}
              </div>
            </div>
          </div>
        )}
      </div>

      <StatusBar
        activeWorkspace={workspace.activeWorkspace ?? null}
        sessionById={allSessionsMap}
        getRendererMetricsSnapshot={terminals.getRendererMetricsSnapshot}
        onOpenResources={() => setShowResources(true)}
        onOpenSyncSettings={() => setShowSettings(true)}
      />

      {allTerminalEntries.map(({ workspaceId, container, zoomLevel }) => {
        const session = container.content.terminalId
          ? allSessionsMap.get(container.content.terminalId)
          : undefined;
        return (
          <TerminalPortal
            key={container.id}
            container={container}
            workspaceId={workspaceId}
            visible={workspaceId === workspace.activeWorkspaceId}
            session={session}
            zoomLevel={zoomLevel}
            sendData={terminals.sendData}
            resize={terminals.resize}
            getBuffer={terminals.getBuffer}
            registerWriter={terminals.registerWriter}
            unregisterWriter={terminals.unregisterWriter}
            reportRendererMetrics={terminals.reportRendererMetrics}
            removeRendererMetrics={terminals.removeRendererMetrics}
            onClose={() => handleCloseContainer(container.id)}
            onReconnect={
              session?.type === 'ssh'
                ? () => handleReconnectContainer(container.id)
                : undefined
            }
            onSplitRight={() =>
              workspace.splitContainer(container.id, 'horizontal', 'after')
            }
            onSplitDown={() =>
              workspace.splitContainer(container.id, 'vertical', 'after')
            }
            onOpenAgentBrowser={handleOpenAgentBrowser}
            onRename={(name) => handleRenameTerminal(container.id, name)}
            streaming={!!(container.content.type === 'terminal' && container.content.streamToWeb)}
            canStream={signedIn}
            onToggleStreaming={(enabled, live) => handleToggleStreaming(workspaceId, container, enabled, live)}
            terminalRenderer={appSettings.settings.terminalRenderer ?? 'xterm'}
            workspaceSwitchToken={workspace.activeWorkspaceId ?? undefined}
          />
        );
      })}

      {ideContainers.map((c) => (
        <IDEPortal
          key={c.id}
          workspaceId={workspace.activeWorkspaceId ?? ''}
          containerId={c.id}
          rootPath={c.content.rootPath!}
          zoomLevel={workspace.activeWorkspace?.containerZooms?.[c.id] ?? 13}
          workspaceSync={workspace.activeWorkspace?.sync}
          syncedFileStates={workspace.activeWorkspace?.sync?.fileStates}
          onSyncEvent={({ action, filePath, oldPath, isDirectory, skippedByGitIgnore, targetResults, at }) => {
            if (!workspace.activeWorkspaceId) return;
            const workspaceId = workspace.activeWorkspaceId;
            for (const target of targetResults) {
              workspace.updateWorkspaceSyncTargetStatus(workspaceId, target.targetId, {
                lastSyncAt: at,
                lastSyncStatus: target.ok ? 'success' : 'error',
                lastSyncError: target.ok ? undefined : target.error ?? 'Sync failed',
              });
            }
            workspace.updateWorkspaceSync(workspaceId, (sync) => {
              const nextFileStates = { ...(sync.fileStates ?? {}) };
              const nextLogs = [...(sync.logs ?? [])];

              if (oldPath && oldPath !== filePath) {
                for (const key of Object.keys(nextFileStates)) {
                  if (key === oldPath || key.startsWith(`${oldPath}/`)) {
                    delete nextFileStates[key];
                  }
                }
              }
              if (action === 'delete') {
                for (const key of Object.keys(nextFileStates)) {
                  if (key === filePath || (isDirectory && key.startsWith(`${filePath}/`))) {
                    delete nextFileStates[key];
                  }
                }
              } else {
                const status = skippedByGitIgnore
                  ? 'skipped'
                  : targetResults.some((t) => !t.ok)
                    ? 'error'
                    : targetResults.some((t) => t.ok)
                      ? 'synced'
                      : 'skipped';
                nextFileStates[filePath] = { status, updatedAt: at };
              }

              if (skippedByGitIgnore) {
                nextLogs.push({
                  id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
                  at,
                  action,
                  filePath,
                  ok: true,
                  message: 'Skipped by .gitignore',
                });
              } else if (targetResults.length === 0) {
                nextLogs.push({
                  id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
                  at,
                  action,
                  filePath,
                  ok: false,
                  message: 'No active sync targets',
                });
              } else {
                for (const tr of targetResults) {
                  nextLogs.push({
                    id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
                    at,
                    action,
                    filePath,
                    targetId: tr.targetId,
                    ok: tr.ok,
                    message: tr.ok ? 'Synced' : (tr.error ?? 'Sync failed'),
                  });
                }
              }

              const MAX_LOGS = 400;
              if (nextLogs.length > MAX_LOGS) {
                nextLogs.splice(0, nextLogs.length - MAX_LOGS);
              }

              return {
                ...sync,
                fileStates: nextFileStates,
                logs: nextLogs,
              };
            });
          }}
          initialState={c.content.ideState}
          onStateChange={(state) => handleIDEStateChange(c.id, state)}
          onClose={() => handleCloseContainer(c.id)}
          onSplitRight={() => workspace.splitContainer(c.id, 'horizontal', 'after')}
          onSplitDown={() => workspace.splitContainer(c.id, 'vertical', 'after')}
        />
      ))}

      {allBrowserEntries.map(({ workspaceId, container, zoomLevel }) => (
        <BrowserPortal
          key={container.id}
          container={container}
          workspaceId={workspaceId}
          visible={workspaceId === workspace.activeWorkspaceId}
          zoomLevel={zoomLevel}
          onClose={() => handleCloseContainer(container.id)}
          onSplitRight={() => workspace.splitContainer(container.id, 'horizontal', 'after')}
          onSplitDown={() => workspace.splitContainer(container.id, 'vertical', 'after')}
          onUrlChange={(url) => handleBrowserUrlChange(container.id, url)}
          onRequestFocus={workspace.setFocusedContainer}
        />
      ))}

      {showAppSettings && (
        <SettingsModal
          onClose={() => setShowAppSettings(false)}
          initialTab={appSettingsTab}
          settings={appSettings.settings}
          onUpdateSettings={appSettings.update}
          savedConnections={terminals.savedConnections}
          onSaveConnection={terminals.saveConnection}
          onUpdateConnection={terminals.updateConnection}
          onDeleteConnection={terminals.deleteSavedConnection}
          onTestConnection={terminals.testSavedConnection}
        />
      )}

      {showResources && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setShowResources(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div style={{
            background: 'var(--bg-surface)', borderRadius: '12px',
            width: '92vw', maxWidth: '1100px', height: '82vh',
            display: 'flex', flexDirection: 'column',
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)', overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 18px', borderBottom: '1px solid var(--border)',
            }}>
              <h2 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                Resources
              </h2>
              <button
                onClick={() => setShowResources(false)}
                title="Close"
                style={{
                  width: 24, height: 24, borderRadius: 6, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 16, lineHeight: 1, color: 'var(--text-muted)',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
              >
                ✕
              </button>
            </div>
            <WorkspaceTaskManager
              workspaces={workspace.workspaces}
              activeWorkspaceId={workspace.activeWorkspaceId}
              getRendererMetricsSnapshot={terminals.getRendererMetricsSnapshot}
            />
          </div>
        </div>
      )}

      {showEnvironmentPicker && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 12000,
            background: 'rgba(0, 0, 0, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
          onMouseDown={() => setShowEnvironmentPicker(false)}
        >
          <div
            style={{
              width: 'min(920px, 100%)',
              height: 'min(720px, calc(100vh - 40px))',
              borderRadius: 12,
              overflow: 'hidden',
              border: '1px solid var(--border)',
              boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
              background: 'var(--bg-primary)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <EnvironmentPicker
              embedded
              onRequestClose={() => setShowEnvironmentPicker(false)}
            />
          </div>
        </div>
      )}

      {/* Always mounted so a recent chat survives a brief grace window after
          closing (resume on reopen); `open` drives visibility. */}
      <QuickChatPalette
        open={showQuickChat}
        onClose={() => setShowQuickChat(false)}
        configured={!!appSettings.settings.fastChat?.baseUrl && !!appSettings.settings.fastChat?.model}
        models={(() => {
          const fc = appSettings.settings.fastChat;
          if (!fc?.model) return [];
          const list = fc.models && fc.models.length ? fc.models : [fc.model];
          return list.includes(fc.model) ? list : [fc.model, ...list];
        })()}
        defaultModel={appSettings.settings.fastChat?.model ?? ''}
        resumeGraceMs={(appSettings.settings.quickChatResumeGraceSec ?? 300) * 1000}
        onOpenSettings={() => { setShowQuickChat(false); setAppSettingsTab('fastChat'); setShowAppSettings(true); }}
      />
    </div>
  );
};

export default App;
