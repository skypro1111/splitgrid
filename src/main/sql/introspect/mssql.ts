import type { ConnectionPool } from 'mssql';
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

const SYSTEM_SCHEMAS = ['sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner', 'db_accessadmin'];

export async function listDatabases(pool: ConnectionPool, currentDatabase: string): Promise<SQLDatabaseInfo[]> {
  const result = await pool.request().query<{ name: string }>(
    `select name from sys.databases where database_id > 4 or name in ('master') order by name asc`
  );
  return result.recordset.map((row) => ({
    name: row.name,
    sizeBytes: 0,
    description: null,
    isCurrent: row.name === currentDatabase,
  }));
}

export async function listSchemas(pool: ConnectionPool): Promise<SQLSchemaTree[]> {
  const objectRows = (
    await pool.request().query<{ schema_name: string; name: string; type: string }>(
      `select s.name as schema_name, o.name as name, o.type as type
       from sys.objects o
       join sys.schemas s on s.schema_id = o.schema_id
       where o.type in ('U','V','P','FN','IF','TF','SO')
         and s.name not in ('sys','INFORMATION_SCHEMA')
       order by s.name asc, o.name asc`
    )
  ).recordset;

  type Bucket = {
    table: SQLSchemaObject[];
    view: SQLSchemaObject[];
    procedure: SQLSchemaObject[];
    function: SQLSchemaObject[];
    sequence: SQLSchemaObject[];
  };
  const schemaMap = new Map<string, Bucket>();
  const ensure = (schema: string): Bucket => {
    let b = schemaMap.get(schema);
    if (!b) {
      b = { table: [], view: [], procedure: [], function: [], sequence: [] };
      schemaMap.set(schema, b);
    }
    return b;
  };

  for (const r of objectRows) {
    const b = ensure(r.schema_name);
    const t = r.type.trim();
    const obj: SQLSchemaObject = { name: r.name };
    if (t === 'U') b.table.push(obj);
    else if (t === 'V') b.view.push(obj);
    else if (t === 'P') b.procedure.push(obj);
    else if (t === 'SO') b.sequence.push(obj);
    else b.function.push(obj); // FN/IF/TF
  }

  const categoriesFor = (schema: string): SQLSchemaCategory[] => {
    const b = ensure(schema);
    return [
      { id: 'tables', label: 'Tables', kind: 'table', objects: b.table },
      { id: 'views', label: 'Views', kind: 'view', objects: b.view },
      { id: 'procedures', label: 'Stored Procedures', kind: 'procedure', objects: b.procedure },
      { id: 'functions', label: 'Functions', kind: 'function', objects: b.function },
      { id: 'sequences', label: 'Sequences', kind: 'sequence', objects: b.sequence },
    ];
  };

  // Ensure dbo always exists as default node even when empty.
  if (!schemaMap.has('dbo')) ensure('dbo');

  return [...schemaMap.keys()].sort().map((schema) => ({
    schema,
    isDefault: schema === 'dbo',
    categories: categoriesFor(schema),
  }));
}

export async function listColumns(pool: ConnectionPool): Promise<SQLColumnInfo[]> {
  const result = await pool.request().query<{
    schema_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    ordinal_position: number;
    is_identity: number;
  }>(
    `select c.TABLE_SCHEMA as schema_name, c.TABLE_NAME as table_name, c.COLUMN_NAME as column_name,
            c.DATA_TYPE as data_type, c.IS_NULLABLE as is_nullable, c.COLUMN_DEFAULT as column_default,
            c.ORDINAL_POSITION as ordinal_position,
            columnproperty(object_id(quotename(c.TABLE_SCHEMA) + '.' + quotename(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') as is_identity
     from INFORMATION_SCHEMA.COLUMNS c
     where c.TABLE_SCHEMA not in ('sys','INFORMATION_SCHEMA')
     order by c.TABLE_SCHEMA asc, c.TABLE_NAME asc, c.ORDINAL_POSITION asc`
  );
  return result.recordset.map((row) => ({
    schema: row.schema_name,
    table: row.table_name,
    column: row.column_name,
    dataType: row.data_type,
    isNullable: row.is_nullable === 'YES',
    isAutoIncrement: row.is_identity === 1,
    defaultValue: row.column_default,
    ordinal: row.ordinal_position,
  }));
}

export async function getPrimaryKey(pool: ConnectionPool, schema: string, table: string): Promise<string[]> {
  const result = await pool
    .request()
    .input('schema', schema)
    .input('table', table)
    .query<{ column_name: string }>(
      `select kcu.COLUMN_NAME as column_name
       from INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       join INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         on kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME and kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
       where tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
         and tc.TABLE_SCHEMA = @schema and tc.TABLE_NAME = @table
       order by kcu.ORDINAL_POSITION asc`
    );
  return result.recordset.map((r) => r.column_name);
}

