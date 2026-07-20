import type { Connection } from 'mysql2/promise';
import type {
  SQLColumnInfo,
  SQLDatabaseInfo,
  SQLSchemaCategory,
  SQLSchemaObject,
  SQLSchemaTree,
  SQLIndexInfo,
  SQLKeyInfo,
  SQLTriggerInfo,
} from '../../../shared/types';

const SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys'];

async function rows<T>(conn: Connection, sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await conn.query(sql, params);
  return result as T[];
}

export async function listDatabases(conn: Connection, currentDatabase: string): Promise<SQLDatabaseInfo[]> {
  const data = await rows<{ name: string; size_bytes: string | number | null }>(
    conn,
    `select s.SCHEMA_NAME as name,
            coalesce((select sum(t.DATA_LENGTH + t.INDEX_LENGTH)
                      from information_schema.TABLES t
                      where t.TABLE_SCHEMA = s.SCHEMA_NAME), 0) as size_bytes
     from information_schema.SCHEMATA s
     order by s.SCHEMA_NAME asc`
  );
  return data.map((row) => ({
    name: row.name,
    sizeBytes: Number(row.size_bytes) || 0,
    description: null,
    isCurrent: row.name === currentDatabase,
  }));
}

/** MySQL has no schemas; the connection's database becomes the single synthetic schema node. */
export async function listSchemas(conn: Connection, database: string, supportsSequences: boolean): Promise<SQLSchemaTree[]> {
  const tableRows = await rows<{ name: string; type: string; rows: number | null; bytes: number | null }>(
    conn,
    `select TABLE_NAME as name, TABLE_TYPE as type, TABLE_ROWS as \`rows\`,
            (coalesce(DATA_LENGTH,0) + coalesce(INDEX_LENGTH,0)) as bytes
     from information_schema.TABLES
     where TABLE_SCHEMA = ?
     order by TABLE_NAME asc`,
    [database]
  );

  const routineRows = await rows<{ name: string; type: string }>(
    conn,
    `select ROUTINE_NAME as name, ROUTINE_TYPE as type
     from information_schema.ROUTINES
     where ROUTINE_SCHEMA = ?
     order by ROUTINE_NAME asc`,
    [database]
  );

  const table: SQLSchemaObject[] = [];
  const view: SQLSchemaObject[] = [];
  for (const r of tableRows) {
    const object: SQLSchemaObject = {
      name: r.name,
      rowEstimate: typeof r.rows === 'number' ? r.rows : undefined,
      totalBytes: typeof r.bytes === 'number' ? r.bytes : undefined,
    };
    if (r.type === 'VIEW') view.push({ name: r.name });
    else table.push(object);
  }

  const func: SQLSchemaObject[] = [];
  const proc: SQLSchemaObject[] = [];
  for (const r of routineRows) {
    if (r.type === 'PROCEDURE') proc.push({ name: r.name });
    else func.push({ name: r.name });
  }

  const categories: SQLSchemaCategory[] = [
    { id: 'tables', label: 'Tables', kind: 'table', objects: table },
    { id: 'views', label: 'Views', kind: 'view', objects: view },
    { id: 'procedures', label: 'Stored Procedures', kind: 'procedure', objects: proc },
    { id: 'functions', label: 'Functions', kind: 'function', objects: func },
  ];
  if (supportsSequences) categories.push({ id: 'sequences', label: 'Sequences', kind: 'sequence', objects: [] });

  return [{ schema: database, isDefault: true, categories }];
}

export async function listColumns(conn: Connection, database: string): Promise<SQLColumnInfo[]> {
  const data = await rows<{
    schema_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    extra: string;
    ordinal_position: number;
    column_key: string;
  }>(
    conn,
    `select TABLE_SCHEMA as schema_name, TABLE_NAME as table_name, COLUMN_NAME as column_name,
            COLUMN_TYPE as data_type, IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default,
            EXTRA as extra, ORDINAL_POSITION as ordinal_position, COLUMN_KEY as column_key
     from information_schema.COLUMNS
     where TABLE_SCHEMA = ?
     order by TABLE_NAME asc, ORDINAL_POSITION asc`,
    [database]
  );
  return data.map((row) => ({
    schema: row.schema_name,
    table: row.table_name,
    column: row.column_name,
    dataType: row.data_type,
    isNullable: row.is_nullable === 'YES',
    isPrimaryKey: row.column_key === 'PRI',
    isAutoIncrement: row.extra.includes('auto_increment'),
    defaultValue: row.column_default,
    ordinal: row.ordinal_position,
  }));
}

