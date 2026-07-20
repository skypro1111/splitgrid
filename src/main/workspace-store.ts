import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceState, EnvironmentSummary, Workspace } from '../shared/types';

const STORE_FILE_PREFIX = 'workspaces-state';
const RECENT_WS_FILE_PREFIX = 'recent-workspaces';
const STATE_VERSION = 1;
const RECENT_ENVS_FILE = 'recent-environments.json';
const ENV_NAMES_FILE = 'environment-names.json';
const FILE_ENV_PREFIX = 'file:';
const MAX_RECENT_ENVS = 12;
const MAX_RECENT_WORKSPACES = 30;

// When a workspace has a `workingDirectory`, we mirror its settings into a
// `.splitgrid/workspace.json` file inside that folder. This makes the workspace
// portable with its folder: point a workspace at the same directory a year later
// and its layout/notes/todos/etc. are restored from there (the folder copy is
// authoritative on load — see load()). userData keeps the canonical environment
// copy as a fallback for when the folder is missing/unmounted.
const WORKSPACE_FOLDER_DIR = '.splitgrid';
const WORKSPACE_FOLDER_FILE = 'workspace.json';

interface PersistedWorkspaceStateV1 extends WorkspaceState {
  version: number;
  savedAt: number;
}

interface PersistedWorkspaceFolderV1 {
  version: number;
  savedAt: number;
  workspace: Workspace;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

export class WorkspaceStore {
  private userDataPath: string;
  private recentEnvsFilePath: string;
  private envNamesFilePath: string;

  constructor() {
    this.userDataPath = app.getPath('userData');
    this.recentEnvsFilePath = path.join(this.userDataPath, RECENT_ENVS_FILE);
    this.envNamesFilePath = path.join(this.userDataPath, ENV_NAMES_FILE);
  }

  private normalizeSetId(setId: string): string {
    const trimmed = (setId || 'default').trim();
    const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, '-');
    return safe || 'default';
  }

  private getFilePath(setId: string): string {
    const normalized = this.normalizeSetId(setId);
    return path.join(this.userDataPath, `${STORE_FILE_PREFIX}-${normalized}.json`);
  }

  toEnvironmentRefFromPath(filePath: string): string {
    const abs = path.resolve(filePath);
    return `${FILE_ENV_PREFIX}${encodeURIComponent(abs)}`;
  }

