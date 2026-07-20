import { useState, useCallback, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type {
  Workspace,
  LayoutNode,
  LeafNode,
  SplitNode,
  SplitDirection,
  ContainerContent,
  WorkspaceSyncConfig,
  WorkspaceSyncTarget,
  WorkspaceTodo,
  SavedCommand,
  RecentCommand,
  SavedPrompt,
} from '../../shared/types';

// Cap on the rolling "recently run" command feed (environment-scoped).
const RECENT_COMMAND_LIMIT = 40;

// --- Tree helpers ---

function replaceLeaf(node: LayoutNode, containerId: string, replacement: LayoutNode): LayoutNode {
  if (node.type === 'leaf') {
    return node.containerId === containerId ? replacement : node;
  }
  const newFirst = replaceLeaf(node.first, containerId, replacement);
  if (newFirst !== node.first) return { ...node, first: newFirst };
  const newSecond = replaceLeaf(node.second, containerId, replacement);
  if (newSecond !== node.second) return { ...node, second: newSecond };
  return node;
}

function removeLeaf(tree: LayoutNode, containerId: string): LayoutNode | null {
  if (tree.type === 'leaf') {
    return tree.containerId === containerId ? null : tree;
  }
  // Direct child match → promote sibling
  if (tree.first.type === 'leaf' && tree.first.containerId === containerId) return tree.second;
  if (tree.second.type === 'leaf' && tree.second.containerId === containerId) return tree.first;
  // Recurse
  const newFirst = removeLeaf(tree.first, containerId);
  if (newFirst !== tree.first) return { ...tree, first: newFirst! };
  const newSecond = removeLeaf(tree.second, containerId);
  if (newSecond !== tree.second) return { ...tree, second: newSecond! };
  return tree;
}

function firstLeafId(node: LayoutNode): string | null {
  if (node.type === 'leaf') return node.containerId;
  return firstLeafId(node.first) ?? firstLeafId(node.second);
}

function swapLeaves(node: LayoutNode, id1: string, id2: string): LayoutNode {
  if (node.type === 'leaf') {
    if (node.containerId === id1) return { ...node, containerId: id2 };
    if (node.containerId === id2) return { ...node, containerId: id1 };
    return node;
  }
  return { ...node, first: swapLeaves(node.first, id1, id2), second: swapLeaves(node.second, id1, id2) };
}

// --- Default workspace ---

function createDefaultWorkspace(): Workspace {
  const now = Date.now();
  return {
    id: uuidv4(),
    name: 'Default',
    workingDirectory: null,
    sync: {
      enabled: false,
      useGitIgnore: true,
      targets: [],
      fileStates: {},
      logs: [],
    },
    layoutTree: null,
    containers: [],
    containerZooms: {},
    focusedContainerId: null,
    createdAt: now,
    updatedAt: now,
  };
}

const initialWorkspace = createDefaultWorkspace();

// --- Hook ---

export function useWorkspace() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([initialWorkspace]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(initialWorkspace.id);
  // Environment-wide todos (scoped to the workspace set, not a single workspace).
  const [envTodos, setEnvTodos] = useState<WorkspaceTodo[]>([]);
  // Environment-wide favorite commands + the rolling recent-command feed (both
  // scoped to the workspace set, persisted with it).
  const [envCommandFavorites, setEnvCommandFavorites] = useState<SavedCommand[]>([]);
  const [recentCommands, setRecentCommands] = useState<RecentCommand[]>([]);
  // Environment-wide reusable prompts (scoped to the workspace set).
  const [envPrompts, setEnvPrompts] = useState<SavedPrompt[]>([]);

  const resolvedActiveId = activeWorkspaceId ?? workspaces[0]?.id ?? null;

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === resolvedActiveId) ?? null,
    [workspaces, resolvedActiveId]
  );

  const updateActiveWorkspace = useCallback(
    (updater: (ws: Workspace) => Workspace) => {
      setWorkspaces((prev) =>
        prev.map((ws) => (ws.id !== resolvedActiveId ? ws : updater(ws)))
      );
    },
    [resolvedActiveId]
  );

  // Add first container (when tree is empty)
  const addFirstContainer = useCallback(
    (content: ContainerContent): string => {
      const id = uuidv4();
      const now = Date.now();
      updateActiveWorkspace((ws) => ({
        ...ws,
        layoutTree: { type: 'leaf', containerId: id },
        containers: [...ws.containers, { id, content }],
        containerZooms: { ...ws.containerZooms, [id]: 13 },
        updatedAt: now,
      }));
      return id;
    },
    [updateActiveWorkspace]
  );

  // Split an existing container
  const splitContainer = useCallback(
    (containerId: string, direction: SplitDirection, position: 'before' | 'after'): string => {
      const newId = uuidv4();
      const now = Date.now();
      const newLeaf: LeafNode = { type: 'leaf', containerId: newId };
      const currentLeaf: LeafNode = { type: 'leaf', containerId };
      const splitNode: SplitNode = {
        type: 'split',
        direction,
        ratio: 0.5,
        first: position === 'before' ? newLeaf : currentLeaf,
        second: position === 'after' ? newLeaf : currentLeaf,
      };
      updateActiveWorkspace((ws) => ({
        ...ws,
        layoutTree: ws.layoutTree ? replaceLeaf(ws.layoutTree, containerId, splitNode) : splitNode,
        containers: [...ws.containers, { id: newId, content: { type: 'empty' } }],
        containerZooms: { ...ws.containerZooms, [newId]: 13 },
        updatedAt: now,
      }));
      return newId;
    },
    [updateActiveWorkspace]
  );

  // Create a filled container in a SPECIFIC workspace (not necessarily the
  // active one) — used by the agent browser bridge to open a browser pane in the
  // workspace the calling terminal lives in. Splits the workspace's focused (or
  // first) leaf; on an empty workspace it becomes the root.
  const createBrowserContainer = useCallback(
    (workspaceId: string, content: ContainerContent): string => {
      const id = uuidv4();
      const now = Date.now();
      setWorkspaces((prev) =>
        prev.map((ws) => {
          if (ws.id !== workspaceId) return ws;
          if (!ws.layoutTree) {
            return {
              ...ws,
              layoutTree: { type: 'leaf', containerId: id },
              containers: [...ws.containers, { id, content }],
              containerZooms: { ...ws.containerZooms, [id]: 13 },
              updatedAt: now,
            };
          }
          const anchor =
            ws.focusedContainerId && ws.containers.some((c) => c.id === ws.focusedContainerId)
              ? ws.focusedContainerId
              : firstLeafId(ws.layoutTree);
          if (!anchor) return ws;
          const splitNode: SplitNode = {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', containerId: anchor },
            second: { type: 'leaf', containerId: id },
          };
          return {
            ...ws,
            layoutTree: replaceLeaf(ws.layoutTree, anchor, splitNode),
            containers: [...ws.containers, { id, content }],
            containerZooms: { ...ws.containerZooms, [id]: 13 },
            updatedAt: now,
          };
        }),
      );
      return id;
    },
    [],
  );

  // Update container content
  const updateContainerContent = useCallback(
    (containerId: string, content: ContainerContent) => {
      const now = Date.now();
      setWorkspaces((prev) =>
        prev.map((ws) => {
          let changed = false;
          const containers = ws.containers.map((c) => {
            if (c.id !== containerId) return c;
            changed = true;
            return { ...c, content };
          });
          return changed ? { ...ws, containers, updatedAt: now } : ws;
        }),
      );
    },
    []
  );

  // Remove container
  const removeContainer = useCallback(
    (containerId: string) => {
      updateActiveWorkspace((ws) => {
        const { [containerId]: _removedZoom, ...restZooms } = ws.containerZooms;
        const newTree = ws.layoutTree ? removeLeaf(ws.layoutTree, containerId) : null;
        return {
          ...ws,
          layoutTree: newTree,
          containers: ws.containers.filter((c) => c.id !== containerId),
          containerZooms: restZooms,
          focusedContainerId:
            ws.focusedContainerId === containerId ? null : ws.focusedContainerId,
          updatedAt: Date.now(),
        };
      });
    },
    [updateActiveWorkspace]
  );

  // Remove a container from whichever workspace holds it (not just the active
  // one) — used when a terminal exits in a background workspace.
  const removeContainerAnywhere = useCallback((containerId: string) => {
    setWorkspaces((prev) =>
      prev.map((ws) => {
        if (!ws.containers.some((c) => c.id === containerId)) return ws;
        const { [containerId]: _removedZoom, ...restZooms } = ws.containerZooms;
        return {
          ...ws,
          layoutTree: ws.layoutTree ? removeLeaf(ws.layoutTree, containerId) : null,
          containers: ws.containers.filter((c) => c.id !== containerId),
          containerZooms: restZooms,
          focusedContainerId:
            ws.focusedContainerId === containerId ? null : ws.focusedContainerId,
          updatedAt: Date.now(),
        };
      })
    );
  }, []);

  // Update entire tree (for resize ratio changes)
  const updateLayoutTree = useCallback(
    (tree: LayoutNode) => {
      const now = Date.now();
      updateActiveWorkspace((ws) => ({ ...ws, layoutTree: tree, updatedAt: now }));
    },
    [updateActiveWorkspace]
  );

  // Swap two containers in the tree
  const swapContainers = useCallback(
    (id1: string, id2: string) => {
      updateActiveWorkspace((ws) => ({
        ...ws,
        layoutTree: ws.layoutTree ? swapLeaves(ws.layoutTree, id1, id2) : null,
        updatedAt: Date.now(),
      }));
    },
    [updateActiveWorkspace]
  );

  // Workspace CRUD
  const createWorkspace = useCallback((name: string) => {
    const ws = createDefaultWorkspace();
    ws.name = name;
    setWorkspaces((prev) => [...prev, ws]);
    setActiveWorkspaceId(ws.id);
    return ws;
  }, []);

  // Re-add a previously-closed workspace snapshot (from "Open Recent"). Never
  // restore a frozen flag — its processes are gone and will respawn running.
  const addWorkspace = useCallback((ws: Workspace) => {
    const restored: Workspace = { ...ws, frozen: false, updatedAt: Date.now() };
    setWorkspaces((prev) =>
      prev.some((w) => w.id === restored.id) ? prev : [...prev, restored]
    );
    setActiveWorkspaceId(restored.id);
    return restored;
  }, []);

  const deleteWorkspace = useCallback(
    (id: string) => {
      setWorkspaces((prev) => {
        const remaining = prev.filter((w) => w.id !== id);
        if (remaining.length === 0) {
          setActiveWorkspaceId(null);
          return [];
        }
        if (resolvedActiveId === id) setActiveWorkspaceId(remaining[0].id);
        return remaining;
      });
    },
    [resolvedActiveId]
  );

  const switchWorkspace = useCallback((id: string) => setActiveWorkspaceId(id), []);

  // Switch to a workspace AND focus one of its containers in a single pass —
  // setFocusedContainer alone only targets the (old) active workspace, so it
  // can't focus a container that lives in a different workspace.
  const focusContainerInWorkspace = useCallback((workspaceId: string, containerId: string) => {
    setActiveWorkspaceId(workspaceId);
    setWorkspaces((prev) =>
      prev.map((ws) =>
        ws.id !== workspaceId || ws.focusedContainerId === containerId
          ? ws
          : { ...ws, focusedContainerId: containerId, updatedAt: Date.now() }
      )
    );
  }, []);

  const renameWorkspace = useCallback((id: string, name: string) => {
    setWorkspaces((prev) =>
      prev.map((ws) => (ws.id !== id ? ws : { ...ws, name, updatedAt: Date.now() }))
    );
  }, []);

  const reorderWorkspaces = useCallback((fromIndex: number, toIndex: number) => {
    setWorkspaces((prev) => {
      if (fromIndex < 0 || fromIndex >= prev.length || toIndex < 0 || toIndex >= prev.length || fromIndex === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const setWorkspaceWorkingDirectory = useCallback((id: string, directory: string | null) => {
    setWorkspaces((prev) =>
      prev.map((ws) =>
        ws.id !== id ? ws : { ...ws, workingDirectory: directory, updatedAt: Date.now() }
      )
    );
  }, []);

  const setWorkspaceFrozen = useCallback((id: string, frozen: boolean) => {
    setWorkspaces((prev) =>
      prev.map((ws) => (ws.id !== id ? ws : { ...ws, frozen, updatedAt: Date.now() }))
    );
  }, []);

  const setWorkspaceNotify = useCallback(
    (id: string, patch: Partial<Pick<Workspace, 'notifySoundId' | 'notifyVolume' | 'notifyMuted'>>) => {
      setWorkspaces((prev) =>
        prev.map((ws) => (ws.id !== id ? ws : { ...ws, ...patch, updatedAt: Date.now() }))
      );
    },
    []
  );

  const setWorkspaceNotes = useCallback((id: string, notes: string) => {
    setWorkspaces((prev) =>
      prev.map((ws) => (ws.id !== id ? ws : { ...ws, notes, updatedAt: Date.now() }))
    );
  }, []);

  // Record that an SSH connection was opened in this workspace: float it to the
  // front of the workspace's recency list (deduped, capped). Powers the
  // "Recently used" section of the connect dialog.
  const RECENT_CONNECTIONS_CAP = 8;
  const recordConnectionUse = useCallback((workspaceId: string, connectionId: string) => {
    if (!connectionId) return;
    setWorkspaces((prev) =>
      prev.map((ws) => {
        if (ws.id !== workspaceId) return ws;
        const next = [connectionId, ...(ws.recentConnectionIds ?? []).filter((id) => id !== connectionId)]
          .slice(0, RECENT_CONNECTIONS_CAP);
        return { ...ws, recentConnectionIds: next, updatedAt: Date.now() };
      })
    );
  }, []);

  const updateWorkspaceTodos = useCallback(
    (id: string, updater: (todos: WorkspaceTodo[]) => WorkspaceTodo[]) => {
      setWorkspaces((prev) =>
        prev.map((ws) =>
          ws.id !== id ? ws : { ...ws, todos: updater(ws.todos ?? []), updatedAt: Date.now() }
        )
      );
    },
    []
  );

  // Environment-wide todos (one list per workspace set).
  const updateEnvTodos = useCallback(
    (updater: (todos: WorkspaceTodo[]) => WorkspaceTodo[]) => {
      setEnvTodos((prev) => updater(prev ?? []));
    },
    []
  );

  // --- Terminal commands: recent feed + favorites ---

  // Record a command into the environment-wide recent feed: dedupe by text,
  // move-to-front, bump its count, and cap the list.
  const recordRecentCommand = useCallback((command: string) => {
    const cmd = command.trim();
    if (!cmd) return;
    setRecentCommands((prev) => {
      const existing = prev.find((r) => r.command === cmd);
      const rest = prev.filter((r) => r.command !== cmd);
      const entry: RecentCommand = {
        command: cmd,
        lastUsedAt: Date.now(),
        count: (existing?.count ?? 0) + 1,
      };
      return [entry, ...rest].slice(0, RECENT_COMMAND_LIMIT);
    });
  }, []);

  const removeRecentCommand = useCallback((command: string) => {
    setRecentCommands((prev) => prev.filter((r) => r.command !== command));
  }, []);

  const clearRecentCommands = useCallback(() => setRecentCommands([]), []);

  // Environment-wide favorite commands (one list per workspace set).
  const updateEnvCommandFavorites = useCallback(
    (updater: (favorites: SavedCommand[]) => SavedCommand[]) => {
      setEnvCommandFavorites((prev) => updater(prev ?? []));
    },
    []
  );

  // Environment-wide reusable prompts (one list per workspace set).
  const updateEnvPrompts = useCallback(
    (updater: (prompts: SavedPrompt[]) => SavedPrompt[]) => {
      setEnvPrompts((prev) => updater(prev ?? []));
    },
    []
  );

  // Per-workspace favorite commands.
  const updateWorkspaceCommandFavorites = useCallback(
    (id: string, updater: (favorites: SavedCommand[]) => SavedCommand[]) => {
      setWorkspaces((prev) =>
        prev.map((ws) =>
          ws.id !== id
            ? ws
            : { ...ws, commandFavorites: updater(ws.commandFavorites ?? []), updatedAt: Date.now() }
        )
      );
    },
    []
  );

  const setWorkspaceSyncConfig = useCallback((id: string, sync: WorkspaceSyncConfig) => {
    setWorkspaces((prev) =>
      prev.map((ws) =>
        ws.id !== id ? ws : { ...ws, sync, updatedAt: Date.now() }
      )
    );
  }, []);

  const updateWorkspaceSync = useCallback(
    (id: string, updater: (sync: WorkspaceSyncConfig) => WorkspaceSyncConfig) => {
      setWorkspaces((prev) =>
        prev.map((ws) => {
          if (ws.id !== id) return ws;
          const base: WorkspaceSyncConfig = ws.sync ?? {
            enabled: false,
            useGitIgnore: true,
            targets: [],
            fileStates: {},
            logs: [],
          };
          return {
            ...ws,
            sync: updater(base),
            updatedAt: Date.now(),
          };
        })
      );
    },
    []
  );

  const updateWorkspaceSyncTargetStatus = useCallback(
    (
      id: string,
      targetId: string,
      patch: Pick<WorkspaceSyncTarget, 'lastSyncAt' | 'lastSyncStatus' | 'lastSyncError'>
    ) => {
      setWorkspaces((prev) =>
        prev.map((ws) => {
          if (ws.id !== id) return ws;
          const sync = ws.sync ?? { enabled: false, useGitIgnore: true, targets: [] };
          return {
            ...ws,
            sync: {
              ...sync,
              targets: sync.targets.map((t) => (t.id === targetId ? { ...t, ...patch } : t)),
            },
            updatedAt: Date.now(),
          };
        })
      );
    },
    []
  );

  const setContainerZoom = useCallback(
    (containerId: string, zoomLevel: number) => {
      const now = Date.now();
      updateActiveWorkspace((ws) => ({
        ...ws,
        containerZooms: { ...ws.containerZooms, [containerId]: zoomLevel },
        updatedAt: now,
      }));
    },
    [updateActiveWorkspace]
  );

  const setFocusedContainer = useCallback(
    (containerId: string | null) => {
      updateActiveWorkspace((ws) => {
        if (ws.focusedContainerId === containerId) return ws;
        return {
          ...ws,
          focusedContainerId: containerId,
          updatedAt: Date.now(),
        };
      });
    },
    [updateActiveWorkspace]
  );

  const hydrateState = useCallback((state: { activeWorkspaceId: string | null; workspaces: Workspace[]; envTodos?: WorkspaceTodo[]; envCommandFavorites?: SavedCommand[]; recentCommands?: RecentCommand[]; envPrompts?: SavedPrompt[] } | null) => {
    if (!state || !Array.isArray(state.workspaces) || state.workspaces.length === 0) return;
    setEnvTodos(Array.isArray(state.envTodos) ? state.envTodos : []);
    setEnvCommandFavorites(Array.isArray(state.envCommandFavorites) ? state.envCommandFavorites : []);
    setRecentCommands(Array.isArray(state.recentCommands) ? state.recentCommands : []);
    setEnvPrompts(Array.isArray(state.envPrompts) ? state.envPrompts : []);
    const normalized = state.workspaces.map((ws) => {
      const rawSync = ws.sync as any;
      const sync =
        rawSync && Array.isArray(rawSync.targets)
          ? {
              enabled: !!rawSync.enabled,
              useGitIgnore: rawSync.useGitIgnore ?? true,
              targets: rawSync.targets,
              fileStates: rawSync.fileStates ?? {},
              logs: rawSync.logs ?? [],
            }
          : rawSync && ('connectionId' in (rawSync ?? {}) || 'remotePath' in (rawSync ?? {}))
            ? {
                enabled: !!rawSync.enabled,
                useGitIgnore: true,
                targets: rawSync.connectionId || rawSync.remotePath
                  ? [
                      {
                        id: 'target-migrated',
                        name: 'Target 1',
                        enabled: true,
                        connectionId: rawSync.connectionId ?? null,
                        remotePath: rawSync.remotePath ?? '',
                      },
                    ]
                  : [],
                fileStates: {},
                logs: [],
              }
            : {
                enabled: false,
                useGitIgnore: true,
                targets: [],
                fileStates: {},
                logs: [],
              };
      const containers = (ws.containers ?? []).map((container) => {
        const content =
          (container.content as { type?: string } | undefined)?.type === 'terminal_v2'
            ? { ...container.content, type: 'terminal' as const }
            : container.content;
        const normalizedContainer =
          content === container.content ? container : { ...container, content };
        if (normalizedContainer.content?.type !== 'sql') return normalizedContainer;
        const current = (normalizedContainer.content.sqlState ?? {}) as {
          connectionId?: string | null;
          savedConnectionId?: string | null;
          connectionName?: string;
          host?: string;
          port?: number;
          user?: string;
          database?: string;
          ssl?: boolean;
          tabs?: Array<{ id: string; type?: string; title: string; query?: string; schema?: string; objectName?: string }>;
          activeTabId?: string | null;
          history?: unknown[];
          query?: string;
        };
        const normalizedTabs: import('../../shared/types').SQLTab[] =
          Array.isArray(current.tabs) && current.tabs.length > 0
            ? current.tabs.map((tab): import('../../shared/types').SQLTab => {
                if (tab.type === 'table' && tab.schema && tab.objectName) {
                  return {
                    id: tab.id,
                    type: 'table',
                    title: tab.title,
                    schema: tab.schema,
                    objectName: tab.objectName,
                    database: (tab as any).database ?? current.database ?? 'postgres',
                    savedConnectionId: (tab as any).savedConnectionId ?? current.savedConnectionId ?? null,
                  };
                }
                return {
                  id: tab.id,
                  type: 'query',
                  title: tab.title,
                  query: tab.query ?? 'SELECT now();',
                  database: (tab as any).database ?? current.database ?? 'postgres',
                  schema: (tab as any).schema ?? (current as any).schema ?? 'public',
                  savedConnectionId: (tab as any).savedConnectionId ?? current.savedConnectionId ?? null,
                };
              })
            : [
                {
                  id: `query-${Date.now().toString(36)}`,
                  type: 'query',
                  title: 'Query 1',
                  query: typeof current.query === 'string' ? current.query : 'SELECT now();',
                  database: current.database ?? 'postgres',
                  schema: (current as any).schema ?? 'public',
                  savedConnectionId: current.savedConnectionId ?? null,
                },
              ];
        const activeTabId =
          typeof current.activeTabId === 'string' &&
          normalizedTabs.some((tab) => tab.id === current.activeTabId)
            ? current.activeTabId
            : normalizedTabs[0]?.id ?? null;
        const history = Array.isArray(current.history)
          ? current.history
              .filter(
                (entry): entry is {
                  id: string;
                  query: string;
                  executedAt: number;
                  durationMs?: number;
                  rowCount?: number;
                  ok: boolean;
                  error?: string;
                } =>
                  !!entry &&
                  typeof entry === 'object' &&
                  typeof (entry as { id?: unknown }).id === 'string' &&
                  typeof (entry as { query?: unknown }).query === 'string' &&
                  typeof (entry as { executedAt?: unknown }).executedAt === 'number' &&
                  typeof (entry as { ok?: unknown }).ok === 'boolean'
              )
              .map((entry) => ({
                id: entry.id,
                query: entry.query,
                executedAt: entry.executedAt,
                durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : undefined,
                rowCount: typeof entry.rowCount === 'number' ? entry.rowCount : undefined,
                ok: entry.ok,
                error: typeof entry.error === 'string' ? entry.error : undefined,
              }))
          : [];
        return {
          ...normalizedContainer,
          content: {
            ...normalizedContainer.content,
            sqlState: {
              connectionId: current.connectionId ?? null,
              savedConnectionId: current.savedConnectionId ?? null,
              connectionName: current.connectionName ?? 'Postgres',
              host: current.host ?? '127.0.0.1',
              port: typeof current.port === 'number' ? current.port : 5432,
              user: current.user ?? 'postgres',
              database: current.database ?? 'postgres',
              schema: (current as any).schema ?? 'public',
              ssl: !!current.ssl,
              tabs: normalizedTabs,
              activeTabId,
              history,
            },
          },
        };
      });
      return {
        ...ws,
        containers,
        workingDirectory: ws.workingDirectory ?? null,
        sync,
        containerZooms: ws.containerZooms ?? {},
        focusedContainerId:
          typeof ws.focusedContainerId === 'string' ? ws.focusedContainerId : null,
        createdAt: ws.createdAt ?? Date.now(),
        updatedAt: ws.updatedAt ?? Date.now(),
      };
    });
    const activeId = state.activeWorkspaceId && normalized.some((ws) => ws.id === state.activeWorkspaceId)
      ? state.activeWorkspaceId
      : normalized[0].id;
    setWorkspaces(normalized);
    setActiveWorkspaceId(activeId);
  }, []);

  const activeTerminalIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeWorkspace) {
      for (const c of activeWorkspace.containers) {
        if (c.content.terminalId) ids.add(c.content.terminalId);
      }
    }
    return ids;
  }, [activeWorkspace]);

  return {
    workspaces,
    activeWorkspaceId: resolvedActiveId,
    activeWorkspace,
    activeTerminalIds,
    addFirstContainer,
    splitContainer,
    createBrowserContainer,
    updateContainerContent,
    removeContainer,
    updateLayoutTree,
    removeContainerAnywhere,
    swapContainers,
    setContainerZoom,
    setFocusedContainer,
    focusContainerInWorkspace,
    setWorkspaceWorkingDirectory,
    setWorkspaceFrozen,
    setWorkspaceNotify,
    setWorkspaceNotes,
    recordConnectionUse,
    updateWorkspaceTodos,
    envTodos,
    updateEnvTodos,
    recentCommands,
    envCommandFavorites,
    recordRecentCommand,
    removeRecentCommand,
    clearRecentCommands,
    updateEnvCommandFavorites,
    envPrompts,
    updateEnvPrompts,
    updateWorkspaceCommandFavorites,
    setWorkspaceSyncConfig,
    updateWorkspaceSync,
    updateWorkspaceSyncTargetStatus,
    hydrateState,
    createWorkspace,
    addWorkspace,
    deleteWorkspace,
    switchWorkspace,
    renameWorkspace,
    reorderWorkspaces,
  };
}
