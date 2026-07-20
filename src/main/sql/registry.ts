import type {
  SQLConnectionConfig,
  SQLConnectionInfo,
  SQLDialect,
  SQLEditChange,
  SQLExportOptions,
  SQLExportResult,
  SQLImportRequest,
  SQLImportResult,
} from '../../shared/types';
import type { SqlDriver } from './driver';
import { buildEditStatements } from './edit-builder';
import { exportData, type ExportDeps } from './export';
import { importRows, type ImportDeps } from './import';
import { PostgresDriver } from './drivers/postgres';
import { MySQLDriver } from './drivers/mysql';
import { SQLiteDriver } from './drivers/sqlite';
import { MSSQLDriver } from './drivers/mssql';

/**
 * Central session registry. Maps each live connection id to the driver that
 * owns it, so the IPC layer can dispatch any call to the correct backend by id
 * alone. Drivers are lazily instantiated once per dialect and shared.
 */
class SqlRegistry {
  private drivers = new Map<SQLDialect, SqlDriver>();
  private sessions = new Map<string, SqlDriver>();

  private driverFor(dialect: SQLDialect): SqlDriver {
    let driver = this.drivers.get(dialect);
    if (driver) return driver;
    switch (dialect) {
      case 'postgres':
        driver = new PostgresDriver();
        break;
      case 'mysql':
      case 'mariadb':
        driver = new MySQLDriver();
        break;
      case 'sqlite':
        driver = new SQLiteDriver();
        break;
      case 'mssql':
        driver = new MSSQLDriver();
        break;
      default:
        throw new Error(`Unsupported SQL dialect: ${dialect}`);
    }
    this.drivers.set(dialect, driver);
    return driver;
  }

  private require(id: string): SqlDriver {
    const driver = this.sessions.get(id);
    if (!driver) throw new Error('SQL connection not found. Reconnect and try again.');
    return driver;
  }

  async connect(config: SQLConnectionConfig): Promise<SQLConnectionInfo> {
    const driver = this.driverFor(config.dialect);
    const info = await driver.connect(config);
    this.sessions.set(info.id, driver);
    return info;
  }

  async disconnect(id: string): Promise<void> {
    const driver = this.sessions.get(id);
    if (!driver) return;
    this.sessions.delete(id);
    await driver.disconnect(id);
  }

  execute(id: string, sql: string, params?: unknown[]) {
    return this.require(id).execute(id, sql, params);
  }
  listDatabases(id: string) {
    return this.require(id).listDatabases(id);
  }
  listSchemas(id: string) {
    return this.require(id).listSchemas(id);
  }
  listColumns(id: string) {
    return this.require(id).listColumns(id);
  }
  getPrimaryKey(id: string, schema: string, table: string) {
    return this.require(id).getPrimaryKey(id, schema, table);
  }
  listIndexes(id: string, schema: string, table: string) {
    return this.require(id).listIndexes(id, schema, table);
  }
  listKeys(id: string, schema: string, table: string) {
    return this.require(id).listKeys(id, schema, table);
  }
  listTriggers(id: string, schema: string, table?: string) {
    return this.require(id).listTriggers(id, schema, table);
  }
  renameObject(id: string, kind: Parameters<SqlDriver['renameObject']>[1], schema: string, name: string, newName: string) {
    return this.require(id).renameObject(id, kind, schema, name, newName);
  }
  dropObject(id: string, kind: Parameters<SqlDriver['dropObject']>[1], schema: string, name: string, opts?: { cascade?: boolean }) {
    return this.require(id).dropObject(id, kind, schema, name, opts);
  }
  getDialect(id: string): SQLDialect {
    return this.require(id).getDialect(id);
  }

  /**
   * Apply a batch of editable-grid changes in ONE transaction. Each change is
   * turned into a parameterized UPDATE/INSERT/DELETE by the edit-builder (correct
   * per-dialect quoting + placeholders), then executed in order inside
   * begin → … → commit. Any error rolls back and rethrows so the renderer keeps
   * its diff buffer. Returns the number of statements applied.
   */
  async applyEdits(id: string, changes: SQLEditChange[]): Promise<{ applied: number }> {
    const driver = this.require(id);
    if (changes.length === 0) return { applied: 0 };
    const dialect = driver.getDialect(id);
    const statements = buildEditStatements(changes, dialect);
    await driver.beginTx(id);
    try {
      for (const stmt of statements) {
        await driver.execute(id, stmt.sql, stmt.params);
      }
      await driver.commitTx(id);
      return { applied: statements.length };
    } catch (err) {
      await driver.rollbackTx(id).catch(() => {});
      throw err;
    }
  }
  getDDL(id: string, schema: string, name: string, kind: Parameters<SqlDriver['getDDL']>[3]) {
    return this.require(id).getDDL(id, schema, name, kind);
  }

  /** Export a result set / full table to a file (see sql/export.ts). For a
   * full-table scope the driver is required so we can page; for current-view of a
   * disconnected snapshot, connectionId may be null. */
  exportData(connectionId: string | null, options: SQLExportOptions): Promise<SQLExportResult> {
    const deps: ExportDeps = {
      execute: (id, sql, params) => this.require(id).execute(id, sql, params),
      getDialect: (id) => this.require(id).getDialect(id),
    };
    return exportData(deps, connectionId, options);
  }

  /** Batched, transactional CSV → table import (see sql/import.ts). */
  importRows(connectionId: string, request: SQLImportRequest): Promise<SQLImportResult> {
    const driver = this.require(connectionId);
    const deps: ImportDeps = {
      execute: (id, sql, params) => driver.execute(id, sql, params),
      getDialect: (id) => driver.getDialect(id),
      beginTx: (id) => driver.beginTx(id),
      commitTx: (id) => driver.commitTx(id),
      rollbackTx: (id) => driver.rollbackTx(id),
    };
    return importRows(deps, connectionId, request);
  }
  beginTx(id: string) {
    return this.require(id).beginTx(id);
  }
  commitTx(id: string) {
    return this.require(id).commitTx(id);
  }
  rollbackTx(id: string) {
    return this.require(id).rollbackTx(id);
  }
}

export const sqlRegistry = new SqlRegistry();
