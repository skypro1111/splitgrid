// Pure, dependency-free serialization helpers shared between the main-process
// exporter (src/main/sql/export.ts) and the renderer's clipboard "Copy as"
// feature (DataGrid). No Node or DOM APIs here so both sides can import it.
//
// Covers RFC-4180 CSV quoting, a JSON row serializer, and per-dialect SQL value
// literals + INSERT statement building. Identifier quoting lives in
// shared/dialects-derived helpers (duplicated minimally here to avoid a circular
// import surface); value escaping is the security-sensitive part for the SQL
// *export* path (the *import* path always uses parameterized inserts instead).

import type { SQLDialect } from './types';
import { getDialectCapabilities } from './dialects';

/** Quote a SQL identifier for the given dialect (closing quote char doubled). */
export function quoteIdentFor(name: string, dialect: SQLDialect): string {
  const caps = getDialectCapabilities(dialect);
  const open = caps.identifierQuote;
  const close = caps.identifierQuoteClose;
  return `${open}${name.split(close).join(close + close)}${close}`;
}

/** Fully-qualified, dialect-quoted `schema.table` (schema dropped when the
 * dialect has no schema namespace or none was supplied). */
export function tableRefFor(schema: string | null | undefined, table: string, dialect: SQLDialect): string {
  const caps = getDialectCapabilities(dialect);
  const t = quoteIdentFor(table, dialect);
  return caps.supportsSchemas && schema ? `${quoteIdentFor(schema, dialect)}.${t}` : t;
}

/* ============================ CSV (RFC 4180) ============================ */

export interface CsvOptions {
  delimiter: string;       // usually ',' — also ';' / '\t' / '|'
  includeHeaders: boolean;
  /** Text written for a NULL/undefined cell (default ''). */
  nullText?: string;
}

/** Stringify any cell to its display text (objects → JSON; everything else String()). */
function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** RFC-4180 quote a single field: wrap in quotes and double embedded quotes when
 * the field contains the delimiter, a quote, CR or LF. Otherwise emit as-is. */
export function csvQuoteField(text: string, delimiter: string): string {
  const mustQuote =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r');
  if (!mustQuote) return text;
  return `"${text.split('"').join('""')}"`;
}

/** Serialize one row (in `columns` order) to a CSV line (no trailing newline). */
export function csvRow(
  columns: string[],
  row: Record<string, unknown>,
  opts: CsvOptions,
): string {
  return columns
    .map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return csvQuoteField(opts.nullText ?? '', opts.delimiter);
      return csvQuoteField(cellToText(v), opts.delimiter);
    })
    .join(opts.delimiter);
}

/** The CSV header line for the given columns. */
export function csvHeader(columns: string[], opts: CsvOptions): string {
  return columns.map((c) => csvQuoteField(c, opts.delimiter)).join(opts.delimiter);
}

/** Serialize a whole result set to a CSV string (CRLF line endings per RFC 4180). */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>, opts: CsvOptions): string {
  const lines: string[] = [];
  if (opts.includeHeaders) lines.push(csvHeader(columns, opts));
  for (const row of rows) lines.push(csvRow(columns, row, opts));
  return lines.join('\r\n');
}

/* ================================ JSON ================================= */

/** Serialize a result set to a pretty-printed JSON array of row objects. */
export function toJson(columns: string[], rows: Array<Record<string, unknown>>): string {
  const objects = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const c of columns) obj[c] = row[c] ?? null;
    return obj;
  });
  return JSON.stringify(objects, null, 2);
}

/* ============================ SQL literals ============================= */

/** Escape a string literal for the dialect (single quotes doubled; mysql also
 * needs backslash handling unless NO_BACKSLASH_ESCAPES — we double both quote and
 * backslash there to be safe). Used ONLY by the SQL *export* path, never import. */
export function sqlStringLiteral(text: string, dialect: SQLDialect): string {
  const quoted = text.split("'").join("''");
  if (dialect === 'mysql' || dialect === 'mariadb') {
    // Escape backslashes too (default MySQL mode treats \ as an escape char).
    return `'${quoted.split('\\').join('\\\\')}'`;
  }
  return `'${quoted}'`;
}

/** Render a single value as a SQL literal for the dialect. */
export function sqlValueLiteral(value: unknown, dialect: SQLDialect): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') {
    // SQLite/MSSQL have no native boolean literal — use 1/0; pg/mysql accept TRUE/FALSE.
    if (dialect === 'sqlite' || dialect === 'mssql') return value ? '1' : '0';
    return value ? 'TRUE' : 'FALSE';
  }
  if (value instanceof Date) return sqlStringLiteral(value.toISOString(), dialect);
  if (typeof value === 'object') return sqlStringLiteral(JSON.stringify(value), dialect);
  return sqlStringLiteral(String(value), dialect);
}

/** Build one `INSERT INTO <ref> (cols) VALUES (...);` statement. */
export function sqlInsertStatement(
  schema: string | null | undefined,
  table: string,
  columns: string[],
  row: Record<string, unknown>,
  dialect: SQLDialect,
): string {
  const ref = tableRefFor(schema, table, dialect);
  const colSql = columns.map((c) => quoteIdentFor(c, dialect)).join(', ');
  const valSql = columns.map((c) => sqlValueLiteral(row[c], dialect)).join(', ');
  return `INSERT INTO ${ref} (${colSql}) VALUES (${valSql});`;
}

/** Serialize a result set to a series of INSERT statements (newline-separated). */
export function toSqlInserts(
  schema: string | null | undefined,
  table: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
  dialect: SQLDialect,
): string {
  return rows.map((row) => sqlInsertStatement(schema, table, columns, row, dialect)).join('\n');
}

/* ============================ CSV parsing ============================= */

/** Detect the most likely delimiter from the first non-empty line by counting
 * candidate separators outside of quotes. Falls back to ','. */
export function detectCsvDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count += 1;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

/** Parse RFC-4180 CSV text into a matrix of string cells. Handles quoted fields,
 * embedded delimiters/newlines, and doubled quotes. Empty trailing line dropped. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === delimiter) { pushField(); i += 1; continue; }
    if (ch === '\r') {
      // swallow CRLF / lone CR as a record separator
      pushField(); pushRow();
      if (text[i + 1] === '\n') i += 2; else i += 1;
      continue;
    }
    if (ch === '\n') { pushField(); pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  // flush the last field/row if there's any pending content
  if (field.length > 0 || row.length > 0) { pushField(); pushRow(); }
  // Drop a trailing empty row produced by a final newline.
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

/* ================================ TSV ================================== */

/** Serialize a result set to TSV (tabs between cells, NULL → empty). Tabs and
 * newlines inside cells are replaced with spaces to keep the grid shape. */
export function toTsv(columns: string[], rows: Array<Record<string, unknown>>, includeHeaders: boolean): string {
  const clean = (t: string) => t.replace(/[\t\r\n]+/g, ' ');
  const lines: string[] = [];
  if (includeHeaders) lines.push(columns.map(clean).join('\t'));
  for (const row of rows) {
    lines.push(columns.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return '';
      return clean(cellToText(v));
    }).join('\t'));
  }
  return lines.join('\n');
}