  fromEnvironmentRefToPath(envRef: string): string | null {
    if (!envRef.startsWith(FILE_ENV_PREFIX)) return null;
    const encoded = envRef.slice(FILE_ENV_PREFIX.length);
    if (!encoded) return null;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return null;
    }
  }

  private resolveStateFilePath(envRef: string): string {
    const externalPath = this.fromEnvironmentRefToPath(envRef);
    if (externalPath) return externalPath;
    return this.getFilePath(envRef);
  }

  listRecentEnvironmentPaths(): string[] {
    try {
      if (!existsSync(this.recentEnvsFilePath)) return [];
      const raw = readFileSync(this.recentEnvsFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => path.resolve(v))
        .slice(0, MAX_RECENT_ENVS);
    } catch {
      return [];
    }
  }

  addRecentEnvironmentPath(filePath: string): void {
    const abs = path.resolve(filePath);
    const prev = this.listRecentEnvironmentPaths().filter((p) => p !== abs);
    const next = [abs, ...prev].slice(0, MAX_RECENT_ENVS);
    if (!existsSync(this.userDataPath)) {
      mkdirSync(this.userDataPath, { recursive: true });
    }
    writeFileSync(this.recentEnvsFilePath, JSON.stringify(next, null, 2), 'utf-8');
  }

  removeRecentEnvironmentPath(filePath: string): void {
    const abs = path.resolve(filePath);
    const next = this.listRecentEnvironmentPaths().filter((p) => p !== abs);
    if (!existsSync(this.userDataPath)) {
      mkdirSync(this.userDataPath, { recursive: true });
    }
    writeFileSync(this.recentEnvsFilePath, JSON.stringify(next, null, 2), 'utf-8');
  }

  private defaultEnvironmentName(envId: string, source: 'internal' | 'file', envPath?: string): string {
    if (source === 'internal') {
      return envId === 'default' ? 'Default Environment' : envId;
    }
    return envPath ? path.basename(envPath) : envId;
  }

  private readEnvironmentNames(): Record<string, string> {
    try {
      if (!existsSync(this.envNamesFilePath)) return {};
      const raw = readFileSync(this.envNamesFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed)) return {};
      const names: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value.trim().length > 0) {
          names[key] = value.trim();
        }
      }
      return names;
    } catch {
      return {};
    }
  }

  setEnvironmentName(envId: string, name: string): void {
    const trimmedName = name.trim();
    const names = this.readEnvironmentNames();
    if (!trimmedName) {
      delete names[envId];
    } else {
      names[envId] = trimmedName;
    }
    if (!existsSync(this.userDataPath)) {
      mkdirSync(this.userDataPath, { recursive: true });
    }
    writeFileSync(this.envNamesFilePath, JSON.stringify(names, null, 2), 'utf-8');
  }

  deleteEnvironment(envId: string): void {
    if (envId === 'default') {
      throw new Error('Default environment cannot be deleted');
    }
    const filePath = this.resolveStateFilePath(envId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    const externalPath = this.fromEnvironmentRefToPath(envId);
    if (externalPath) {
      this.removeRecentEnvironmentPath(externalPath);
    }
    const names = this.readEnvironmentNames();
    if (envId in names) {
      delete names[envId];
      if (!existsSync(this.userDataPath)) {
        mkdirSync(this.userDataPath, { recursive: true });
      }
      writeFileSync(this.envNamesFilePath, JSON.stringify(names, null, 2), 'utf-8');
    }
  }

  listEnvironments(): EnvironmentSummary[] {
    const names = this.readEnvironmentNames();
    const internal: EnvironmentSummary[] = this.listSetIds().map((setId) => {
      const fallbackName = this.defaultEnvironmentName(setId, 'internal');
      return {
        id: setId,
        name: names[setId] ?? fallbackName,
        source: 'internal' as const,
      };
    });

    const recentFiles: EnvironmentSummary[] = this.listRecentEnvironmentPaths()
      .filter((envPath) => existsSync(envPath))
      .map((envPath) => {
        const id = this.toEnvironmentRefFromPath(envPath);
        const fallbackName = this.defaultEnvironmentName(id, 'file', envPath);
        return {
          id,
          name: names[id] ?? fallbackName,
          source: 'file' as const,
          path: envPath,
        };
      });

    return [...internal, ...recentFiles];
  }

  listSetIds(): string[] {
    try {
      const files = readdirSync(this.userDataPath);
      const ids = files
        .map((name) => {
          const m = name.match(/^workspaces-state-(.+)\.json$/);
          return m?.[1] ?? null;
        })
        .filter((v): v is string => !!v);
      if (!ids.includes('default')) ids.unshift('default');
      return Array.from(new Set(ids)).sort();
    } catch {
      return ['default'];
    }
  }

  // --- Recently-closed workspaces (per environment) ---
  // Closing a workspace deletes it from active state; we snapshot it here so it
  // can be reopened from the "+ workspace → Open Recent" menu. Keyed per set/env
  // and kept in userData regardless of env type (internal id or file: ref).
  private getRecentWorkspacesFilePath(setId: string): string {
    const safe = (setId || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '-') || 'default';
    return path.join(this.userDataPath, `${RECENT_WS_FILE_PREFIX}-${safe}.json`);
  }

  listRecentWorkspaces(setId = 'default'): Workspace[] {
    try {
      const filePath = this.getRecentWorkspacesFilePath(setId);
      if (!existsSync(filePath)) return [];
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (w): w is Workspace => isObject(w) && typeof w.id === 'string' && typeof w.name === 'string',
      );
    } catch {
      return [];
    }
  }

  addRecentWorkspace(workspace: Workspace, setId = 'default'): void {
    if (!isObject(workspace) || typeof workspace.id !== 'string') return;
    const prev = this.listRecentWorkspaces(setId).filter((w) => w.id !== workspace.id);
    const next = [workspace, ...prev].slice(0, MAX_RECENT_WORKSPACES);
    if (!existsSync(this.userDataPath)) {
      mkdirSync(this.userDataPath, { recursive: true });
    }
    writeFileSync(this.getRecentWorkspacesFilePath(setId), JSON.stringify(next, null, 2), 'utf-8');
  }

  // --- Per-workspace folder settings (.splitgrid/workspace.json) ---

  private workspaceFolderFilePath(workingDirectory: string): string {
    return path.join(path.resolve(workingDirectory), WORKSPACE_FOLDER_DIR, WORKSPACE_FOLDER_FILE);
  }

  // Mirror one workspace's settings into its own folder. Best-effort: if the
  // folder is gone (deleted / unmounted drive) we skip silently rather than
  // failing the whole save — the userData copy was already written.
  private writeWorkspaceFolderFile(workspace: Workspace): void {
    const dir = workspace.workingDirectory?.trim();
    if (!dir) return;
    try {
      const root = path.resolve(dir);
      if (!existsSync(root)) return;
      const folderDir = path.join(root, WORKSPACE_FOLDER_DIR);
      if (!existsSync(folderDir)) {
        mkdirSync(folderDir, { recursive: true });
      }
      // Keep these settings local by default — never let them be committed by
      // accident. Written once; a user who wants to share the layout can remove it.
      const gitignorePath = path.join(folderDir, '.gitignore');
      if (!existsSync(gitignorePath)) {
        writeFileSync(gitignorePath, '*\n', 'utf-8');
      }
      const payload: PersistedWorkspaceFolderV1 = {
        version: STATE_VERSION,
        savedAt: Date.now(),
        workspace,
      };
      writeFileSync(this.workspaceFolderFilePath(root), JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to write workspace folder settings:', error);
    }
  }

  private readWorkspaceFolderFile(workingDirectory: string): Workspace | null {
    try {
      const filePath = this.workspaceFolderFilePath(workingDirectory);
      if (!existsSync(filePath)) return null;
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
      if (!isObject(parsed) || !isObject(parsed.workspace)) return null;
      const ws = parsed.workspace;
      if (typeof ws.id !== 'string' || typeof ws.name !== 'string') return null;
      return ws as unknown as Workspace;
    } catch (error) {
      console.error('Failed to read workspace folder settings:', error);
      return null;
    }
  }

  // The folder copy is authoritative for a workspace's *content* (layout,
  // containers, notes, todos, …), but identity and the folder binding stay tied
  // to this environment's entry so activeWorkspaceId and cross-references keep
  // resolving — e.g. when the folder was first written on another machine.
  private applyWorkspaceFolderOverrides(workspaces: Workspace[]): Workspace[] {
    return workspaces.map((ws) => {
      const dir = typeof ws?.workingDirectory === 'string' ? ws.workingDirectory.trim() : '';
      if (!dir) return ws;
      const folderWs = this.readWorkspaceFolderFile(dir);
      if (!folderWs) return ws;
      return { ...folderWs, id: ws.id, workingDirectory: ws.workingDirectory };
    });
  }

  load(setId = 'default'): WorkspaceState | null {
    const filePath = this.resolveStateFilePath(setId);
    try {
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed)) return null;
      const activeWorkspaceId = typeof parsed.activeWorkspaceId === 'string' ? parsed.activeWorkspaceId : null;

      // The V1 envelope also carries `workspaces` as a top-level array, so this
      // branch handles both the enveloped and the older flat format. Restore the
      // environment-scoped fields (todos / command favorites / recent commands)
      // alongside the workspaces — these live on the state root, not inside each
      // workspace, so they must be read back explicitly or they reset on launch.
      if (Array.isArray(parsed.workspaces)) {
        return {
          activeWorkspaceId,
          workspaces: this.applyWorkspaceFolderOverrides(parsed.workspaces as Workspace[]),
          envTodos: Array.isArray(parsed.envTodos) ? (parsed.envTodos as WorkspaceState['envTodos']) : undefined,
          envCommandFavorites: Array.isArray(parsed.envCommandFavorites) ? (parsed.envCommandFavorites as WorkspaceState['envCommandFavorites']) : undefined,
          recentCommands: Array.isArray(parsed.recentCommands) ? (parsed.recentCommands as WorkspaceState['recentCommands']) : undefined,
        };
      }

      return null;
    } catch (error) {
      console.error('Failed to load workspace state:', error);
      return null;
    }
  }

  save(state: WorkspaceState, setId = 'default'): void {
    const filePath = this.resolveStateFilePath(setId);
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const payload: PersistedWorkspaceStateV1 = {
      version: STATE_VERSION,
      savedAt: Date.now(),
      activeWorkspaceId: state.activeWorkspaceId,
      workspaces: state.workspaces,
      // Environment-scoped state lives on the root, not inside any workspace —
      // persist it explicitly or it's silently dropped (env todos reset on launch).
      envTodos: state.envTodos,
      envCommandFavorites: state.envCommandFavorites,
      recentCommands: state.recentCommands,
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');

    // Mirror each folder-bound workspace into its own `.splitgrid/workspace.json`
    // so its settings travel with the folder. The userData copy above stays the
    // canonical environment record; the folder copy wins on load when present.
    for (const ws of state.workspaces) {
      this.writeWorkspaceFolderFile(ws);
    }
  }
}
