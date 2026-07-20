import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type {
  SQLDialect,
  SQLExportOptions,
  SQLExportResult,
  SQLQueryResult,
} from '../../shared/types';
import {
  csvHeader,
  csvRow,
  sqlInsertStatement,
  tableRefFor,
  quoteIdentFor,
  type CsvOptions,
} from '../../shared/sql-serialize';
import { getDialectCapabilities } from '../../shared/dialects';

/** Page size for full-table streaming. The driver caps each result at 1000 rows
 * (MAX_RESULT_ROWS); we fetch one page at a time below that cap so `truncated`
 * never trips, then page with LIMIT/OFFSET until a short page ends the stream. */
const EXPORT_PAGE_SIZE = 1000;

/** What the exporter needs from the registry: a parameterized execute + the
 * session dialect. Passing this in keeps export.ts decoupled from the registry. */
export interface ExportDeps {
  execute: (id: string, sql: string, params?: unknown[]) => Promise<SQLQueryResult>;
  getDialect: (id: string) => SQLDialect;
}

/** A consumer that receives the column list once, then each page of rows. */
interface RowSink {
  begin(columns: string[]): void | Promise<void>;
  write(rows: Array<Record<string, unknown>>): void | Promise<void>;
  end(): void | Promise<void>;
}

/* ----------------------------- full-table paging ----------------------------- */

/** Build `SELECT * FROM <ref> LIMIT n OFFSET m` for the dialect (MSSQL needs the
 * OFFSET/FETCH form, which also requires an ORDER BY — order by the first column). */
