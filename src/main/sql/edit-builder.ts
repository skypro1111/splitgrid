import type { SQLDialect, SQLEditChange } from '../../shared/types';
import { getDialectCapabilities } from '../../shared/dialects';

/** One parameterized statement: SQL text + the ordered bind values. */
export interface PreparedEdit {
  sql: string;
  params: unknown[];
}

/**
 * Quote a SQL identifier for the given dialect. Mirrors the renderer's
 * `quoteIdent` (the closing quote char is doubled to escape it). Kept here so
 * the main process has no renderer dependency.
 */
function quoteIdent(name: string, dialect: SQLDialect): string {
  const caps = getDialectCapabilities(dialect);
  const open = caps.identifierQuote;
  const close = caps.identifierQuoteClose;
  return `${open}${name.split(close).join(close + close)}${close}`;
}

/**
 * A small placeholder allocator that emits the right bind-marker per dialect and
 * collects the values in order. `numbered` → $1,$2 (postgres); `question` → ?
 * (mysql/mariadb/sqlite); `named` → @p1,@p2 (mssql, matching the driver's
 * `request.input('p'+n, value)` convention).
 */
class ParamWriter {
  readonly params: unknown[] = [];
  constructor(private readonly dialect: SQLDialect) {}

  next(value: unknown): string {
    this.params.push(value);
    const style = getDialectCapabilities(this.dialect).paramPlaceholder;
    const n = this.params.length;
    if (style === 'numbered') return `$${n}`;
    if (style === 'named') return `@p${n}`;
    return '?';
  }
}

/** Fully-qualified, quoted `schema.table` reference (schema omitted on dialects
 * without schema support, where schema == database). */
function tableRef(schema: string, table: string, dialect: SQLDialect): string {
  const caps = getDialectCapabilities(dialect);
  const t = quoteIdent(table, dialect);
  return caps.supportsSchemas && schema ? `${quoteIdent(schema, dialect)}.${t}` : t;
}

/**
 * Turn a single `SQLEditChange` into a parameterized statement for `dialect`.
 *
 * - update: `UPDATE <ref> SET <col> = ? WHERE <pk...> = ?` — the WHERE clause is
 *   built from the PK columns ONLY (DataGrip-style optimistic concurrency). When
 *   the edited column IS a PK column, the ORIGINAL pk value (carried in `pk`) is
 *   used in WHERE and the new value is SET — so renaming a PK works.
 * - insert: `INSERT INTO <ref> (cols...) VALUES (?...)`. Empty `values` →
 *   `INSERT INTO <ref> DEFAULT VALUES` (every column server-defaulted).
 * - delete: `DELETE FROM <ref> WHERE <pk...> = ?`.
 */
export function buildEditStatement(change: SQLEditChange, dialect: SQLDialect): PreparedEdit {
  const ref = tableRef(change.schema, change.table, dialect);
  const pw = new ParamWriter(dialect);

  if (change.kind === 'update') {
    const setSql = `${quoteIdent(change.column, dialect)} = ${pw.next(change.value)}`;
    const where = buildPkWhere(change.pk, dialect, pw);
    return { sql: `UPDATE ${ref} SET ${setSql} WHERE ${where}`, params: pw.params };
  }

  if (change.kind === 'insert') {
    const cols = Object.keys(change.values);
    if (cols.length === 0) {
      // No explicit columns → let every column take its server default.
      return { sql: `INSERT INTO ${ref} DEFAULT VALUES`, params: [] };
    }
    const colSql = cols.map((c) => quoteIdent(c, dialect)).join(', ');
    const valSql = cols.map((c) => pw.next(change.values[c])).join(', ');
    return { sql: `INSERT INTO ${ref} (${colSql}) VALUES (${valSql})`, params: pw.params };
  }

  // delete
  const where = buildPkWhere(change.pk, dialect, pw);
  return { sql: `DELETE FROM ${ref} WHERE ${where}`, params: pw.params };
}

/** `col1 = ? AND col2 = ?` (NULL-safe: `col IS NULL` when the pk value is null). */
function buildPkWhere(pk: Record<string, unknown>, dialect: SQLDialect, pw: ParamWriter): string {
  const cols = Object.keys(pk);
  if (cols.length === 0) {
    // Refuse to build a WHERE-less UPDATE/DELETE — that would hit every row.
    throw new Error('Cannot apply edit: no primary-key columns to match the row.');
  }
  return cols
    .map((c) => {
      const v = pk[c];
      if (v === null || v === undefined) return `${quoteIdent(c, dialect)} IS NULL`;
      return `${quoteIdent(c, dialect)} = ${pw.next(v)}`;
    })
    .join(' AND ');
}

/** Build all statements for a batch of changes, preserving order. */
export function buildEditStatements(changes: SQLEditChange[], dialect: SQLDialect): PreparedEdit[] {
  return changes.map((c) => buildEditStatement(c, dialect));
}
