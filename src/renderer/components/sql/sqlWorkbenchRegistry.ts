// Module-level registry mapping a SQL container's id → an imperative handle on
// its live SqlWorkbench instance. The agent SQL bridge (useSqlAgentBridge) looks
// up a workbench by container id and drives it through this handle, so an agent's
// queries run through the SAME code paths as the user's clicks and the results
// SURFACE in the panel's UI (tabs/grid). Mirrors browserRegistry for the browser
// bridge. Runtime-only — nothing here is persisted.

import type {
  SQLColumnInfo,
  SQLDialect,
  SQLExportFormat,
  SQLQueryResult,
  SavedSQLConnection,
} from '../../../shared/types';

export interface SqlConnectionSummary {
  id: string;        // saved connection id
  label: string;
  dialect: SQLDialect;
  host: string;
  port: number;
  database: string;
}

export interface SqlPanelInfo {
  connected: boolean;
  connectionName: string | null;
  savedConnectionId: string | null;
  dialect: SQLDialect;
  database: string | null;
  schema: string | null;
  supportsSchemas: boolean;
}

export interface SqlTableSummary {
  schema: string;
  name: string;
  kind: string;
  rowEstimate?: number;
}

export interface SqlColumnSummary {
  column: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
}

// The operations the bridge needs. All async so the handle can drive React state
// updates + awaited electronAPI calls uniformly. Read ops may consult cached
// state; mutating/surfacing ops drive the existing handlers so the UI updates.
export interface SqlWorkbenchHandle {
  getInfo(): SqlPanelInfo;
  listConnections(): SqlConnectionSummary[];
  /** Switch the panel to a saved connection (drives handleConnectionSelect /
   * handleDatabaseSelect so the UI reflects it). Returns the new info or throws. */
  useConnection(nameOrId: string, database?: string): Promise<SqlPanelInfo>;
  listTables(schema?: string): SqlTableSummary[];
  listColumns(table: string, schema?: string): Promise<SqlColumnSummary[]>;
  getDdl(table: string, schema?: string): Promise<string>;
  /** Execute SQL AND surface it in a query tab (results render in the panel).
   * Returns the last statement's result. */
  runQuery(sql: string): Promise<SQLQueryResult>;
  /** EXPLAIN (read) the SQL; surfaces in a tab. Returns the raw plan rows. */
  explain(sql: string): Promise<SQLQueryResult>;
  /** Export a table to a file via the existing export path. */
  exportTable(table: string, format: SQLExportFormat, filePath: string, schema?: string): Promise<{ rowCount: number; filePath: string }>;
  /** Import a CSV file into a table (WRITE). */
  importCsv(table: string, csvPath: string, schema?: string): Promise<{ imported: number }>;
}

// Re-export a couple types the bridge formats against.
export type { SQLColumnInfo, SavedSQLConnection };

const registry = new Map<string, SqlWorkbenchHandle>();

export function registerSqlWorkbench(containerId: string, handle: SqlWorkbenchHandle): void {
  registry.set(containerId, handle);
}

export function unregisterSqlWorkbench(containerId: string): void {
  registry.delete(containerId);
}

export function getSqlWorkbench(containerId: string): SqlWorkbenchHandle | undefined {
  return registry.get(containerId);
}