function buildPageSql(
  dialect: SQLDialect,
  schema: string,
  table: string,
  limit: number,
  offset: number,
  orderCol: string | null,
): string {
  const ref = tableRefFor(schema, table, dialect);
  if (dialect === 'mssql') {
    const order = orderCol ? quoteIdentFor(orderCol, dialect) : '(SELECT NULL)';
    return `SELECT * FROM ${ref} ORDER BY ${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  return `SELECT * FROM ${ref} LIMIT ${limit} OFFSET ${offset}`;
}

/** Stream every row of a table to the sink, paging past the per-query cap.
 * Returns the total row count written. */
async function streamTable(
  deps: ExportDeps,
  connectionId: string,
  schema: string,
  table: string,
  sink: RowSink,
): Promise<number> {
  const dialect = deps.getDialect(connectionId);
  let offset = 0;
  let total = 0;
  let columns: string[] | null = null;
  let orderCol: string | null = null;

  // Probe one row first to learn the column list (and a stable ORDER BY col for MSSQL).
  for (;;) {
    const sql = buildPageSql(dialect, schema, table, EXPORT_PAGE_SIZE, offset, orderCol);
    const page = await deps.execute(connectionId, sql, []);
    if (columns === null) {
      columns = page.columns;
      orderCol = page.columns[0] ?? null;
      await sink.begin(columns);
      // MSSQL needed orderCol for the very first page too — if we guessed wrong
      // (no columns), re-run is unnecessary because empty table → no rows.
    }
    if (page.rows.length > 0) {
      await sink.write(page.rows);
      total += page.rows.length;
    }
    // A short page (fewer than the page size) means we reached the end.
    if (page.rows.length < EXPORT_PAGE_SIZE) break;
    offset += EXPORT_PAGE_SIZE;
  }
  if (columns === null) await sink.begin([]);
  await sink.end();
  return total;
}

/* ------------------------------- format sinks -------------------------------- */

function csvOptionsFrom(options: SQLExportOptions): CsvOptions {
  return {
    delimiter: options.delimiter && options.delimiter.length ? options.delimiter : ',',
    includeHeaders: options.includeHeaders !== false,
    nullText: options.nullText ?? '',
  };
}

/** Incremental CSV writer (RFC-4180 lines, CRLF). */
function makeCsvSink(filePath: string, options: SQLExportOptions): RowSink {
  const stream = createWriteStream(filePath, { encoding: 'utf-8' });
  const csvOpts = csvOptionsFrom(options);
  let cols: string[] = [];
  let wroteAny = false;
  const writeLine = (line: string) => {
    stream.write(wroteAny ? `\r\n${line}` : line);
    wroteAny = true;
  };
  return {
    begin(columns) {
      cols = columns;
      if (csvOpts.includeHeaders) writeLine(csvHeader(cols, csvOpts));
    },
    write(rows) {
      for (const row of rows) writeLine(csvRow(cols, row, csvOpts));
    },
    end() {
      return new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Incremental JSON-array writer (pretty-ish: one object per line). */
function makeJsonSink(filePath: string): RowSink {
  const stream = createWriteStream(filePath, { encoding: 'utf-8' });
  let cols: string[] = [];
  let wroteAny = false;
  return {
    begin(columns) {
      cols = columns;
      stream.write('[');
    },
    write(rows) {
      for (const row of rows) {
        const obj: Record<string, unknown> = {};
        for (const c of cols) obj[c] = row[c] ?? null;
        stream.write(`${wroteAny ? ',' : ''}\n  ${JSON.stringify(obj)}`);
        wroteAny = true;
      }
    },
    end() {
      stream.write(wroteAny ? '\n]\n' : ']\n');
      return new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Incremental SQL-INSERT writer. */
function makeSqlSink(filePath: string, options: SQLExportOptions, dialect: SQLDialect): RowSink {
  const stream = createWriteStream(filePath, { encoding: 'utf-8' });
  const schema = options.table?.schema ?? null;
  const tableName = options.sqlTableName?.trim() || options.table?.name || 'exported_data';
  let cols: string[] = [];
  return {
    begin(columns) { cols = columns; },
    write(rows) {
      for (const row of rows) {
        stream.write(`${sqlInsertStatement(schema, tableName, cols, row, dialect)}\n`);
      }
    },
    end() {
      return new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Streaming XLSX writer (exceljs WorkbookWriter — keeps memory bounded for big
 * tables; rows are committed as they're appended). Header row styled bold. */
function makeXlsxSink(filePath: string): RowSink {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true });
  const sheet = workbook.addWorksheet('Export');
  let cols: string[] = [];
  return {
    begin(columns) {
      cols = columns;
      if (cols.length) {
        const header = sheet.addRow(cols);
        header.font = { bold: true };
        header.commit();
      }
    },
    write(rows) {
      for (const row of rows) {
        const values = cols.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return null;
          if (typeof v === 'object') return JSON.stringify(v);
          return v as ExcelJS.CellValue;
        });
        sheet.addRow(values).commit();
      }
    },
    async end() {
      sheet.commit();
      await workbook.commit();
    },
  };
}

function makeSink(filePath: string, options: SQLExportOptions, dialect: SQLDialect): RowSink {
  switch (options.format) {
    case 'csv': return makeCsvSink(filePath, options);
    case 'json': return makeJsonSink(filePath);
    case 'sql': return makeSqlSink(filePath, options, dialect);
    case 'xlsx': return makeXlsxSink(filePath);
    default: throw new Error(`Unsupported export format: ${options.format}`);
  }
}

/* --------------------------------- entrypoint -------------------------------- */

/**
 * Export to `options.filePath`. For `scope: 'current'` we serialize the inline
 * rows the renderer already holds (the loaded page). For `scope: 'full'` we
 * stream the whole table from the DB, paging past the 1000-row driver cap.
 */
export async function exportData(
  deps: ExportDeps,
  connectionId: string | null,
  options: SQLExportOptions,
): Promise<SQLExportResult> {
  if (!options.filePath) throw new Error('No output file path provided.');

  // Resolve dialect for SQL/identifier quoting. Falls back to postgres when there
  // is no live connection (current-view export of a disconnected snapshot).
  const dialect: SQLDialect = options.dialect
    ?? (connectionId ? deps.getDialect(connectionId) : 'postgres');

  if (options.scope === 'full') {
    if (!connectionId) throw new Error('A live connection is required for a full-table export.');
    if (!options.table) throw new Error('No source table specified for a full-table export.');
    const sink = makeSink(options.filePath, options, dialect);
    const rowCount = await streamTable(deps, connectionId, options.table.schema, options.table.name, sink);
    return { ok: true, filePath: options.filePath, rowCount };
  }

  // current-view scope: serialize the inline rows.
  const columns = options.columns ?? [];
  const rows = options.rows ?? [];

  if (options.format === 'xlsx') {
    // Use the same streaming sink for consistency.
    const sink = makeXlsxSink(options.filePath);
    await sink.begin(columns);
    await sink.write(rows);
    await sink.end();
    return { ok: true, filePath: options.filePath, rowCount: rows.length };
  }

  // For small in-memory exports a single buffered write is simplest.
  const text = serializeInMemory(columns, rows, options, dialect);
  await writeFile(options.filePath, text, 'utf-8');
  return { ok: true, filePath: options.filePath, rowCount: rows.length };
}

function serializeInMemory(
  columns: string[],
  rows: Array<Record<string, unknown>>,
  options: SQLExportOptions,
  dialect: SQLDialect,
): string {
  if (options.format === 'csv') {
    const opts = csvOptionsFrom(options);
    const lines: string[] = [];
    if (opts.includeHeaders) lines.push(csvHeader(columns, opts));
    for (const row of rows) lines.push(csvRow(columns, row, opts));
    return lines.join('\r\n') + '\r\n';
  }
  if (options.format === 'json') {
    const objects = rows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (const c of columns) obj[c] = row[c] ?? null;
      return obj;
    });
    return JSON.stringify(objects, null, 2) + '\n';
  }
  if (options.format === 'sql') {
    const schema = options.table?.schema ?? null;
    const tableName = options.sqlTableName?.trim() || options.table?.name || 'exported_data';
    return rows.map((row) => sqlInsertStatement(schema, tableName, columns, row, dialect)).join('\n') + '\n';
  }
  throw new Error(`Unsupported export format: ${options.format}`);
}

/** Default extension for a format (used by the Save dialog filter). */
export function extensionFor(format: SQLExportOptions['format']): string {
  switch (format) {
    case 'csv': return 'csv';
    case 'json': return 'json';
    case 'sql': return 'sql';
    case 'xlsx': return 'xlsx';
    default: return 'txt';
  }
}

/** Re-export so callers can validate without pulling dialects directly. */
export { getDialectCapabilities };
