import type { SQLDialect, SQLImportRequest, SQLImportResult, SQLQueryResult } from '../../shared/types';
import { getDialectCapabilities } from '../../shared/dialects';

/** What the importer needs: parameterized execute, dialect, and tx control. */
export interface ImportDeps {
  execute: (id: string, sql: string, params?: unknown[]) => Promise<SQLQueryResult>;
  getDialect: (id: string) => SQLDialect;
  beginTx: (id: string) => Promise<void>;
  commitTx: (id: string) => Promise<void>;
  rollbackTx: (id: string) => Promise<void>;
}

function quoteIdent(name: string, dialect: SQLDialect): string {
  const caps = getDialectCapabilities(dialect);
  const open = caps.identifierQuote;
  const close = caps.identifierQuoteClose;
  return `${open}${name.split(close).join(close + close)}${close}`;
}

function tableRef(schema: string, table: string, dialect: SQLDialect): string {
  const caps = getDialectCapabilities(dialect);
  const t = quoteIdent(table, dialect);
  return caps.supportsSchemas && schema ? `${quoteIdent(schema, dialect)}.${t}` : t;
}

/** Emit a placeholder for the 1-based parameter index in the given dialect. */
function placeholder(dialect: SQLDialect, index: number): string {
  const style = getDialectCapabilities(dialect).paramPlaceholder;
  if (style === 'numbered') return `$${index}`;
  if (style === 'named') return `@p${index}`;
  return '?';
}

/**
 * Build a single multi-row parameterized INSERT for one batch of rows, returning
 * the SQL + the flat ordered bind values. NEVER interpolates cell values into the
 * SQL text — every value is a bind parameter (injection-safe).
 */
function buildBatchInsert(
  schema: string,
  table: string,
  columns: string[],
  rows: unknown[][],
  dialect: SQLDialect,
): { sql: string; params: unknown[] } {
  const ref = tableRef(schema, table, dialect);
  const colSql = columns.map((c) => quoteIdent(c, dialect)).join(', ');
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const cells = columns.map((_c, ci) => {
      params.push(row[ci] ?? null);
      return placeholder(dialect, params.length);
    });
    return `(${cells.join(', ')})`;
  });
  return { sql: `INSERT INTO ${ref} (${colSql}) VALUES ${tuples.join(', ')}`, params };
}

/**
 * Most bind values one statement may carry: SQL Server caps a request at 2100
 * parameters, Postgres' protocol at 65535, SQLite (as bundled) at 32766. MySQL
 * values are interpolated client-side, so only packet size bounds it.
 */
const MAX_PARAMS: Record<SQLDialect, number> = {
  postgres: 65535,
  mysql: 65535,
  mariadb: 65535,
  sqlite: 32766,
  mssql: 2100,
};

/**
 * Import rows into a table as batched parameterized INSERTs inside ONE
 * transaction. Optionally TRUNCATEs first (DELETE fallback when TRUNCATE is
 * unsupported in a tx). Any error rolls back and rethrows.
 */
export async function importRows(
  deps: ImportDeps,
  connectionId: string,
  request: SQLImportRequest,
): Promise<SQLImportResult> {
  const dialect = deps.getDialect(connectionId);
  const { schema, table, columns } = request;
  if (columns.length === 0) throw new Error('No target columns selected for import.');
  // The requested batch, shrunk so rows × columns fits the dialect's parameter
  // limit — 200 rows of an 11-column table is already past SQL Server's 2100.
  const batchSize = Math.max(
    1,
    Math.min(request.batchSize ?? 200, 1000, Math.floor(MAX_PARAMS[dialect] / columns.length)),
  );

  await deps.beginTx(connectionId);
  let imported = 0;
  try {
    if (request.truncate) {
      const ref = tableRef(schema, table, dialect);
      // sqlite has no TRUNCATE; MySQL/MariaDB's commits the transaction
      // implicitly, so a failed import could not roll the emptied table back.
      // DELETE in both; the others truncate transactionally.
      const stmt = dialect === 'sqlite' || dialect === 'mysql' || dialect === 'mariadb'
        ? `DELETE FROM ${ref}`
        : `TRUNCATE TABLE ${ref}`;
      await deps.execute(connectionId, stmt, []);
    }
    for (let i = 0; i < request.rows.length; i += batchSize) {
      const batch = request.rows.slice(i, i + batchSize);
      if (batch.length === 0) continue;
      const { sql, params } = buildBatchInsert(schema, table, columns, batch, dialect);
      await deps.execute(connectionId, sql, params);
      imported += batch.length;
    }
    await deps.commitTx(connectionId);
    return { ok: true, imported };
  } catch (err) {
    await deps.rollbackTx(connectionId).catch(() => {});
    throw err;
  }
}
