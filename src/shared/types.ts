// --- SSH Connection ---

export interface SSHConnectionConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'privateKey';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  // Optional dedicated sudo password (falls back to `password` when empty).
  sudoPassword?: string;
  // Opt-in: offer to auto-fill the saved password at sudo/password prompts.
  offerSavedPassword?: boolean;
}

export interface SavedConnection {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'privateKey';
  privateKeyPath?: string;
  encryptedPassword?: string;
  encryptedPassphrase?: string;
  // Dedicated sudo password (encrypted; falls back to the login password).
  encryptedSudoPassword?: string;
  // Opt-in: offer to auto-fill the saved password at sudo/password prompts.
  offerSavedPassword?: boolean;
}

// --- SFTP file manager ---

// Identifies a single SFTP pane: which saved connection to use, which
// workspace it belongs to, and the container (pane) id used as the per-pane
// SFTP session cache key so each pane gets its own cached session.
export interface SftpTarget {
  connectionId: string;
  workspaceId: string;
  containerId: string;
}

export interface RemoteDirEntry {
  filename: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number;
  mode: number;
}

export interface RemoteFileContent {
  content: string;
  size: number;
  truncated: boolean;
  isBinary: boolean;
}

// Progress event for a file-manager transfer (sftp:fm-upload / sftp:fm-download).
// `current`/`total` count files, not bytes; `file` is the path being moved.
export interface SftpTransferProgress {
  transferId: string;
  direction: 'upload' | 'download';
  file: string;
  current: number;
  total: number;
}

// --- Terminal ---

export type TerminalType = 'ssh' | 'local';
export type TerminalRendererKind = 'xterm' | 'ghostty';

export interface TerminalSessionInfo {
  id: string;
  type: TerminalType;
  label: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  createdAt: number;
  host?: string;
  port?: number;
  username?: string;
  cwd?: string;
  shell?: string;
}

export interface LocalShellConfig {
  cwd?: string;
  shell?: string;
  label?: string;
}

export interface TerminalResourceInfo {
  id: string;
  type: TerminalType;
  label: string;
  status: TerminalSessionInfo['status'];
  host?: string;
  port?: number;
  username?: string;
  cwd?: string;
  shell?: string;
  pid?: number;
  processCount?: number;
  processCommand?: string;
  processCpuPercent?: number;
  processRssBytes?: number;
  /** TCP ports the session's process tree is currently LISTENing on. */
  listenPorts?: number[];
  /** Same ports, with the PID(s) holding each one (for "kill the process on
   * this port"). Host PIDs for native terminals; in-distro PIDs for WSL. */
  ports?: TerminalListenPort[];
  inputBytes: number;
  outputBytes: number;
  bufferSize: number;
  lastDataAt?: number;
}

export interface TerminalResourceSnapshot {
  collectedAt: number;
  processMetricsSupported: boolean;
  sessions: TerminalResourceInfo[];
}

/** A TCP port a terminal's process tree is LISTENing on, with the in-tree PID(s)
 * that hold it — enough to open `http://localhost:<port>` and to terminate the
 * holder. PIDs are host PIDs for native terminals, in-distro PIDs for WSL. */
export interface TerminalListenPort {
  port: number;
  pids: number[];
}

/** Result of a request to terminate a process holding a port. */
export interface KillProcessResult {
  ok: boolean;
  error?: string;
}

// Foreground process names we treat as "agents". Activity status
// (working/waiting/done) and completion notifications are an agent-only feature;
// every other command just shows its name. Single source of truth shared by the
// main-process metrics (deriveProcessLabel) and the renderer's view-state gating.
export const AGENT_COMMANDS: readonly string[] = ['claude', 'codex', 'cursor'];

// One process in a terminal's live process tree (the PTY root and everything it
// spawned — shells, the Claude agent, and whatever the agent runs).
export interface TerminalProcessInfo {
  pid: number;
  ppid: number;
  depth: number; // nesting level under the PTY root (root = 0)
  command: string; // full command line (ps `command=`)
  cpuPercent: number;
  rssBytes: number;
}

export interface TerminalRendererMetrics {
  sessionId: string;
  containerId: string;
  workspaceId: string;
  renderer: TerminalRendererKind;
  visible: boolean;
  renderWriteCalls: number;
  renderWriteChars: number;
  renderWriteMsTotal: number;
  fitCalls: number;
  fitMsTotal: number;
  refreshCalls: number;
  refreshMsTotal: number;
  updatedAt: number;
}

// --- SQL ---

export type SQLDialect = 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'mssql';

/** Static, per-dialect feature/behavior descriptor. Pure data — see shared/dialects.ts. */
export interface DialectCapabilities {
  dialect: SQLDialect;
  label: string;
  defaultPort: number | null; // null for file-based dialects (sqlite)
  supportsSchemas: boolean; // namespaced objects under a schema (pg/mssql)
  supportsMaterializedViews: boolean;
  supportsMultipleDatabases: boolean; // multiple DBs reachable on one connection
  identifierQuote: string; // opening quote char ("=pg, `=mysql, [=mssql)
  identifierQuoteClose: string; // closing quote char (usually same; ] for mssql)
  paramPlaceholder: 'numbered' | 'question' | 'named'; // $1 / ? / @p1
  supportsExplainAnalyze: boolean;
  requiresFilePath: boolean; // sqlite needs a file path instead of host/port
  supportsTransactions: boolean;
  supportsSequences: boolean;
  supportsProcedures: boolean;
  defaultSchema: string | null; // 'public' for pg, 'dbo' for mssql, null otherwise
}

export interface SQLConnectionConfig {
  dialect: SQLDialect;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  connectionName?: string;
  // File-based dialects (sqlite) use this instead of host/port/user. Falls back
  // to `database` when absent so existing config shapes still work.
  filePath?: string;
}

