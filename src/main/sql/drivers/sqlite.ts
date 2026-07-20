import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
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
} from '../../../shared/types';
import { MAX_RESULT_ROWS, normalizeRow, type SqlDriver } from '../driver';
import * as introspect from '../introspect/sqlite';
import { buildRenameSql, buildDropSql } from '../ddl-mutations';

interface Session {
  id: string;
  db: Database.Database;
  info: SQLConnectionInfo;
}

/** SQLite backend (better-sqlite3, synchronous). The DB file path is config.filePath || config.database. */
export class SQLiteDriver implements SqlDriver {
  private sessions = new Map<string, Session>();

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error('SQL connection not found. Reconnect and try again.');
    return session;
  }

  async connect(config: SQLConnectionConfig): Promise<SQLConnectionInfo> {
    const filePath = (config.filePath || config.database || '').trim();
    if (!filePath) throw new Error('SQLite requires a database file path.');

    const db = new Database(filePath, { fileMustExist: false });
    const versionRow = db.prepare('select sqlite_version() as version').get() as { version: string };

    const info: SQLConnectionInfo = {
      id: uuidv4(),
      dialect: config.dialect,
      host: filePath,
      port: 0,
      user: '',
      database: filePath,
      ssl: false,
      connectedAt: Date.now(),
      serverVersion: `SQLite ${versionRow.version}`,
    };
    this.sessions.set(info.id, { id: info.id, db, info });
    return info;
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.db.close();
  }

  async execute(id: string, sql: string, params?: unknown[]): Promise<SQLQueryResult> {
    const session = this.require(id);
    const query = sql.trim();
    if (!query) throw new Error('Query is empty.');

    const start = Date.now();
    const stmt = session.db.prepare(query);
    // better-sqlite3 requires .all() for row-returning statements and .run() otherwise.
    if (stmt.reader) {
      const allRows = (params && params.length ? stmt.all(...params) : stmt.all()) as Array<Record<string, unknown>>;
      const rows = allRows.slice(0, MAX_RESULT_ROWS).map((row) => normalizeRow(row));
      const columns = allRows.length ? Object.keys(allRows[0]) : (stmt.columns().map((c) => c.name) ?? []);
      const durationMs = Date.now() - start;
      return {
        command: 'SELECT',
        rowCount: allRows.length,
        durationMs,
        columns,
        rows,
        truncated: allRows.length > MAX_RESULT_ROWS,
        fields: columns.map((name) => ({ name })),
      };
    }

    const result = params && params.length ? stmt.run(...params) : stmt.run();
    const durationMs = Date.now() - start;
    return {
      command: query.split(/\s+/)[0]?.toUpperCase() || 'QUERY',
      rowCount: result.changes,
      durationMs,
      columns: [],
      rows: [],
      truncated: false,
      affectedRows: result.changes,
    };
  }

  async listDatabases(id: string): Promise<SQLDatabaseInfo[]> {
    // SQLite is single-file; report the one attached database.
    const session = this.require(id);
    return [{ name: session.info.database, sizeBytes: 0, description: null, isCurrent: true }];
  }

  async listSchemas(id: string): Promise<SQLSchemaTree[]> {
    return introspect.listSchemas(this.require(id).db);
  }

  async listColumns(id: string): Promise<SQLColumnInfo[]> {
    return introspect.listColumns(this.require(id).db);
  }

  async getPrimaryKey(id: string, _schema: string, table: string): Promise<string[]> {
    return introspect.getPrimaryKey(this.require(id).db, table);
  }

  async listIndexes(id: string, _schema: string, table: string) {
    return introspect.listIndexes(this.require(id).db, table);
  }
  async listKeys(id: string, _schema: string, table: string) {
    return introspect.listKeys(this.require(id).db, table);
  }
  async listTriggers(id: string, _schema: string, table?: string) {
    return introspect.listTriggers(this.require(id).db, table);
  }

  async renameObject(id: string, kind: SQLSchemaObjectKind, schema: string, name: string, newName: string): Promise<void> {
    await this.execute(id, buildRenameSql('sqlite', kind, schema, name, newName));
  }
  async dropObject(id: string, kind: SQLSchemaObjectKind, schema: string, name: string, opts?: { cascade?: boolean }): Promise<void> {
    await this.execute(id, buildDropSql('sqlite', kind, schema, name, opts));
  }

  getDialect(id: string): SQLDialect {
    return this.require(id).info.dialect;
  }

  async getDDL(id: string, schema: string, name: string, kind: SQLSchemaObjectKind): Promise<SQLObjectDDL> {
    return { schema, name, kind, ddl: introspect.getDDL(this.require(id).db, name) };
  }

  async beginTx(id: string): Promise<void> {
    this.require(id).db.prepare('BEGIN').run();
  }
  async commitTx(id: string): Promise<void> {
    this.require(id).db.prepare('COMMIT').run();
  }
  async rollbackTx(id: string): Promise<void> {
    this.require(id).db.prepare('ROLLBACK').run();
  }
}