export async function listIndexes(pool: ConnectionPool, schema: string, table: string): Promise<SQLIndexInfo[]> {
  try {
    const result = await pool
      .request()
      .input('schema', schema)
      .input('table', table)
      .query<{ name: string; is_unique: boolean; is_primary_key: boolean; type_desc: string; columns: string }>(
        `select i.name as name, i.is_unique as is_unique, i.is_primary_key as is_primary_key,
                i.type_desc as type_desc,
                stuff((select ',' + c.name
                       from sys.index_columns ic2
                       join sys.columns c on c.object_id = ic2.object_id and c.column_id = ic2.column_id
                       where ic2.object_id = i.object_id and ic2.index_id = i.index_id and ic2.is_included_column = 0
                       order by ic2.key_ordinal
                       for xml path('')), 1, 1, '') as columns
         from sys.indexes i
         join sys.objects o on o.object_id = i.object_id
         join sys.schemas s on s.schema_id = o.schema_id
         where s.name = @schema and o.name = @table and i.name is not null
         order by i.is_primary_key desc, i.name asc`
      );
    return result.recordset.map((r) => ({
      name: r.name,
      columns: r.columns ? r.columns.split(',') : [],
      isUnique: !!r.is_unique,
      isPrimary: !!r.is_primary_key,
      method: r.type_desc,
    }));
  } catch {
    return [];
  }
}

export async function listKeys(pool: ConnectionPool, schema: string, table: string): Promise<SQLKeyInfo[]> {
  const keys: SQLKeyInfo[] = [];
  try {
    // Primary & unique constraints.
    const tc = await pool
      .request()
      .input('schema', schema)
      .input('table', table)
      .query<{ name: string; type: string; column_name: string }>(
        `select tc.CONSTRAINT_NAME as name, tc.CONSTRAINT_TYPE as type, kcu.COLUMN_NAME as column_name
         from INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         join INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           on kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME and kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
         where tc.TABLE_SCHEMA = @schema and tc.TABLE_NAME = @table
           and tc.CONSTRAINT_TYPE in ('PRIMARY KEY','UNIQUE')
         order by tc.CONSTRAINT_NAME asc, kcu.ORDINAL_POSITION asc`
      );
    const byName = new Map<string, SQLKeyInfo>();
    for (const r of tc.recordset) {
      let k = byName.get(r.name);
      if (!k) {
        k = { name: r.name, type: r.type === 'PRIMARY KEY' ? 'primary' : 'unique', columns: [] };
        byName.set(r.name, k);
      }
      k.columns.push(r.column_name);
    }
    keys.push(...byName.values());
    // Foreign keys.
    const fk = await pool
      .request()
      .input('schema', schema)
      .input('table', table)
      .query<{ name: string; column_name: string; ref_schema: string; ref_table: string; ref_column: string }>(
        `select fk.name as name, pc.name as column_name,
                rs.name as ref_schema, ro.name as ref_table, rc.name as ref_column
         from sys.foreign_keys fk
         join sys.foreign_key_columns fkc on fkc.constraint_object_id = fk.object_id
         join sys.objects o on o.object_id = fk.parent_object_id
         join sys.schemas s on s.schema_id = o.schema_id
         join sys.columns pc on pc.object_id = fkc.parent_object_id and pc.column_id = fkc.parent_column_id
         join sys.objects ro on ro.object_id = fk.referenced_object_id
         join sys.schemas rs on rs.schema_id = ro.schema_id
         join sys.columns rc on rc.object_id = fkc.referenced_object_id and rc.column_id = fkc.referenced_column_id
         where s.name = @schema and o.name = @table
         order by fk.name asc, fkc.constraint_column_id asc`
      );
    const fkByName = new Map<string, SQLKeyInfo>();
    for (const r of fk.recordset) {
      let k = fkByName.get(r.name);
      if (!k) {
        k = { name: r.name, type: 'foreign', columns: [], referencedTable: `${r.ref_schema}.${r.ref_table}`, referencedColumns: [] };
        fkByName.set(r.name, k);
      }
      k.columns.push(r.column_name);
      k.referencedColumns!.push(r.ref_column);
    }
    keys.push(...fkByName.values());
  } catch {
    return keys;
  }
  return keys;
}

export async function listTriggers(pool: ConnectionPool, schema: string, table?: string): Promise<SQLTriggerInfo[]> {
  try {
    const req = pool.request().input('schema', schema);
    let filter = '';
    if (table) { req.input('table', table); filter = ' and o.name = @table'; }
    const result = await req.query<{ name: string; table_name: string; is_instead_of: boolean }>(
      `select tr.name as name, o.name as table_name, tr.is_instead_of_trigger as is_instead_of
       from sys.triggers tr
       join sys.objects o on o.object_id = tr.parent_id
       join sys.schemas s on s.schema_id = o.schema_id
       where s.name = @schema${filter}
       order by o.name asc, tr.name asc`
    );
    return result.recordset.map((r) => ({
      name: r.name,
      table: r.table_name,
      timing: r.is_instead_of ? 'INSTEAD OF' : 'AFTER',
    }));
  } catch {
    return [];
  }
}

export async function getModuleDefinition(pool: ConnectionPool, schema: string, name: string): Promise<string> {
  const result = await pool
    .request()
    .input('schema', schema)
    .input('name', name)
    .query<{ definition: string | null }>(
      `select m.definition
       from sys.sql_modules m
       join sys.objects o on o.object_id = m.object_id
       join sys.schemas s on s.schema_id = o.schema_id
       where s.name = @schema and o.name = @name`
    );
  return result.recordset[0]?.definition ?? '';
}

export { SYSTEM_SCHEMAS };