export interface SQLConnectionInfo {
  id: string;
  dialect: SQLDialect;
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: boolean;
  connectedAt: number;
  serverVersion?: string;
}

export interface SavedSQLConnection {
  id: string;
  label: string;
  dialect: SQLDialect;
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: boolean;
  // File-based dialects (sqlite) store the DB file path here. Optional/additive;
  // network dialects leave it undefined.
  filePath?: string;
}

export type SQLSchemaObjectKind =
  | 'table'
  | 'view'
  | 'materializedView'
  | 'foreignTable'
  | 'function'
  | 'procedure'
  | 'sequence'
  | 'type';

export interface SQLSchemaObject {
  name: string;
  rowEstimate?: number;
  totalBytes?: number;
}

export interface SQLSchemaCategory {
  id: string;
  label: string;
  kind: SQLSchemaObjectKind;
  objects: SQLSchemaObject[];
}

export interface SQLSchemaTree {
  schema: string;
  isDefault: boolean;
  categories: SQLSchemaCategory[];
}

export interface SQLDatabaseInfo {
  name: string;
  sizeBytes: number;
  description: string | null;
  isCurrent: boolean;
}

export interface SQLColumnInfo {
  schema: string;
  table: string;
  column: string;
  // Optional introspection fields (additive — for future editing/DDL).
  dataType?: string;
  isNullable?: boolean;
  isPrimaryKey?: boolean;
  isAutoIncrement?: boolean;
  defaultValue?: string | null;
  ordinal?: number;
}

export interface SQLQueryResult {
  command: string;
  rowCount: number;
  durationMs: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  // Optional, additive (multi-dialect / multi-statement support).
  fields?: Array<{ name: string; dataType?: string }>;
  affectedRows?: number;
  statementIndex?: number;
}

// --- SQL introspection / editing (additive; not yet wired up) ---

export interface SQLIndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  method?: string;
}

export interface SQLKeyInfo {
  name: string;
  type: 'primary' | 'foreign' | 'unique' | 'check';
  columns: string[];
  referencedTable?: string;
  referencedColumns?: string[];
}

export interface SQLTriggerInfo {
  name: string;
  timing?: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  event?: string;
  table?: string;
}

export interface SQLObjectDDL {
  schema: string;
  name: string;
  kind: SQLSchemaObjectKind;
  ddl: string;
}

export type SQLEditChange =
  | { kind: 'update'; schema: string; table: string; pk: Record<string, unknown>; column: string; value: unknown }
  | { kind: 'insert'; schema: string; table: string; values: Record<string, unknown> }
  | { kind: 'delete'; schema: string; table: string; pk: Record<string, unknown> };

export type SQLExportFormat = 'csv' | 'json' | 'sql' | 'xlsx';

export interface SQLExportOptions {
  format: SQLExportFormat;
  includeHeaders?: boolean;
  delimiter?: string;
  filePath: string;
  /** Text written for a NULL cell in CSV (default ''). */
  nullText?: string;
  /** Target table name for the `sql` format (and the quoting schema). */
  sqlTableName?: string;
  /** Dialect used for `sql` value/identifier quoting. Falls back to the live
   * connection's dialect when omitted. */
  dialect?: SQLDialect;
  /**
   * Export scope:
   *  - `current`: serialize the rows passed inline (the loaded grid page).
   *  - `full`: stream the WHOLE table from the DB (table tabs only), paginating
   *    past the 1000-row driver cap.
   */
  scope: 'current' | 'full';
  /** Inline rows for `current` scope (the renderer's in-memory result). */
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  /** Source table for `full` scope. */
  table?: { schema: string; name: string };
}

export interface SQLExportResult {
  ok: boolean;
  filePath: string;
  rowCount: number;
}

/** A single batched-import request. Rows are arrays aligned to `columns`. */
export interface SQLImportRequest {
  schema: string;
  table: string;
  columns: string[];
  rows: unknown[][];
  /** TRUNCATE the table before inserting (inside the same transaction). */
  truncate?: boolean;
  /** Rows per INSERT batch (driver executes each batch parameterized). */
  batchSize?: number;
}

export interface SQLImportResult {
  ok: boolean;
  imported: number;
}

export type SQLTabType = 'query' | 'table' | 'structure';

export interface SQLQueryTab {
  id: string;
  type: 'query';
  title: string;
  query: string;
  savedConnectionId?: string | null;
  database?: string | null;
  schema?: string | null;
  /** When true the editor is read-only (e.g. a DDL viewer tab). */
  readOnly?: boolean;
}

/** Read-only structure view for a single table/view (Columns/Indexes/Keys/Triggers). */
export interface SQLStructureTab {
  id: string;
  type: 'structure';
  title: string;
  schema: string;
  objectName: string;
  kind: SQLSchemaObjectKind;
  savedConnectionId?: string | null;
  database?: string | null;
}

export interface SQLTableTab {
  id: string;
  type: 'table';
  title: string;
  schema: string;
  objectName: string;
  savedConnectionId?: string | null;
  database?: string | null;
}

export type SQLTab = SQLQueryTab | SQLTableTab | SQLStructureTab;

/** @deprecated kept for hydration compat */
export interface SQLQueryTabState {
  id: string;
  title: string;
  query: string;
  type?: string;
}

export interface SQLHistoryEntry {
  id: string;
  query: string;
  executedAt: number;
  durationMs?: number;
  rowCount?: number;
  ok: boolean;
  error?: string;
}

/** A user-saved/named query. Persisted in SQLContainerState.favorites. */
export interface SQLFavoriteQuery {
  id: string;
  name: string;
  query: string;
  createdAt: number;
}

