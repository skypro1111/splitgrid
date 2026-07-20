import type { Client } from 'pg';
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

export async function listDatabases(client: Client, currentDatabase: string): Promise<SQLDatabaseInfo[]> {
  const result = await client.query<{ datname: string; size_bytes: string; description: string | null }>(
    `select
       d.datname,
       pg_database_size(d.datname)::text as size_bytes,
       pg_catalog.shobj_description(d.oid, 'pg_database') as description
     from pg_database d
     where d.datistemplate = false
     order by d.datname asc`
  );
  return result.rows.map((row) => ({
    name: row.datname,
    sizeBytes: parseInt(row.size_bytes, 10) || 0,
    description: row.description,
    isCurrent: row.datname === currentDatabase,
  }));
}

export async function listSchemas(client: Client): Promise<SQLSchemaTree[]> {
  const schemaRows = await client.query<{ schema_name: string }>(
    `select schema_name
     from information_schema.schemata
     order by
       case when schema_name = 'public' then 0 else 1 end,
       schema_name asc`
  );

  const relationRows = await client.query<{
    schema_name: string;
    name: string;
    kind: string;
    row_estimate: number | null;
    total_bytes: number | null;
  }>(
    `select
       n.nspname as schema_name,
       c.relname as name,
       c.relkind as kind,
       case when c.relkind in ('r', 'f', 'm') then c.reltuples::bigint else null end as row_estimate,
       case when c.relkind in ('r', 'f', 'm') then pg_total_relation_size(c.oid) else null end as total_bytes
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'v', 'm', 'f', 'S')
     order by n.nspname asc, c.relname asc`
  );

  const routineRows = await client.query<{ schema_name: string; name: string; kind: 'f' | 'p' }>(
    `select
       n.nspname as schema_name,
       p.proname as name,
       p.prokind as kind
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where p.prokind in ('f', 'p')
     order by n.nspname asc, p.proname asc`
  );

  const typeRows = await client.query<{ schema_name: string; name: string }>(
    `select
       n.nspname as schema_name,
       t.typname as name
     from pg_type t
     join pg_namespace n on n.oid = t.typnamespace
     where t.typtype in ('c', 'd', 'e', 'r', 'm')
       and t.typcategory <> 'A'
     order by n.nspname asc, t.typname asc`
  );

  type Bucket = {
    table: SQLSchemaObject[];
    view: SQLSchemaObject[];
    materializedView: SQLSchemaObject[];
    foreignTable: SQLSchemaObject[];
    sequence: SQLSchemaObject[];
    function: SQLSchemaObject[];
    procedure: SQLSchemaObject[];
    type: SQLSchemaObject[];
  };
  const schemaMap = new Map<string, Bucket>();

  const ensureSchema = (schema: string): Bucket => {
    let bucket = schemaMap.get(schema);
    if (!bucket) {
      bucket = { table: [], view: [], materializedView: [], foreignTable: [], sequence: [], function: [], procedure: [], type: [] };
      schemaMap.set(schema, bucket);
    }
    return bucket;
  };

  for (const row of relationRows.rows) {
    const bucket = ensureSchema(row.schema_name);
    const object: SQLSchemaObject = {
      name: row.name,
      rowEstimate: typeof row.row_estimate === 'number' ? row.row_estimate : undefined,
      totalBytes: typeof row.total_bytes === 'number' ? row.total_bytes : undefined,
    };
    if (row.kind === 'r') bucket.table.push(object);
    else if (row.kind === 'v') bucket.view.push(object);
    else if (row.kind === 'm') bucket.materializedView.push(object);
    else if (row.kind === 'f') bucket.foreignTable.push(object);
    else if (row.kind === 'S') bucket.sequence.push(object);
  }

  for (const row of routineRows.rows) {
    const bucket = ensureSchema(row.schema_name);
    const object: SQLSchemaObject = { name: row.name };
    if (row.kind === 'f') bucket.function.push(object);
    else bucket.procedure.push(object);
  }

  for (const row of typeRows.rows) {
    ensureSchema(row.schema_name).type.push({ name: row.name });
  }

  const categoriesFor = (schema: string): SQLSchemaCategory[] => {
    const bucket = ensureSchema(schema);
    return [
      { id: 'tables', label: 'Tables', kind: 'table', objects: bucket.table },
      { id: 'views', label: 'Views', kind: 'view', objects: bucket.view },
      { id: 'materializedViews', label: 'Materialized Views', kind: 'materializedView', objects: bucket.materializedView },
      { id: 'externalTables', label: 'External Tables', kind: 'foreignTable', objects: bucket.foreignTable },
      { id: 'procedures', label: 'Stored Procedures', kind: 'procedure', objects: bucket.procedure },
      { id: 'functions', label: 'Functions', kind: 'function', objects: bucket.function },
      { id: 'sequences', label: 'Sequences', kind: 'sequence', objects: bucket.sequence },
      { id: 'types', label: 'Types', kind: 'type', objects: bucket.type },
    ];
  };

  return schemaRows.rows.map((row) => ({
    schema: row.schema_name,
    isDefault: row.schema_name === 'public',
    categories: categoriesFor(row.schema_name),
  }));
}

