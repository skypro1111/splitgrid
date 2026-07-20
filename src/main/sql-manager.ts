import type {
  SQLConnectionConfig,
  SQLColumnInfo,
  SQLDatabaseInfo,
  SQLConnectionInfo,
  SQLQueryResult,
  SQLSchemaObjectKind,
  SQLObjectDDL,
  SQLSchemaTree,
  SQLEditChange,
  SQLIndexInfo,
  SQLKeyInfo,
  SQLTriggerInfo,
  SQLExportOptions,
  SQLExportResult,
  SQLImportRequest,
  SQLImportResult,
} from '../shared/types';
import { sqlRegistry } from './sql/registry';

/**
 * Thin compatibility shim over the multi-dialect driver registry.
 *
 * Historically this class held the hard-wired pg engine; that logic now lives in
 * `sql/drivers/postgres.ts` behind the `SqlDriver` interface, and dispatch goes
 * through `sql/registry.ts` keyed by connection id. Keeping this shim means the
 * IPC layer's `new SQLManager()` + method calls are untouched, so the renderer
 * (and the postgres code path) behave exactly as before.
 */
export class SQLManager {
  connect(config: SQLConnectionConfig): Promise<SQLConnectionInfo> {
    return sqlRegistry.connect(config);
  }
  disconnect(connectionId: string): Promise<void> {
    return sqlRegistry.disconnect(connectionId);
  }
  execute(connectionId: string, sql: string, params?: unknown[]): Promise<SQLQueryResult> {
    return sqlRegistry.execute(connectionId, sql, params);
  }
  listDatabases(connectionId: string): Promise<SQLDatabaseInfo[]> {
    return sqlRegistry.listDatabases(connectionId);
  }
  listSchemas(connectionId: string): Promise<SQLSchemaTree[]> {
    return sqlRegistry.listSchemas(connectionId);
  }
  listColumns(connectionId: string): Promise<SQLColumnInfo[]> {
    return sqlRegistry.listColumns(connectionId);
  }
  getPrimaryKey(connectionId: string, schema: string, table: string): Promise<string[]> {
    return sqlRegistry.getPrimaryKey(connectionId, schema, table);
  }
  listIndexes(connectionId: string, schema: string, table: string): Promise<SQLIndexInfo[]> {
    return sqlRegistry.listIndexes(connectionId, schema, table);
  }
  listKeys(connectionId: string, schema: string, table: string): Promise<SQLKeyInfo[]> {
    return sqlRegistry.listKeys(connectionId, schema, table);
  }
  listTriggers(connectionId: string, schema: string, table?: string): Promise<SQLTriggerInfo[]> {
    return sqlRegistry.listTriggers(connectionId, schema, table);
  }
  renameObject(connectionId: string, kind: SQLSchemaObjectKind, schema: string, name: string, newName: string): Promise<void> {
    return sqlRegistry.renameObject(connectionId, kind, schema, name, newName);
  }
  dropObject(connectionId: string, kind: SQLSchemaObjectKind, schema: string, name: string, opts?: { cascade?: boolean }): Promise<void> {
    return sqlRegistry.dropObject(connectionId, kind, schema, name, opts);
  }
  applyEdits(connectionId: string, changes: SQLEditChange[]): Promise<{ applied: number }> {
    return sqlRegistry.applyEdits(connectionId, changes);
  }
  getDDL(connectionId: string, schema: string, name: string, kind: SQLSchemaObjectKind): Promise<SQLObjectDDL> {
    return sqlRegistry.getDDL(connectionId, schema, name, kind);
  }
  beginTx(connectionId: string): Promise<void> {
    return sqlRegistry.beginTx(connectionId);
  }
  commitTx(connectionId: string): Promise<void> {
    return sqlRegistry.commitTx(connectionId);
  }
  rollbackTx(connectionId: string): Promise<void> {
    return sqlRegistry.rollbackTx(connectionId);
  }
  exportData(connectionId: string | null, options: SQLExportOptions): Promise<SQLExportResult> {
    return sqlRegistry.exportData(connectionId, options);
  }
  importRows(connectionId: string, request: SQLImportRequest): Promise<SQLImportResult> {
    return sqlRegistry.importRows(connectionId, request);
  }
}