export interface SQLContainerState {
  connectionId: string | null;
  savedConnectionId: string | null;
  connectionName: string;
  host: string;
  port: number;
  user: string;
  database: string;
  schema?: string | null;
  ssl: boolean;
  tabs: SQLTab[];
  activeTabId: string | null;
  history: SQLHistoryEntry[];
  // Saved/starred queries (additive/optional — absent in older persisted state).
  favorites?: SQLFavoriteQuery[];
  // Layout sizes for the DataGrip-style workbench (additive/optional; default
  // when absent). treeWidth = left connection-tree panel width in px;
  // editorHeight = editor pane height in px when results are shown below.
  treeWidth?: number;
  editorHeight?: number;
}

// --- Layout containers ---

export type ContainerContentType = 'empty' | 'terminal' | 'ide' | 'browser' | 'sql' | 'sftp' | 'ssh-connect';

export interface IDETabState {
  filePath: string;
  isPreview: boolean;
}

export interface IDEExplorerState {
  expandedItems: string[];
  selectedItems: string[];
  focusedItem: string | null;
}

export interface IDEContainerState {
  tabs: IDETabState[];
  activeTabId: string | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  editorFontSize: number;
  explorer: IDEExplorerState;
}

export interface ContainerContent {
  type: ContainerContentType;
  terminalId?: string;
  terminalType?: TerminalType;
  connectionId?: string;
  label?: string;
  /** User-set custom name; overrides the auto-derived label/process in the UI. */
  customName?: string;
  /** When true, this terminal's output is streamed to the web relay. Off by
   * default; toggled per-terminal from the pane header. Persisted with the
   * workspace so the choice survives restarts. */
  streamToWeb?: boolean;
  cwd?: string;
  shell?: string;
  terminalOutput?: string;
  connectionError?: string;
  // IDE
  rootPath?: string;
  ideState?: IDEContainerState;
  // Browser
  browserUrl?: string;
  browserPartition?: string;
  // Agent that opened this browser pane (its $SPLITGRID_TERMINAL). Lets two agents
  // in one workspace each control their own browser without collision — the
  // agent owns the pane it opened. Undefined = user-opened / unowned.
  browserOwnerTerminal?: string;
  // SQL
  sqlState?: SQLContainerState;
  // SFTP
  sftpConnectionId?: string;   // chosen saved connection
  sftpRemotePath?: string;     // last remote dir (persisted)
  sftpLocalPath?: string;      // last local dir (persisted)
}

export interface Container {
  id: string;
  content: ContainerContent;
}

// --- Tiling layout tree ---

export type SplitDirection = 'horizontal' | 'vertical';

export interface SplitNode {
  type: 'split';
  direction: SplitDirection;
  ratio: number; // 0-1, first child takes this fraction
  first: LayoutNode;
  second: LayoutNode;
}

export interface LeafNode {
  type: 'leaf';
  containerId: string;
}

export type LayoutNode = SplitNode | LeafNode;

// --- Workspace ---

export interface Workspace {
  id: string;
  name: string;
  workingDirectory: string | null;
  sync?: WorkspaceSyncConfig;
  layoutTree: LayoutNode | null;
  containers: Container[];
  containerZooms: Record<string, number>;
  focusedContainerId: string | null;
  /**
   * When true, the workspace is "frozen": its local terminal process trees are
   * suspended (SIGSTOP) to stop consuming CPU. Persisted across restarts; the
   * active workspace is never frozen. Unfrozen manually from the context menu.
   */
  frozen?: boolean;
  /**
   * Per-workspace "Done" notification overrides. Unset fields inherit the global
   * app defaults (AppSettings). `notifySoundId === 'none'` means silent;
   * `notifyVolume`/`notifySoundId` left undefined means "inherit default".
   */
  notifySoundId?: string | null;
  notifyVolume?: number | null;
  notifyMuted?: boolean;
  /** Free-form scratch notes for this workspace (plain text). Edited from the
   * sidebar notes popover; persisted with the workspace state. */
  notes?: string;
  /** Lightweight per-workspace todo list (next steps while an agent works).
   * Edited from the sidebar todo popover; persisted with the workspace state. */
  todos?: WorkspaceTodo[];
  /** Favorite terminal commands scoped to this workspace. Re-run from the
   * sidebar Commands popover; persisted with the workspace state. */
  commandFavorites?: SavedCommand[];
  /** Saved-connection ids opened in THIS workspace, most-recent-first. Drives the
   * "Recently used" section of the SSH connect dialog. Persisted with the
   * workspace; pruned to a small cap and to still-existing connections at render. */
  recentConnectionIds?: string[];
  createdAt: number;
  updatedAt: number;
}

/** Lifecycle state of a single todo. `in_progress` highlights the task an agent
 * is actively working on, sitting between an untouched `todo` and a `done` item. */
export type WorkspaceTodoStatus = 'todo' | 'in_progress' | 'done';

/** A single item in a workspace's todo list. */
export interface WorkspaceTodo {
  id: string;
  text: string;
  status: WorkspaceTodoStatus;
  /** @deprecated Legacy completion flag for items persisted before `status`
   * existed; migrated to `status` on first read/edit. */
  done?: boolean;
  createdAt: number;
}

/** A reusable terminal command saved as a favorite. Bound either to a single
 * workspace (Workspace.commandFavorites) or the whole environment / workspace
 * set (WorkspaceState.envCommandFavorites). Re-run from the sidebar's Commands
 * popover into the focused terminal. */
export interface SavedCommand {
  id: string;
  command: string;
  /** Optional friendly label shown instead of the raw command. */
  label?: string;
  createdAt: number;
  lastUsedAt?: number;
  useCount?: number;
}

/** One entry in the rolling "recently run" command feed (environment-scoped).
 * Deduplicated by command text; most-recent first, capped in useWorkspace. */
