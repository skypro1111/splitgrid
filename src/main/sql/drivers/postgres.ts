import { v4 as uuidv4 } from 'uuid';
import { Client, type QueryResultRow } from 'pg';
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
import * as introspect from '../introspect/postgres';
import { buildRenameSql, buildDropSql } from '../ddl-mutations';

interface Session {
  id: string;
  client: Client;
  info: SQLConnectionInfo;
}

/** PostgreSQL backend — behavior-identical to the legacy SQLManager. */
export class PostgresDriver implements SqlDriver {
  private sessions = new Map<string, Session>();

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error('SQL connection not found. Reconnect and try again.');
    return session;
  }

  async connect(config: SQLConnectionConfig): Promise<SQLConnectionInfo> {
    const client = new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.ssl
        ? { rejectUnauthorized: config.host !== 'localhost' && config.host !== '127.0.0.1' && config.host !== '::1' }
        : false,
      statement_timeout: 30000,
    });

    await client.connect();
    const versionRes = await client.query<{ version: string }>('select version() as version');
    const info: SQLConnectionInfo = {
      id: uuidv4(),
      dialect: config.dialect,
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      ssl: !!config.ssl,
      connectedAt: Date.now(),
      serverVersion: versionRes.rows[0]?.version,
    };

    this.sessions.set(info.id, { id: info.id, client, info });
    return info;
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.client.end();
  }

  async execute(id: string, sql: string, params?: unknown[]): Promise<SQLQueryResult> {
    const session = this.require(id);
    const query = sql.trim();
    if (!query) throw new Error('Query is empty.');

    const start = Date.now();
    const result = await session.client.query(params && params.length ? { text: query, values: params } : query);
    const durationMs = Date.now() - start;
    const rows = result.rows.slice(0, MAX_RESULT_ROWS).map((row: QueryResultRow) => normalizeRow(row));

    return {
      command: result.command ?? 'QUERY',
      rowCount: result.rowCount ?? rows.length,
      durationMs,
      columns: result.fields.map((field: { name: string }) => field.name),
      rows,
      truncated: result.rows.length > MAX_RESULT_ROWS,
      fields: result.fields.map((field: { name: string }) => ({ name: field.name })),
      affectedRows: result.rowCount ?? undefined,
    };
  }

  listDatabases(id: string): Promise<SQLDatabaseInfo[]> {
    const session = this.require(id);
    return introspect.listDatabases(session.client, session.info.database);
  }

  listSchemas(id: string): Promise<SQLSchemaTree[]> {
    return introspect.listSchemas(this.require(id).client);
  }

  listColumns(id: string): Promise<SQLColumnInfo[]> {
    return introspect.listColumns(this.require(id).client);
  }

  getPrimaryKey(id: string, schema: string, table: string): Promise<string[]> {
    return introspect.getPrimaryKey(this.require(id).client, schema, table);
  }

  listIndexes(id: string, schema: string, table: string) {
    return introspect.listIndexes(this.require(id).client, schema, table);
  }
  listKeys(id: string, schema: string, table: string) {
    return introspect.listKeys(this.require(id).client, schema, table);
  }
  listTriggers(id: string, schema: string, table?: string) {
    return introspect.listTriggers(this.require(id).client, schema, table);
  }

  async renameObject(id: string, kind: SQLSchemaObjectKind, schema: string, name: string, newName: string): Promise<void> {
    await this.execute(id, buildRenameSql('postgres', kind, schema, name, newName));
  }
  async dropObject(id: string, kind: SQLSchemaObjectKind, schema: string, name: string, opts?: { cascade?: boolean }): Promise<void> {
    await this.execute(id, buildDropSql('postgres', kind, schema, name, opts));
  }

  getDialect(id: string): SQLDialect {
    return this.require(id).info.dialect;
  }

  async getDDL(id: string, schema: string, name: string, kind: SQLSchemaObjectKind): Promise<SQLObjectDDL> {
    const client = this.require(id).client;
    let ddl = '';
    if (kind === 'view' || kind === 'materializedView') {
      const r = await client.query<{ def: string }>('select pg_get_viewdef($1::regclass, true) as def', [`"${schema}"."${name}"`]);
      ddl = r.rows[0]?.def ?? '';
    } else if (kind === 'function' || kind === 'procedure') {
      const r = await client.query<{ def: string }>(
        `select pg_get_functiondef(p.oid) as def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = $1 and p.proname = $2 limit 1`,
        [schema, name]
      );
      ddl = r.rows[0]?.def ?? '';
    } else {
      // Tables/others: reconstruct a CREATE TABLE skeleton from information_schema.
      const cols = await introspect.listColumns(client);
      const tableCols = cols.filter((c) => c.schema === schema && c.table === name);
      const lines = tableCols.map(
        (c) => `  "${c.column}" ${c.dataType ?? ''}${c.isNullable === false ? ' NOT NULL' : ''}${c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ''}`
      );
      ddl = `CREATE TABLE "${schema}"."${name}" (\n${lines.join(',\n')}\n);`;
    }
    return { schema, name, kind, ddl };
  }

  async beginTx(id: string): Promise<void> {
    await this.require(id).client.query('BEGIN');
  }
  async commitTx(id: string): Promise<void> {
    await this.require(id).client.query('COMMIT');
  }
  async rollbackTx(id: string): Promise<void> {
    await this.require(id).client.query('ROLLBACK');
  }
}
