import { v4 as uuidv4 } from 'uuid';
import { ConnectionPool, Transaction, type IRecordSet } from 'mssql';
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
import { MAX_RESULT_ROWS, STATEMENT_TIMEOUT_MS, normalizeRow, type SqlDriver } from '../driver';
import * as introspect from '../introspect/mssql';
import { buildRenameSql, buildDropSql } from '../ddl-mutations';

interface Session {
  id: string;
  pool: ConnectionPool;
  info: SQLConnectionInfo;
  tx?: Transaction;
}

/** Microsoft SQL Server backend (node-mssql / tedious). */
export class MSSQLDriver implements SqlDriver {
  private sessions = new Map<string, Session>();

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error('SQL connection not found. Reconnect and try again.');
    return session;
  }

  async connect(config: SQLConnectionConfig): Promise<SQLConnectionInfo> {
    const isLocal = config.host === 'localhost' || config.host === '127.0.0.1' || config.host === '::1';
    const pool = new ConnectionPool({
      server: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      options: {
        encrypt: !!config.ssl,
        trustServerCertificate: isLocal || !config.ssl,
      },
      requestTimeout: STATEMENT_TIMEOUT_MS,
      connectionTimeout: STATEMENT_TIMEOUT_MS,
    });
    await pool.connect();

    const versionRes = await pool.request().query<{ version: string }>(`select @@version as version`);
    const info: SQLConnectionInfo = {
      id: uuidv4(),
      dialect: config.dialect,
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      ssl: !!config.ssl,
      connectedAt: Date.now(),
      serverVersion: versionRes.recordset[0]?.version,
    };
    this.sessions.set(info.id, { id: info.id, pool, info });
    return info;
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.pool.close();
  }

  async execute(id: string, sql: string, params?: unknown[]): Promise<SQLQueryResult> {
    const session = this.require(id);
    const query = sql.trim();
    if (!query) throw new Error('Query is empty.');

    const request = session.tx ? session.tx.request() : session.pool.request();
    if (params) params.forEach((value, i) => request.input(`p${i + 1}`, value));

    const start = Date.now();
    const result = await request.query(query);
    const durationMs = Date.now() - start;

    const recordset = (Array.isArray(result.recordset) ? result.recordset : []) as IRecordSet<Record<string, unknown>>;
    const affected = result.rowsAffected?.reduce((a, b) => a + b, 0) ?? 0;

    if (recordset.length || (result.recordsets && result.recordsets.length)) {
      const allRows = recordset as unknown as Array<Record<string, unknown>>;
      const rows = allRows.slice(0, MAX_RESULT_ROWS).map((row) => normalizeRow(row));
      const columns = recordset.columns ? Object.keys(recordset.columns) : allRows.length ? Object.keys(allRows[0]) : [];
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

    return {
      command: query.split(/\s+/)[0]?.toUpperCase() || 'QUERY',
      rowCount: affected,
      durationMs,
      columns: [],
      rows: [],
      truncated: false,
      affectedRows: affected,
    };
  }

  listDatabases(id: string): Promise<SQLDatabaseInfo[]> {
    const session = this.require(id);
    return introspect.listDatabases(session.pool, session.info.database);
  }

  listSchemas(id: string): Promise<SQLSchemaTree[]> {
    return introspect.listSchemas(this.require(id).pool);
  }

  listColumns(id: string): Promise<SQLColumnInfo[]> {
    return introspect.listColumns(this.require(id).pool);
  }

  getPrimaryKey(id: string, schema: string, table: string): Promise<string[]> {
    return introspect.getPrimaryKey(this.require(id).pool, schema || 'dbo', table);
  }

  listIndexes(id: string, schema: string, table: string) {
    return introspect.listIndexes(this.require(id).pool, schema || 'dbo', table);
  }
  listKeys(id: string, schema: string, table: string) {
    return introspect.listKeys(this.require(id).pool, schema || 'dbo', table);
  }
  listTriggers(id: string, schema: string, table?: string) {
    return introspect.listTriggers(this.require(id).pool, schema || 'dbo', table);
  }

  async renameObject(id: string, kind: SQLSchemaObjectKind, schema: string, name: string, newName: string): Promise<void> {
    await this.execute(id, buildRenameSql('mssql', kind, schema || 'dbo', name, newName));
  }
  async dropObject(id: string, kind: SQLSchemaObjectKind, schema: string, name: string, opts?: { cascade?: boolean }): Promise<void> {
    await this.execute(id, buildDropSql('mssql', kind, schema || 'dbo', name, opts));
  }

  getDialect(id: string): SQLDialect {
    return this.require(id).info.dialect;
  }

  async getDDL(id: string, schema: string, name: string, kind: SQLSchemaObjectKind): Promise<SQLObjectDDL> {
    const session = this.require(id);
    let ddl = '';
    if (kind === 'view' || kind === 'procedure' || kind === 'function') {
      ddl = await introspect.getModuleDefinition(session.pool, schema || 'dbo', name);
    } else {
      // Tables: reconstruct a minimal CREATE TABLE from information_schema columns.
      const cols = (await introspect.listColumns(session.pool)).filter((c) => c.schema === (schema || 'dbo') && c.table === name);
      const lines = cols.map(
        (c) => `  [${c.column}] ${c.dataType ?? ''}${c.isNullable === false ? ' NOT NULL' : ' NULL'}${c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ''}`
      );
      ddl = `CREATE TABLE [${schema || 'dbo'}].[${name}] (\n${lines.join(',\n')}\n);`;
    }
    return { schema, name, kind, ddl };
  }

  async beginTx(id: string): Promise<void> {
    const session = this.require(id);
    const tx = new Transaction(session.pool);
    await tx.begin();
    session.tx = tx;
  }
  async commitTx(id: string): Promise<void> {
    const session = this.require(id);
    if (!session.tx) return;
    await session.tx.commit();
    session.tx = undefined;
  }
  async rollbackTx(id: string): Promise<void> {
    const session = this.require(id);
    if (!session.tx) return;
    await session.tx.rollback();
    session.tx = undefined;
  }
}