export interface RecentCommand {
  command: string;
  lastUsedAt: number;
  count: number;
}

/** A reusable prompt saved at the environment level (WorkspaceState.envPrompts).
 * Unlike a SavedCommand its body is free-form, multi-line text (e.g. an agent
 * instruction); pasted — or pasted + Enter — into the focused terminal from the
 * sidebar's Prompts popover, where it can also be edited and deleted. */
export interface SavedPrompt {
  id: string;
  /** Optional friendly title shown instead of the body preview. */
  title?: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
}

/** "Fast chat" backend config — an OpenAI-compatible chat-completions endpoint.
 * Works with OpenAI, OpenRouter, Groq, local Ollama (`/v1`), LM Studio, etc.:
 * the user supplies the base URL, key, model and sampling temperature. Stored
 * app-wide in app-settings.json. The API key lives in the main process; the
 * renderer only triggers requests and never sends the key on the wire. */
export type FastChatReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface FastChatSettings {
  /** Base URL up to (but not including) `/chat/completions`, e.g.
   * `https://api.openai.com/v1` or `http://localhost:11434/v1`. */
  baseUrl: string;
  apiKey: string;
  /** The default (pre-selected) model. Should be one of `models` when that list
   * is non-empty; kept as a first-class field for backward compatibility. */
  model: string;
  /** Models the user can pick from in the chat's model selector. When empty or
   * undefined, the chat falls back to just `[model]`. `model` is the default. */
  models?: string[];
  /** Sampling temperature, 0–2. */
  temperature: number;
  /** Optional system prompt prepended to every conversation. */
  systemPrompt?: string;
  /** Reasoning effort for reasoning-capable models (OpenAI o-series / gpt-5,
   * compatible endpoints). Undefined → omit the parameter (for non-reasoning
   * models that would reject it). */
  reasoningEffort?: FastChatReasoningEffort;
}

/** A keyboard chord for toggling the Fast chat palette. Modifiers are stored as
 * the user pressed them on their machine (⌘ on macOS, Ctrl elsewhere); `key` is
 * the lowercased non-modifier key (`input.key`), e.g. `'k'`, `'p'`, `' '`,
 * `'arrowup'`. Matched verbatim against Electron's before-input-event input. */
export interface QuickChatHotkey {
  key: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** Global notification defaults, stored app-wide (app-settings.json). */
export interface AppSettings {
  defaultSoundId: string;
  defaultVolume: number;
  muteAll: boolean;
  // Absolute path of the shell to spawn for new local terminals on Windows
  // (one of ShellOption.path from listShells). Empty/undefined → OS default (cmd).
  windowsDefaultShell?: string;
  // "Fast chat" quick-question palette backend (OpenAI-compatible). Undefined
  // until the user configures it in Settings → Fast chat.
  fastChat?: FastChatSettings;
  // Custom hotkey for the Fast chat palette. Undefined → platform default
  // (⌘K on macOS, Ctrl+K elsewhere).
  quickChatHotkey?: QuickChatHotkey;
  // Custom hotkey for toggling a container's focus mode. Undefined → platform
  // default (⌘⇧F on macOS, Ctrl+Shift+F elsewhere).
  focusModeHotkey?: QuickChatHotkey;
  // How many recent Fast chat conversations to keep. Undefined → default (20);
  // 0 disables history entirely.
  quickChatHistoryLimit?: number;
  // Seconds the palette keeps a closed chat resumable on reopen (the visibility
  // grace window). Undefined → default (300); 0 discards immediately on close.
  quickChatResumeGraceSec?: number;
  // Rendering engine for terminals: 'xterm' (xterm.js) or 'ghostty' (Ghostty
  // WASM, GPU-accelerated). Undefined → default ('xterm'). Applies to all
  // terminals; changing it reloads open ones.
  terminalRenderer?: TerminalRendererKind;
  // Master opt-in for every GLOBAL change splitgrid makes on behalf of agents:
  // lifecycle hooks in ~/.claude & ~/.codex, the splitgrid-browser skill in
  // ~/.claude/skills, the same artifacts inside WSL distros, and the SPLITGRID_*
  // env injected into local terminals. Undefined/false → splitgrid touches nothing
  // on launch; the user must opt in here. Toggling it installs/uninstalls.
  agentIntegrations?: boolean;
  // Sub-opt-in (only meaningful while agentIntegrations is on): lets an agent
  // inspect and drive the OTHER terminals in its workspace — installs the
  // splitgrid-terminal skill and injects the SPLITGRID_TERMINAL_* env. Writing into a
  // sibling shell runs arbitrary commands, so it's gated separately from browser
  // control. Undefined/false → no terminal skill, no terminal env.
  agentTerminalControl?: boolean;
  // Sub-opt-in (only meaningful while agentIntegrations is on): lets an agent run
  // queries, inspect schema and export results against the SQL component —
  // injects the SPLITGRID_SQL_* env. Read-only by default. Undefined/false → no
  // SQL env.
  agentSqlControl?: boolean;
  // Sub-sub-opt-in (only meaningful while agentSqlControl is on): also allow
  // write/DDL (data modification, schema changes). Exposes SPLITGRID_SQL_WRITE=1
  // as a capability hint. Undefined/false → read-only.
  agentSqlWrite?: boolean;
  // Makes the mouse wheel scroll tmux/screen by enabling mouse mode in the local
  // ~/.tmux.conf and ~/.screenrc (a SplitGrid-managed block). Trade-off: text
  // selection then goes through the multiplexer (hold Shift for native select).
  // Only edits config on this machine — remote tmux over SSH is unaffected.
  // Undefined/false → SplitGrid leaves those files alone.
  terminalMouseScroll?: boolean;
}

/** One message in a Fast chat conversation. */
export interface FastChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** A saved Fast chat conversation (history entry). Persisted in
 * quick-chat-history.json, newest first, capped at AppSettings.quickChatHistoryLimit. */
export interface FastChatConversation {
  id: string;
  /** Derived from the first user message (truncated). */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: FastChatMessage[];
}

// A selectable terminal shell discovered on the machine (Windows: cmd,
// PowerShell, Git Bash, …). `path` is what gets spawned; args are derived in main.
export interface ShellOption {
  id: string;
  label: string;
  path: string;
}

export interface WorkspaceSyncConfig {
  enabled: boolean;
  useGitIgnore: boolean;
  targets: WorkspaceSyncTarget[];
  fileStates?: Record<string, WorkspaceSyncFileState>;
  logs?: WorkspaceSyncLogEntry[];
}

export interface WorkspaceSyncTarget {
  id: string;
  name: string;
  enabled: boolean;
  connectionId: string | null;
  remotePath: string;
  lastSyncAt?: number;
  lastSyncStatus?: 'success' | 'error';
  lastSyncError?: string;
}

export interface WorkspaceSyncFileState {
  status: 'synced' | 'error' | 'skipped';
  updatedAt: number;
}

export interface WorkspaceSyncLogEntry {
  id: string;
  at: number;
  action: 'save' | 'create-file' | 'create-directory' | 'rename' | 'delete' | 'sync-now';
  filePath: string;
  targetId?: string;
  ok: boolean;
  message: string;
}

export interface WorkspaceState {
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
  /** Todo list scoped to the whole environment (workspace set), separate from
   * each workspace's own todos. Edited from the sidebar's bottom bar. */
  envTodos?: WorkspaceTodo[];
  /** Favorite terminal commands scoped to the whole environment (workspace
   * set), separate from each workspace's own favorites. */
  envCommandFavorites?: SavedCommand[];
  /** Rolling feed of recently-run terminal commands (environment-scoped),
   * captured heuristically from terminal input. Most-recent first. */
  recentCommands?: RecentCommand[];
  /** Reusable prompts scoped to the whole environment (workspace set). Edited
   * from the sidebar's Prompts popover and pasted into the focused terminal. */
  envPrompts?: SavedPrompt[];
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  source: 'internal' | 'file';
  path?: string;
  isOpen?: boolean;
}

export type ClaudeActivityState = 'working' | 'idle' | 'waiting';

// --- Web streaming auth (WorkOS) ---

// The signed-in user as resolved from WorkOS. Mirrors the relevant WorkOS user
// fields; the access/refresh tokens never cross to the renderer.
export interface AuthUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
}

