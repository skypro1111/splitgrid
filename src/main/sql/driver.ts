import type {
  SQLConnectionConfig,
  SQLColumnInfo,
  SQLDatabaseInfo,
  SQLConnectionInfo,
  SQLDialect,
  SQLQueryResult,
  SQLSchemaTree,
  SQLObjectDDL,
  SQLSchemaObjectKind,
  SQLIndexInfo,
  SQLKeyInfo,
  SQLTriggerInfo,
} from '../../shared/types';

/**
 * A dialect-specific backend. One driver instance manages many sessions, each
 * keyed by the connection id minted in `connect()`. The IPC layer never touches
 * a concrete driver — it dispatches through the registry by session id.
 *
 * Every method mirrors a `sql:` IPC channel. Results are normalized to the same
 * shared shapes the renderer already consumes, regardless of dialect.
 */
export interface SqlDriver {
  connect(config: SQLConnectionConfig): Promise<SQLConnectionInfo>;
  disconnect(id: string): Promise<void>;
  execute(id: string, sql: string, params?: unknown[]): Promise<SQLQueryResult>;
  listDatabases(id: string): Promise<SQLDatabaseInfo[]>;
  listSchemas(id: string): Promise<SQLSchemaTree[]>;
  listColumns(id: string): Promise<SQLColumnInfo[]>;
  getPrimaryKey(id: string, schema: string, table: string): Promise<string[]>;
  listIndexes(id: string, schema: string, table: string): Promise<SQLIndexInfo[]>;
  listKeys(id: string, schema: string, table: string): Promise<SQLKeyInfo[]>;
  listTriggers(id: string, schema: string, table?: string): Promise<SQLTriggerInfo[]>;
  /** Rename a schema object via per-dialect DDL, then execute it. */
  renameObject(id: string, kind: SQLSchemaObjectKind, schema: string, name: string, newName: string): Promise<void>;
  /** Drop a schema object via per-dialect DDL, then execute it. Destructive. */
  dropObject(id: string, kind: SQLSchemaObjectKind, schema: string, name: string, opts?: { cascade?: boolean }): Promise<void>;
  /** The SQL dialect of a live session — used by the edit-builder to pick
   * per-dialect identifier quoting and param placeholders. */
  getDialect(id: string): SQLDialect;
  getDDL(id: string, schema: string, name: string, kind: SQLSchemaObjectKind): Promise<SQLObjectDDL>;
  beginTx(id: string): Promise<void>;
  commitTx(id: string): Promise<void>;
  rollbackTx(id: string): Promise<void>;
}

/** Result rows are capped at this size across every dialect (matches legacy pg behavior). */
export const MAX_RESULT_ROWS = 1000;
export const STATEMENT_TIMEOUT_MS = 30000;

/** Shared value normalization so a JSON-serializable, renderer-safe row goes over IPC. */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizeValue(value);
  }
  return normalized;
}
