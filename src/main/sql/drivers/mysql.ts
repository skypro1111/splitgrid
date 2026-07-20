import { v4 as uuidv4 } from 'uuid';
import mysql, { type Connection } from 'mysql2/promise';
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
import { getDialectCapabilities } from '../../../shared/dialects';
import { MAX_RESULT_ROWS, STATEMENT_TIMEOUT_MS, normalizeRow, type SqlDriver } from '../driver';
import * as introspect from '../introspect/mysql';
import { buildRenameSql, buildDropSql } from '../ddl-mutations';

interface Session {
  id: string;
  conn: Connection;
  info: SQLConnectionInfo;
}

/** MySQL & MariaDB share this driver; they differ only by capabilities. */
export class MySQLDriver implements SqlDriver {
  private sessions = new Map<string, Session>();

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error('SQL connection not found. Reconnect and try again.');
    return session;
  }

  async connect(config: SQLConnectionConfig): Promise<SQLConnectionInfo> {
    const conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.ssl
        ? { rejectUnauthorized: config.host !== 'localhost' && config.host !== '127.0.0.1' && config.host !== '::1' }
        : undefined,
      connectTimeout: STATEMENT_TIMEOUT_MS,
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });

    const [versionRows] = await conn.query('select version() as version');
    const serverVersion = (versionRows as Array<{ version: string }>)[0]?.version;

    const info: SQLConnectionInfo = {
      id: uuidv4(),
      dialect: config.dialect,
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      ssl: !!config.ssl,
      connectedAt: Date.now(),
      serverVersion,
    };
    this.sessions.set(info.id, { id: info.id, conn, info });
    return info;
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.conn.end();
  }

  async execute(id: string, sql: string, params?: unknown[]): Promise<SQLQueryResult> {
    const session = this.require(id);
    const query = sql.trim();
    if (!query) throw new Error('Query is empty.');

    const start = Date.now();
    const [result, fields] = await session.conn.query(query, params ?? []);
    const durationMs = Date.now() - start;

    // SELECT-style → result is an array of row objects + fields metadata.
    if (Array.isArray(result)) {
      const fieldDefs = (fields ?? []) as Array<{ name: string }>;
      const allRows = result as Array<Record<string, unknown>>;
      const rows = allRows.slice(0, MAX_RESULT_ROWS).map((row) => normalizeRow(row));
      return {
        command: 'SELECT',
        rowCount: allRows.length,
        durationMs,
        columns: fieldDefs.map((f) => f.name),
        rows,
        truncated: allRows.length > MAX_RESULT_ROWS,
        fields: fieldDefs.map((f) => ({ name: f.name })),
      };
    }

    // DML/DDL → ResultSetHeader with affectedRows.
    const header = result as { affectedRows?: number; info?: string };
    return {
      command: query.split(/\s+/)[0]?.toUpperCase() || 'QUERY',
      rowCount: header.affectedRows ?? 0,
      durationMs,
      columns: [],
      rows: [],
      truncated: false,
      affectedRows: header.affectedRows ?? 0,
    };
  }

  listDatabases(id: string): Promise<SQLDatabaseInfo[]> {
    const session = this.require(id);
    return introspect.listDatabases(session.conn, session.info.database);
  }

  listSchemas(id: string): Promise<SQLSchemaTree[]> {
    const session = this.require(id);
    const caps = getDialectCapabilities(session.info.dialect);
    return introspect.listSchemas(session.conn, session.info.database, caps.supportsSequences);
  }

  listColumns(id: string): Promise<SQLColumnInfo[]> {
    const session = this.require(id);
    return introspect.listColumns(session.conn, session.info.database);
  }

  getPrimaryKey(id: string, schema: string, table: string): Promise<string[]> {
    const session = this.require(id);
    // MySQL "schema" is the database; the synthetic schema node uses the db name.
    return introspect.getPrimaryKey(session.conn, schema || session.info.database, table);
  }

  listIndexes(id: string, schema: string, table: string) {
    const s = this.require(id);
    return introspect.listIndexes(s.conn, schema || s.info.database, table);
  }
  listKeys(id: string, schema: string, table: string) {
    const s = this.require(id);
    return introspect.listKeys(s.conn, schema || s.info.database, table);
  }
  listTriggers(id: string, schema: string, table?: string) {
    const s = this.require(id);
    return introspect.listTriggers(s.conn, schema || s.info.database, table);
  }

  async renameObject(id: string, kind: SQLSchemaObjectKind, schema: string, name: string, newName: string): Promise<void> {
    await this.execute(id, buildRenameSql(this.getDialect(id), kind, schema, name, newName));
  }
  async dropObject(id: string, kind: SQLSchemaObjectKind, schema: string, name: string, opts?: { cascade?: boolean }): Promise<void> {
    await this.execute(id, buildDropSql(this.getDialect(id), kind, schema, name, opts));
  }

  getDialect(id: string): SQLDialect {
    return this.require(id).info.dialect;
  }

  async getDDL(id: string, schema: string, name: string, kind: SQLSchemaObjectKind): Promise<SQLObjectDDL> {
    const session = this.require(id);
    const q = (object: string) => `SHOW CREATE ${object} \`${name}\``;
    let ddl = '';
    try {
      if (kind === 'view') {
        const [r] = await session.conn.query(q('VIEW'));
        ddl = (r as Array<Record<string, unknown>>)[0]?.['Create View'] as string ?? '';
      } else if (kind === 'procedure') {
        const [r] = await session.conn.query(q('PROCEDURE'));
        ddl = (r as Array<Record<string, unknown>>)[0]?.['Create Procedure'] as string ?? '';
      } else if (kind === 'function') {
        const [r] = await session.conn.query(q('FUNCTION'));
        ddl = (r as Array<Record<string, unknown>>)[0]?.['Create Function'] as string ?? '';
      } else {
        const [r] = await session.conn.query(q('TABLE'));
        ddl = (r as Array<Record<string, unknown>>)[0]?.['Create Table'] as string ?? '';
      }
    } catch (err) {
      ddl = `-- Could not retrieve DDL: ${(err as Error).message}`;
    }
    return { schema, name, kind, ddl };
  }

  async beginTx(id: string): Promise<void> {
    await this.require(id).conn.beginTransaction();
  }
  async commitTx(id: string): Promise<void> {
    await this.require(id).conn.commit();
  }
  async rollbackTx(id: string): Promise<void> {
    await this.require(id).conn.rollback();
  }
}