export interface AuthSession {
  user: AuthUser;
}

// Routing + display metadata sent with a shared terminal so the web viewer can
// group sessions by environment → workspace → terminal.
export interface RelayShareMeta {
  title: string;
  envId: string;
  envName: string;
  workspaceId: string;
  workspaceName: string;
  cols: number;
  rows: number;
}

// Producer connection status surfaced to the renderer (header indicator).
export interface RelayStatus {
  connected: boolean;
  sharedCount: number;
}

// --- Electron API ---

export interface ElectronAPI {
  createSession(config: Omit<SSHConnectionConfig, 'id'>): Promise<TerminalSessionInfo>;
  createLocalTerminal(config?: LocalShellConfig): Promise<TerminalSessionInfo>;
  closeSession(sessionId: string): Promise<void>;
  sendData(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;

  onData(callback: (sessionId: string, data: string) => void): () => void;
  onSessionReady(callback: (sessionId: string) => void): () => void;
  onSessionClosed(callback: (sessionId: string, exitedCleanly: boolean) => void): () => void;
  onError(callback: (sessionId: string, message: string) => void): () => void;
  onClaudeResponse(callback: (sessionId: string) => void): () => void;

  getSavedConnections(): Promise<SavedConnection[]>;
  saveConnection(config: Omit<SSHConnectionConfig, 'id'>): Promise<SavedConnection>;
  updateConnection(id: string, config: Omit<SSHConnectionConfig, 'id'>): Promise<SavedConnection>;
  deleteSavedConnection(id: string): Promise<void>;
  connectSaved(id: string): Promise<TerminalSessionInfo>;

  getActiveSessions(): Promise<TerminalSessionInfo[]>;
  getSessionBuffer(sessionId: string): Promise<string>;
  getResourceSnapshot(): Promise<TerminalResourceSnapshot>;
  getTerminalProcessTree(sessionId: string): Promise<TerminalProcessInfo[]>;
  /** Terminate a process (by PID) holding a port in the given session's tree.
   * Routes to the host OS, `taskkill` on Windows, or `wsl … kill` for WSL. */
  killProcess(sessionId: string, pid: number, signal?: 'TERM' | 'KILL'): Promise<KillProcessResult>;
  openExternal(url: string): Promise<void>;
  freezeWorkspace(sessionIds: string[]): Promise<Array<{ id: string; supported: boolean; frozen: boolean }>>;
  unfreezeWorkspace(sessionIds: string[]): Promise<Array<{ id: string; supported: boolean; frozen: boolean }>>;

  // File system
  readDirectory(dirPath: string): Promise<{ name: string; isDirectory: boolean }[]>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  writeFileWithSync(
    filePath: string,
    content: string,
    options: {
      workspaceId: string;
      localRootPath: string;
      sync: WorkspaceSyncConfig | null;
    }
  ): Promise<{
    synced: boolean;
    skippedByGitIgnore?: boolean;
    targetResults: Array<{
      targetId: string;
      ok: boolean;
      error?: string;
    }>;
  }>;
  moveFileWithSync(
    srcPath: string,
    destPath: string,
    options: {
      workspaceId: string;
      localRootPath: string;
      sync: WorkspaceSyncConfig | null;
    }
  ): Promise<{ targetResults: Array<{ targetId: string; ok: boolean; error?: string }> }>;
  trashItemWithSync(
    filePath: string,
    options: {
      workspaceId: string;
      localRootPath: string;
      sync: WorkspaceSyncConfig | null;
    }
  ): Promise<{ targetResults: Array<{ targetId: string; ok: boolean; error?: string }> }>;
  runWorkspaceSyncNow(options: {
    workspaceId: string;
    localRootPath: string;
    sync: WorkspaceSyncConfig | null;
    syncId?: string;
  }): Promise<{
    scanned: number;
    uploaded: number;
    skippedByGitIgnore: number;
    cancelled?: boolean;
    targetResults: Array<{ targetId: string; ok: boolean; uploaded: number; error?: string }>;
  }>;
  sftpPushPaths(
    filePaths: string[],
    options: { workspaceId: string; localRootPath: string; sync: WorkspaceSyncConfig | null; syncId?: string },
  ): Promise<{
    pushed: number;
    total?: number;
    cancelled?: boolean;
    skippedByGitIgnore?: number;
    targetResults: Array<{ targetId: string; ok: boolean; pushed: number; error?: string }>;
  }>;
  sftpPullPaths(
    localPaths: string[],
    options: { workspaceId: string; localRootPath: string; sync: WorkspaceSyncConfig | null; syncId?: string },
  ): Promise<{
    pulled: number;
    cancelled?: boolean;
    skippedByGitIgnore?: number;
    targetResults: Array<{ targetId: string; ok: boolean; pulled: number; error?: string }>;
  }>;
  onSftpProgress(callback: (info: { direction: 'push' | 'pull'; file: string; current: number; total: number }) => void): () => void;
  // Cancel an in-flight bulk sync (push/pull/run-now) by the syncId passed in its options.
  cancelSftpSync(syncId: string): Promise<{ ok: boolean }>;
  // --- SFTP file manager (per-pane remote browsing) ---
  sftpStatDir(target: SftpTarget, path: string): Promise<RemoteDirEntry[]>;
  sftpMkdir(target: SftpTarget, path: string): Promise<void>;
  sftpRename(target: SftpTarget, oldPath: string, newPath: string): Promise<void>;
  sftpDeletePath(target: SftpTarget, path: string): Promise<void>;
  sftpReadFile(target: SftpTarget, path: string): Promise<RemoteFileContent>;
  sftpWriteFile(target: SftpTarget, path: string, content: string): Promise<void>;
  sftpRealpath(target: SftpTarget, path: string): Promise<string>;
  // --- SFTP file manager: local listing + cross-pane transfers ---
  // Rich local directory listing (lstat per entry); reuses the RemoteDirEntry
  // shape so both panes share the same formatters. mtime is in SECONDS.
  statDirectory(dirPath: string): Promise<RemoteDirEntry[]>;
  homeDir(): Promise<string>;
  sftpUpload(
    target: SftpTarget,
    localPaths: string[],
    remoteDir: string,
    transferId: string,
  ): Promise<{ ok: boolean; transferred: number; total: number; errors: string[] }>;
  sftpDownload(
    target: SftpTarget,
    items: { path: string; isDirectory: boolean }[],
    localDir: string,
    transferId: string,
  ): Promise<{ ok: boolean; transferred: number; total: number; errors: string[] }>;
  cancelSftpTransfer(transferId: string): Promise<{ ok: boolean }>;
  onSftpFmProgress(cb: (info: SftpTransferProgress) => void): () => void;
  moveFile(srcPath: string, destPath: string): Promise<void>;
  createFile(filePath: string): Promise<void>;
  createDirectory(dirPath: string): Promise<void>;
  createFileWithSync(
    filePath: string,
    options: {
      workspaceId: string;
      localRootPath: string;
      sync: WorkspaceSyncConfig | null;
    }
  ): Promise<{ targetResults: Array<{ targetId: string; ok: boolean; error?: string }> }>;
  createDirectoryWithSync(
    dirPath: string,
    options: {
      workspaceId: string;
      localRootPath: string;
      sync: WorkspaceSyncConfig | null;
    }
  ): Promise<{ targetResults: Array<{ targetId: string; ok: boolean; error?: string }> }>;
  copyFile(srcPath: string, destPath: string): Promise<void>;
  statFile(filePath: string): Promise<{ isDirectory: boolean; size: number }>;
  trashItem(filePath: string): Promise<void>;
  watchFile(filePath: string): Promise<void>;
  unwatchFile(filePath: string): Promise<void>;
  onFileChanged(callback: (filePath: string) => void): () => void;

  // Recursive directory watching
  watchDirectory(watchId: string, dirPath: string): Promise<void>;
  unwatchDirectory(watchId: string): Promise<void>;
  onDirectoriesChanged(callback: (dirs: string[]) => void): () => void;
  onFilesChanged(callback: (files: string[]) => void): () => void;

  // Workspace auto-sync watcher
  syncWatchWorkspace(options: {
    workspaceId: string;
    localRootPath: string;
    sync: WorkspaceSyncConfig | null;
  }): Promise<void>;
  syncUnwatchWorkspace(workspaceId: string): Promise<void>;
  syncUpdateWatchOptions(options: {
    workspaceId: string;
    localRootPath: string;
    sync: WorkspaceSyncConfig | null;
  }): Promise<void>;
  onAutoSynced(callback: (info: {
    workspaceId: string;
    synced: number;
    removed: number;
    errors: number;
    total: number;
  }) => void): () => void;

  selectPrivateKeyFile(): Promise<string | null>;
  selectDirectory(): Promise<string | null>;
  clipboardHasImage(): Promise<boolean>;
  clipboardSaveImageTemp(target?: 'wsl' | null): Promise<string | null>;
  clipboardWriteText(text: string): Promise<void>;
  clipboardReadText(): Promise<string>;
  /** Absolute path of a dropped/selected OS File (replaces removed File.path). */
  getPathForFile(file: File): string;
  /** Terminal shells available on this machine (for the Settings picker). */
  listShells(): Promise<ShellOption[]>;
  testSavedConnection(id: string): Promise<{ ok: boolean; error?: string }>;
  // Write SplitGrid's managed mouse-scroll block into the remote host's
  // ~/.tmux.conf & ~/.screenrc so the wheel scrolls tmux/screen running there.
  applyMouseScrollToHost(id: string): Promise<{ ok: boolean; error?: string }>;
  // Drop the pinned host key for host:port so the next connect re-pins the
  // server's current key (used by the "host key changed — accept?" recovery).
  forgetHostKey(host: string, port: number): Promise<void>;

  getWindowZoom(): number;
  setWindowZoom(level: number): void;
  onContainerZoom(callback: (direction: 'in' | 'out' | 'reset') => void): () => void;
  /** Focus-mode toggle forwarded from a browser pane's before-input-event (its
   * keys never reach the renderer window). */
  onFocusModeToggle(callback: () => void): () => void;
  onFullScreenChange(callback: (isFullScreen: boolean) => void): () => void;
  onEnvironmentStateChange(callback: () => void): () => void;
  onOpenEnvironmentPicker(callback: () => void): () => void;

  getWorkspaceSetContext(): Promise<{ currentSetId: string; setIds: string[] }>;
  openWorkspaceSetWindow(setId?: string): Promise<{ setId: string }>;
  listEnvironments(): Promise<EnvironmentSummary[]>;
  pickEnvironmentFile(): Promise<string | null>;
  setEnvironmentName(environmentId: string, name: string): Promise<void>;
  deleteEnvironment(environmentId: string): Promise<void>;

  // SQL
  sqlConnect(config: SQLConnectionConfig): Promise<SQLConnectionInfo>;
  /** Validate a connection config by connecting then immediately disconnecting. */
  sqlTestConnection(config: SQLConnectionConfig): Promise<{ ok: boolean; serverVersion?: string }>;
  sqlConnectSaved(savedId: string): Promise<SQLConnectionInfo>;
  sqlConnectSavedToDatabase(savedId: string, database: string): Promise<SQLConnectionInfo>;
  sqlDisconnect(connectionId: string): Promise<void>;
  sqlExecute(connectionId: string, sql: string): Promise<SQLQueryResult>;
  sqlListSchemas(connectionId: string): Promise<SQLSchemaTree[]>;
  sqlListDatabases(connectionId: string): Promise<SQLDatabaseInfo[]>;
  sqlListColumns(connectionId: string): Promise<SQLColumnInfo[]>;
  sqlGetDdl(
    connectionId: string,
    schema: string,
    name: string,
    kind: SQLSchemaObjectKind
  ): Promise<SQLObjectDDL>;
  sqlGetPrimaryKey(connectionId: string, schema: string, table: string): Promise<string[]>;
  sqlListIndexes(connectionId: string, schema: string, table: string): Promise<SQLIndexInfo[]>;
  sqlListKeys(connectionId: string, schema: string, table: string): Promise<SQLKeyInfo[]>;
  sqlListTriggers(connectionId: string, schema: string, table?: string): Promise<SQLTriggerInfo[]>;
  /** Rename a schema object (DDL mutation). Errors propagate to the caller. */
  sqlRenameObject(
    connectionId: string,
    kind: SQLSchemaObjectKind,
    schema: string,
    name: string,
    newName: string
  ): Promise<void>;
  /** Drop a schema object (destructive DDL mutation). Errors propagate. */
  sqlDropObject(
    connectionId: string,
    kind: SQLSchemaObjectKind,
    schema: string,
    name: string,
    opts?: { cascade?: boolean }
  ): Promise<void>;
  /** Apply a batch of editable-grid changes in one transaction (main builds the
   * parameterized UPDATE/INSERT/DELETE per dialect, runs begin→…→commit, and
   * rolls back + throws on any error). Resolves with the count applied. */
  sqlApplyEdits(connectionId: string, changes: SQLEditChange[]): Promise<{ applied: number }>;
  sqlBeginTx(connectionId: string): Promise<void>;
  sqlCommitTx(connectionId: string): Promise<void>;
  sqlRollbackTx(connectionId: string): Promise<void>;
  /** Export a result set / full table to a file. Shows a Save dialog in main when
   * `options.filePath` is empty; returns { ok, filePath, rowCount } or throws. */
  sqlExport(connectionId: string | null, options: SQLExportOptions): Promise<SQLExportResult>;
  /** Batched, transactional CSV → table import. Inserts in batches inside one tx;
   * rolls back and throws on error. Returns the number of rows imported. */
  sqlImportRows(connectionId: string, request: SQLImportRequest): Promise<SQLImportResult>;
  /** Open-file dialog for picking a CSV to import. Returns the path or null. */
  sqlPickImportFile(): Promise<string | null>;
  sqlGetSavedConnections(): Promise<SavedSQLConnection[]>;
  sqlSaveConnection(
    connection: Omit<SavedSQLConnection, 'id'> & { password: string }
  ): Promise<SavedSQLConnection>;
  sqlUpdateConnection(
    savedId: string,
    patch: Partial<Pick<SavedSQLConnection, 'label' | 'host' | 'port' | 'user' | 'database' | 'ssl' | 'filePath'>>
  ): Promise<SavedSQLConnection>;
  sqlDeleteConnection(savedId: string): Promise<void>;

  loadWorkspaceState(): Promise<WorkspaceState | null>;
  saveWorkspaceState(state: WorkspaceState): Promise<void>;
  listRecentWorkspaces(): Promise<Workspace[]>;
  addRecentWorkspace(workspace: Workspace): Promise<void>;

  // Global app settings (notification defaults)
  getAppSettings(): Promise<AppSettings>;
  saveAppSettings(settings: AppSettings): Promise<void>;

  // Fast chat: stream a chat completion from the configured OpenAI-compatible
  // endpoint. The renderer supplies the requestId (so it can subscribe before any
  // token arrives); tokens then flow via onFastChatChunk and the stream ends with
  // onFastChatDone or onFastChatError (same id). `cancel` aborts an in-flight
  // request. Returns { ok:false } with an error string when not configured.
  // `model` optionally overrides the configured default model for this request
  // (the user's per-chat selection); ignored when empty or not in the allowed list.
  fastChatAsk(requestId: string, messages: FastChatMessage[], model?: string): Promise<{ ok: boolean; error?: string }>;
  fastChatCancel(requestId: string): void;
  // Fires when ⌘/Ctrl+K is pressed anywhere in the app (forwarded from the main
  // process so it works regardless of which inner surface — terminal, editor,
  // browser pane — currently holds focus).
  onToggleQuickChat(callback: () => void): () => void;
  // While the Settings recorder is capturing a new hotkey, suspend the global
  // matcher so the keystroke reaches the renderer to be recorded.
  quickChatSetCapturing(capturing: boolean): void;
  onFastChatChunk(callback: (payload: { requestId: string; delta: string }) => void): () => void;
  onFastChatDone(callback: (payload: { requestId: string }) => void): () => void;
  onFastChatError(callback: (payload: { requestId: string; error: string }) => void): () => void;

  // Fast chat history (persisted, newest first, capped at quickChatHistoryLimit).
  quickChatHistoryList(): Promise<FastChatConversation[]>;
  quickChatHistorySave(conversation: { id: string; messages: FastChatMessage[] }): Promise<void>;
  quickChatHistoryDelete(id: string): Promise<void>;
  quickChatHistoryClear(): Promise<void>;

  // Agent activity (working/idle/waiting) reported by lifecycle hooks, keyed by
  // terminal session id ($SPLITGRID_TERMINAL).
  getClaudeActivity(): Promise<Record<string, ClaudeActivityState>>;
  onClaudeActivity(callback: (payload: { terminalId: string; state: ClaudeActivityState }) => void): () => void;
  // Agent-agnostic "needs attention" pulse from a notify OSC escape sequence in
  // any terminal's output (iTerm2 OSC 9 / kitty 99 / urxvt 777). Fires the
  // session id each time such a sequence is seen.
  onAgentNotify(callback: (sessionId: string) => void): () => void;

  // Fires the session id whenever input arrives FROM THE WEB relay (the user is
  // driving this terminal remotely). Used to suppress the desktop "done" sound
  // while the user is actively present on the web viewer.
  onTerminalWebInput(callback: (sessionId: string) => void): () => void;

  // Agent browser control: subscribe to forwarded browser commands and reply
  // with the result keyed by reqId.
  onBrowserCommand(
    callback: (payload: { reqId: string; terminal: string; argv: string[] }) => void
  ): () => void;
  sendBrowserResult(payload: {
    reqId: string;
    ok: boolean;
    data?: Record<string, unknown>;
    error?: string;
  }): void;
  // Agent terminal control: subscribe to forwarded terminal commands and reply
  // with the result keyed by reqId.
  onTerminalCommand(
    callback: (payload: { reqId: string; terminal: string; argv: string[] }) => void
  ): () => void;
  sendTerminalResult(payload: {
    reqId: string;
    ok: boolean;
    data?: Record<string, unknown>;
    error?: string;
  }): void;
  // Agent SQL control: subscribe to forwarded SQL commands and reply with the
  // result keyed by reqId.
  onSqlCommand(
    callback: (payload: { reqId: string; terminal: string; argv: string[]; writeAllowed: boolean }) => void
  ): () => void;
  sendSqlResult(payload: {
    reqId: string;
    ok: boolean;
    data?: Record<string, unknown>;
    error?: string;
  }): void;
  // file:// URL of the bundled webview focus-bridge preload (static).
  webviewPreloadUrl: string;

  // Static platform marker resolved at preload load time.
  platform: NodeJS.Platform;

  // Window controls for frameless platforms (Linux); no-op elsewhere.
  windowMinimize(): void;
  windowToggleMaximize(): void;
  windowClose(): void;
  /** Current fullscreen state of this window — queried on mount to reconcile a
   * fullscreen change that fired before the renderer subscribed. */
  isFullScreen(): Promise<boolean>;

  // SSH saved-password helper: main fires this when a password/sudo prompt is
  // detected on a session whose connection opted in; the renderer offers to send
  // the saved password (confirm-to-send — the password never leaves main).
  onSshPasswordPrompt(
    callback: (p: { sessionId: string; label: string; source: 'sudo' | 'login' }) => void,
  ): () => void;
  // User confirmed — tell main to inject the saved password into that PTY.
  applySshPassword(sessionId: string): void;

  // Web streaming auth (WorkOS). Login opens the system browser (PKCE + deep
  // link); the result arrives via onAuthChanged. Tokens stay in main.
  authGetSession(): Promise<AuthSession | null>;
  authLogin(): Promise<void>;
  authLogout(): Promise<void>;
  onAuthChanged(callback: (session: AuthSession | null) => void): () => void;

  // Web streaming producer: enable/disable streaming a terminal's output to the
  // relay, with its env→workspace routing metadata. Off by default; the desktop
  // only streams terminals explicitly shared from their pane header.
  relaySetShare(sessionId: string, enabled: boolean, meta?: RelayShareMeta): void;
  onRelayStatus(callback: (status: RelayStatus) => void): () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
