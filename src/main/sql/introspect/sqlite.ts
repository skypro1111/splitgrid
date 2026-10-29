import type Database from 'better-sqlite3';
import type {
  SQLColumnInfo,
  SQLSchemaCategory,
  SQLSchemaObject,
  SQLSchemaTree,
  SQLIndexInfo,
  SQLKeyInfo,
  SQLTriggerInfo,
} from '../../../shared/types';

const SCHEMA = 'main';

export function listSchemas(db: Database.Database): SQLSchemaTree[] {
  const objects = db
    .prepare(`select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name asc`)
    .all() as Array<{ name: string; type: string }>;

  // Row estimates come from sqlite_stat1 (written by ANALYZE) when it exists. A
  // count(*) per table is a full scan, and better-sqlite3 runs on the main
  // process thread — on a large file every refresh froze every terminal.
  const estimates = new Map<string, number>();
  try {
    const stats = db.prepare(`select tbl, stat from sqlite_stat1`).all() as Array<{ tbl: string; stat: string }>;
    for (const r of stats) {
      const n = parseInt(r.stat, 10);
      if (Number.isFinite(n)) estimates.set(r.tbl, Math.max(estimates.get(r.tbl) ?? 0, n));
    }
  } catch {
    /* never analyzed — no estimates */
  }

  const table: SQLSchemaObject[] = [];
  const view: SQLSchemaObject[] = [];
  for (const o of objects) {
    if (o.type === 'view') view.push({ name: o.name });
    else table.push({ name: o.name, rowEstimate: estimates.get(o.name) });
  }

  const categories: SQLSchemaCategory[] = [
    { id: 'tables', label: 'Tables', kind: 'table', objects: table },
    { id: 'views', label: 'Views', kind: 'view', objects: view },
  ];

  return [{ schema: SCHEMA, isDefault: true, categories }];
}

export function listColumns(db: Database.Database): SQLColumnInfo[] {
  const tables = db
    .prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name asc`)
    .all() as Array<{ name: string }>;

  const out: SQLColumnInfo[] = [];
  for (const t of tables) {
    const cols = db.prepare(`select * from pragma_table_info(?)`).all(t.name) as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    for (const c of cols) {
      out.push({
        schema: SCHEMA,
        table: t.name,
        column: c.name,
        dataType: c.type || undefined,
        isNullable: c.notnull === 0,
        isPrimaryKey: c.pk > 0,
        defaultValue: c.dflt_value,
        ordinal: c.cid + 1,
      });
    }
  }
  return out;
}

// Pragmas go through their table-valued forms so names are bound, not spliced
// into `"..."` — a table name containing a quote broke every listing.
export function getPrimaryKey(db: Database.Database, table: string): string[] {
  const cols = db.prepare(`select * from pragma_table_info(?)`).all(table) as Array<{ name: string; pk: number }>;
  return cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

export function listIndexes(db: Database.Database, table: string): SQLIndexInfo[] {
  try {
    const list = db.prepare(`select * from pragma_index_list(?)`).all(table) as Array<{
      seq: number; name: string; unique: number; origin: string; partial: number;
    }>;
    return list.map((ix) => {
      const cols = db.prepare(`select * from pragma_index_info(?)`).all(ix.name) as Array<{ seqno: number; cid: number; name: string }>;
      return {
        name: ix.name,
        columns: cols.map((c) => c.name),
        isUnique: ix.unique === 1,
        isPrimary: ix.origin === 'pk',
      };
    });
  } catch {
    return [];
  }
}

export function listKeys(db: Database.Database, table: string): SQLKeyInfo[] {
  const keys: SQLKeyInfo[] = [];
  // Primary key from table_info.
  try {
    const pkCols = (db.prepare(`select * from pragma_table_info(?)`).all(table) as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    if (pkCols.length) keys.push({ name: 'PRIMARY', type: 'primary', columns: pkCols });
  } catch { /* best effort */ }
  // Foreign keys from foreign_key_list.
  try {
    const fks = db.prepare(`select * from pragma_foreign_key_list(?)`).all(table) as Array<{
      id: number; seq: number; table: string; from: string; to: string;
    }>;
    const byId = new Map<number, SQLKeyInfo>();
    for (const fk of fks) {
      let k = byId.get(fk.id);
      if (!k) {
        k = { name: `fk_${table}_${fk.id}`, type: 'foreign', columns: [], referencedTable: fk.table, referencedColumns: [] };
        byId.set(fk.id, k);
      }
      k.columns.push(fk.from);
      k.referencedColumns!.push(fk.to);
    }
    keys.push(...byId.values());
  } catch { /* best effort */ }
  // Unique indexes (origin 'u') become unique keys.
  for (const ix of listIndexes(db, table)) {
    if (ix.isUnique && !ix.isPrimary) keys.push({ name: ix.name, type: 'unique', columns: ix.columns });
  }
  return keys;
}

export function listTriggers(db: Database.Database, table?: string): SQLTriggerInfo[] {
  try {
    const sql = table
      ? `select name, tbl_name from sqlite_master where type = 'trigger' and tbl_name = ? order by name asc`
      : `select name, tbl_name from sqlite_master where type = 'trigger' order by name asc`;
    const stmt = db.prepare(sql);
    const recs = (table ? stmt.all(table) : stmt.all()) as Array<{ name: string; tbl_name: string }>;
    return recs.map((r) => ({ name: r.name, table: r.tbl_name }));
  } catch {
    return [];
  }
}

export function getDDL(db: Database.Database, name: string): string {
  const r = db.prepare(`select sql from sqlite_master where name = ?`).get(name) as { sql: string } | undefined;
  return r?.sql ?? '';
}

export { SCHEMA };