export async function listIndexes(conn: Connection, database: string, table: string): Promise<SQLIndexInfo[]> {
  const data = await rows<{
    index_name: string;
    non_unique: number | string;
    index_type: string;
    column_name: string;
    seq_in_index: number;
  }>(
    conn,
    `select INDEX_NAME as index_name, NON_UNIQUE as non_unique, INDEX_TYPE as index_type,
            COLUMN_NAME as column_name, SEQ_IN_INDEX as seq_in_index
     from information_schema.STATISTICS
     where TABLE_SCHEMA = ? and TABLE_NAME = ?
     order by INDEX_NAME asc, SEQ_IN_INDEX asc`,
    [database, table]
  );
  const byName = new Map<string, SQLIndexInfo>();
  for (const r of data) {
    let idx = byName.get(r.index_name);
    if (!idx) {
      idx = {
        name: r.index_name,
        columns: [],
        isUnique: Number(r.non_unique) === 0,
        isPrimary: r.index_name === 'PRIMARY',
        method: r.index_type,
      };
      byName.set(r.index_name, idx);
    }
    idx.columns.push(r.column_name);
  }
  return [...byName.values()];
}

export async function listKeys(conn: Connection, database: string, table: string): Promise<SQLKeyInfo[]> {
  const constraints = await rows<{ name: string; type: string }>(
    conn,
    `select CONSTRAINT_NAME as name, CONSTRAINT_TYPE as type
     from information_schema.TABLE_CONSTRAINTS
     where TABLE_SCHEMA = ? and TABLE_NAME = ?`,
    [database, table]
  );
  const usage = await rows<{
    constraint_name: string;
    column_name: string;
    ordinal_position: number;
    referenced_table_name: string | null;
    referenced_column_name: string | null;
  }>(
    conn,
    `select CONSTRAINT_NAME as constraint_name, COLUMN_NAME as column_name,
            ORDINAL_POSITION as ordinal_position,
            REFERENCED_TABLE_NAME as referenced_table_name,
            REFERENCED_COLUMN_NAME as referenced_column_name
     from information_schema.KEY_COLUMN_USAGE
     where TABLE_SCHEMA = ? and TABLE_NAME = ?
     order by CONSTRAINT_NAME asc, ORDINAL_POSITION asc`,
    [database, table]
  );
  const typeOf = (t: string): SQLKeyInfo['type'] => {
    if (t === 'PRIMARY KEY') return 'primary';
    if (t === 'FOREIGN KEY') return 'foreign';
    if (t === 'UNIQUE') return 'unique';
    return 'check';
  };
  return constraints.map((c) => {
    const cols = usage.filter((u) => u.constraint_name === c.name);
    const refTable = cols.find((u) => u.referenced_table_name)?.referenced_table_name ?? undefined;
    const refCols = cols.map((u) => u.referenced_column_name).filter((x): x is string => !!x);
    return {
      name: c.name,
      type: typeOf(c.type),
      columns: cols.map((u) => u.column_name),
      referencedTable: refTable,
      referencedColumns: refCols.length ? refCols : undefined,
    };
  });
}

export async function listTriggers(conn: Connection, database: string, table?: string): Promise<SQLTriggerInfo[]> {
  const params: unknown[] = [database];
  let filter = '';
  if (table) { params.push(table); filter = ' and EVENT_OBJECT_TABLE = ?'; }
  const data = await rows<{
    name: string;
    timing: string;
    event: string;
    table_name: string;
  }>(
    conn,
    `select TRIGGER_NAME as name, ACTION_TIMING as timing,
            EVENT_MANIPULATION as event, EVENT_OBJECT_TABLE as table_name
     from information_schema.TRIGGERS
     where TRIGGER_SCHEMA = ?${filter}
     order by EVENT_OBJECT_TABLE asc, TRIGGER_NAME asc`,
    params
  );
  return data.map((r) => ({
    name: r.name,
    timing: r.timing === 'BEFORE' || r.timing === 'AFTER' ? r.timing : undefined,
    event: r.event,
    table: r.table_name,
  }));
}

export async function getPrimaryKey(conn: Connection, database: string, table: string): Promise<string[]> {
  const data = await rows<{ column_name: string }>(
    conn,
    `select COLUMN_NAME as column_name
     from information_schema.KEY_COLUMN_USAGE
     where TABLE_SCHEMA = ? and TABLE_NAME = ? and CONSTRAINT_NAME = 'PRIMARY'
     order by ORDINAL_POSITION asc`,
    [database, table]
  );
  return data.map((r) => r.column_name);
}

export { SYSTEM_SCHEMAS };