export async function listColumns(client: Client): Promise<SQLColumnInfo[]> {
  const result = await client.query<{
    schema_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    ordinal_position: number;
  }>(
    `select
       c.table_schema as schema_name,
       c.table_name,
       c.column_name,
       c.data_type,
       c.is_nullable,
       c.column_default,
       c.ordinal_position
     from information_schema.columns c
     where c.table_schema not in ('pg_catalog', 'information_schema')
     order by c.table_schema asc, c.table_name asc, c.ordinal_position asc`
  );
  return result.rows.map((row) => ({
    schema: row.schema_name,
    table: row.table_name,
    column: row.column_name,
    dataType: row.data_type,
    isNullable: row.is_nullable === 'YES',
    defaultValue: row.column_default,
    isAutoIncrement: typeof row.column_default === 'string' && row.column_default.startsWith('nextval('),
    ordinal: row.ordinal_position,
  }));
}

export async function listIndexes(client: Client, schema: string, table: string): Promise<SQLIndexInfo[]> {
  const result = await client.query<{
    name: string;
    is_unique: boolean;
    is_primary: boolean;
    method: string;
    columns: string[];
  }>(
    `select
       ic.relname as name,
       i.indisunique as is_unique,
       i.indisprimary as is_primary,
       am.amname as method,
       array_agg(a.attname order by ord.n) as columns
     from pg_index i
     join pg_class c on c.oid = i.indrelid
     join pg_namespace n on n.oid = c.relnamespace
     join pg_class ic on ic.oid = i.indexrelid
     join pg_am am on am.oid = ic.relam
     join unnest(i.indkey) with ordinality as ord(attnum, n) on true
     join pg_attribute a on a.attrelid = c.oid and a.attnum = ord.attnum
     where n.nspname = $1 and c.relname = $2
     group by ic.relname, i.indisunique, i.indisprimary, am.amname
     order by i.indisprimary desc, ic.relname asc`,
    [schema, table]
  );
  return result.rows.map((r) => ({
    name: r.name,
    columns: r.columns ?? [],
    isUnique: r.is_unique,
    isPrimary: r.is_primary,
    method: r.method,
  }));
}

export async function listKeys(client: Client, schema: string, table: string): Promise<SQLKeyInfo[]> {
  const result = await client.query<{
    name: string;
    contype: string;
    columns: string[];
    referenced_table: string | null;
    referenced_columns: string[] | null;
  }>(
    `select
       con.conname as name,
       con.contype as contype,
       (select array_agg(att.attname order by k.n)
          from unnest(con.conkey) with ordinality as k(attnum, n)
          join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum) as columns,
       case when con.contype = 'f'
         then (select nf.nspname || '.' || cf.relname
                 from pg_class cf join pg_namespace nf on nf.oid = cf.relnamespace
                 where cf.oid = con.confrelid)
         else null end as referenced_table,
       case when con.contype = 'f'
         then (select array_agg(attf.attname order by k.n)
                 from unnest(con.confkey) with ordinality as k(attnum, n)
                 join pg_attribute attf on attf.attrelid = con.confrelid and attf.attnum = k.attnum)
         else null end as referenced_columns
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2 and con.contype in ('p','f','u','c')
     order by con.contype asc, con.conname asc`,
    [schema, table]
  );
  const map: Record<string, SQLKeyInfo['type']> = { p: 'primary', f: 'foreign', u: 'unique', c: 'check' };
  return result.rows.map((r) => ({
    name: r.name,
    type: map[r.contype] ?? 'check',
    columns: r.columns ?? [],
    referencedTable: r.referenced_table ?? undefined,
    referencedColumns: r.referenced_columns ?? undefined,
  }));
}

export async function listTriggers(client: Client, schema: string, table?: string): Promise<SQLTriggerInfo[]> {
  const params: unknown[] = [schema];
  let tableFilter = '';
  if (table) { params.push(table); tableFilter = ` and c.relname = $2`; }
  const result = await client.query<{
    name: string;
    table_name: string;
    tgtype: number;
  }>(
    `select t.tgname as name, c.relname as table_name, t.tgtype as tgtype
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname = $1${tableFilter}
     order by c.relname asc, t.tgname asc`,
    params
  );
  return result.rows.map((r) => {
    // pg_trigger.tgtype bitmask: bit0=row, bit1=before, bit2=insert, bit3=delete, bit4=update, bit6=instead
    const tg = r.tgtype;
    let timing: SQLTriggerInfo['timing'];
    if (tg & (1 << 6)) timing = 'INSTEAD OF';
    else if (tg & (1 << 1)) timing = 'BEFORE';
    else timing = 'AFTER';
    const events: string[] = [];
    if (tg & (1 << 2)) events.push('INSERT');
    if (tg & (1 << 3)) events.push('DELETE');
    if (tg & (1 << 4)) events.push('UPDATE');
    return { name: r.name, table: r.table_name, timing, event: events.join(', ') || undefined };
  });
}

export async function getPrimaryKey(client: Client, schema: string, table: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `select a.attname as column_name
     from pg_index i
     join pg_class c on c.oid = i.indrelid
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
     where i.indisprimary and n.nspname = $1 and c.relname = $2
     order by array_position(i.indkey, a.attnum)`,
    [schema, table]
  );
  return result.rows.map((r) => r.column_name);
}
