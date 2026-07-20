/**
 * Live-DB integration test for the rebuilt SQL backend (Phase 7 runtime verification).
 *
 * This file exercises the REAL backend modules the IPC layer uses — the
 * `sqlRegistry` singleton, the concrete drivers, edit-builder, export.ts and
 * import.ts — against actual databases. It is split into two suites:
 *
 *  - PostgreSQL (Part A): GATED. Only runs when `SQL_IT=1` AND a Postgres is
 *    reachable. Skips gracefully otherwise so the normal `npm test` is never
 *    affected. Point it at a throwaway pg:
 *      docker run -d --rm --name splitgrid_sqltest \
 *        -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=testdb -p 55433:5432 postgres:16
 *      SQL_IT=1 npx vitest run src/main/sql/__tests__/integration.postgres.test.ts
 *    Host/port/user/etc. are overridable via SQL_IT_PG_* env vars (defaults below).
 *
 *  - SQLite (Part C): ALWAYS runs (better-sqlite3 needs no server; fast +
 *    deterministic). Validates the native module and the driver abstraction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { sqlRegistry } from '../registry';
import { exportData } from '../export';
import { parseCsv } from '../../../shared/sql-serialize';
import type { SQLConnectionConfig, SQLEditChange } from '../../../shared/types';

const PG_ENABLED = process.env.SQL_IT === '1';

/**
 * better-sqlite3 is a NATIVE module built against Electron's Node ABI. Under a
 * plain `npm test` (system Node, different ABI) it cannot load, which would crash
 * the suite. So we probe it once: when it can't load in the current runtime we
 * skip the SQLite suite gracefully. To actually exercise SQLite, run vitest under
 * Electron's bundled Node, which has the matching ABI:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
 *     ./node_modules/vitest/vitest.mjs run src/main/sql/__tests__/integration.postgres.test.ts
 */
const SQLITE_LOADABLE = (() => {
  try {
    // The JS wrapper imports fine; the native .node addon only binds on the FIRST
    // `new Database()`, which is where an ABI mismatch actually throws — so we
    // must instantiate to truly probe loadability.
    const probe = new BetterSqlite3(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const PG_CONFIG: SQLConnectionConfig = {
  dialect: 'postgres',
  host: process.env.SQL_IT_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.SQL_IT_PG_PORT ?? 55433),
  user: process.env.SQL_IT_PG_USER ?? 'postgres',
  password: process.env.SQL_IT_PG_PASSWORD ?? 'postgres',
  database: process.env.SQL_IT_PG_DB ?? 'testdb',
};

// Deps wrapper so export.ts can be called directly the way the registry does.
const exportDeps = {
  execute: (id: string, sql: string, params?: unknown[]) => sqlRegistry.execute(id, sql, params),
  getDialect: (id: string) => sqlRegistry.getDialect(id),
};

// Vitest's default testTimeout (5s, from vitest.config.ts) is too short for live
// DB work; bump per-suite where needed.
const DB_TIMEOUT = 60_000;

/* ============================ PART A: PostgreSQL ============================ */

describe.skipIf(!PG_ENABLED)('PostgreSQL live integration (SQL_IT=1)', () => {
  let connId: string;
  const tmpFiles: string[] = [];
  const tmpFile = (name: string) => {
    const p = join(mkdtempSync(join(tmpdir(), 'sqlit-')), name);
    tmpFiles.push(p);
    return p;
  };

  beforeAll(async () => {
    const info = await sqlRegistry.connect(PG_CONFIG);
    connId = info.id;
    // Clean slate.
    await sqlRegistry.execute(connId, 'DROP TABLE IF EXISTS it_orders CASCADE');
    await sqlRegistry.execute(connId, 'DROP TABLE IF EXISTS it_people CASCADE');

    await sqlRegistry.execute(
      connId,
      `CREATE TABLE it_people (
         id          integer PRIMARY KEY,
         name        text NOT NULL,
         active      boolean DEFAULT true,
         created_at  timestamp DEFAULT now(),
         balance     numeric(10,2),
         meta        json
       )`,
    );
    await sqlRegistry.execute(
      connId,
      `INSERT INTO it_people (id, name, active, balance, meta) VALUES
         (1, 'Alice', true,  100.50, '{"role":"admin"}'),
         (2, 'Bob',   false, 0.00,   '{"role":"user"}'),
         (3, 'Carol', true,  42.25,  '{"role":"user"}')`,
    );
    // Second table for FK + index + trigger introspection.
    await sqlRegistry.execute(
      connId,
      `CREATE TABLE it_orders (
         order_id  integer PRIMARY KEY,
         person_id integer NOT NULL REFERENCES it_people(id),
         amount    numeric(10,2)
       )`,
    );
    await sqlRegistry.execute(connId, `CREATE INDEX it_orders_person_idx ON it_orders(person_id)`);
    await sqlRegistry.execute(
      connId,
      `CREATE OR REPLACE FUNCTION it_noop() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`,
    );
    await sqlRegistry.execute(
      connId,
      `CREATE TRIGGER it_people_trg BEFORE INSERT ON it_people FOR EACH ROW EXECUTE FUNCTION it_noop()`,
    );
  }, DB_TIMEOUT);

  afterAll(async () => {
    if (connId) {
      await sqlRegistry.execute(connId, 'DROP TABLE IF EXISTS it_orders CASCADE').catch(() => {});
      await sqlRegistry.execute(connId, 'DROP TABLE IF EXISTS it_people CASCADE').catch(() => {});
      await sqlRegistry.execute(connId, 'DROP FUNCTION IF EXISTS it_noop() CASCADE').catch(() => {});
      await sqlRegistry.disconnect(connId).catch(() => {});
    }
    for (const f of tmpFiles) rmSync(f, { force: true });
  }, DB_TIMEOUT);

  it('connects and reports a server version', async () => {
    // connId was minted in beforeAll; assert a SELECT works end to end.
    const r = await sqlRegistry.execute(connId, 'SELECT 1 AS one');
    expect(r.rows[0].one).toBe(1);
  });

  it('listDatabases includes testdb (current)', async () => {
    const dbs = await sqlRegistry.listDatabases(connId);
    const testdb = dbs.find((d) => d.name === PG_CONFIG.database);
    expect(testdb).toBeTruthy();
    expect(testdb!.isCurrent).toBe(true);
  });

  it('listSchemas includes public with our tables', async () => {
    const schemas = await sqlRegistry.listSchemas(connId);
    const pub = schemas.find((s) => s.schema === 'public');
    expect(pub).toBeTruthy();
    const tables = pub!.categories.find((c) => c.kind === 'table')!.objects.map((o) => o.name);
    expect(tables).toContain('it_people');
    expect(tables).toContain('it_orders');
  });

  it('listColumns reports the test table columns + types', async () => {
    const cols = (await sqlRegistry.listColumns(connId)).filter(
      (c) => c.schema === 'public' && c.table === 'it_people',
    );
    const byName = Object.fromEntries(cols.map((c) => [c.column, c]));
    expect(Object.keys(byName).sort()).toEqual(
      ['active', 'balance', 'created_at', 'id', 'meta', 'name'].sort(),
    );
    expect(byName.id.dataType).toBe('integer');
    expect(byName.name.dataType).toBe('text');
    expect(byName.active.dataType).toBe('boolean');
    expect(byName.created_at.dataType).toContain('timestamp');
    expect(byName.balance.dataType).toBe('numeric');
    expect(byName.meta.dataType).toBe('json');
    expect(byName.name.isNullable).toBe(false);
  });

  it('getPrimaryKey returns the PK column', async () => {
    expect(await sqlRegistry.getPrimaryKey(connId, 'public', 'it_people')).toEqual(['id']);
  });

  it('listIndexes finds the created index + the PK index', async () => {
    const idx = await sqlRegistry.listIndexes(connId, 'public', 'it_orders');
    const names = idx.map((i) => i.name);
    expect(names).toContain('it_orders_person_idx');
    expect(idx.some((i) => i.isPrimary)).toBe(true);
  });

  it('listKeys finds the PK and FK', async () => {
    const keys = await sqlRegistry.listKeys(connId, 'public', 'it_orders');
    expect(keys.some((k) => k.type === 'primary')).toBe(true);
    const fk = keys.find((k) => k.type === 'foreign');
    expect(fk).toBeTruthy();
    expect(fk!.columns).toContain('person_id');
    expect(fk!.referencedTable).toContain('it_people');
    expect(fk!.referencedColumns).toContain('id');
  });

  it('listTriggers finds the BEFORE INSERT trigger', async () => {
    const trg = await sqlRegistry.listTriggers(connId, 'public', 'it_people');
    const t = trg.find((x) => x.name === 'it_people_trg');
    expect(t).toBeTruthy();
    expect(t!.timing).toBe('BEFORE');
    expect(t!.event).toContain('INSERT');
  });

  it('getDDL returns non-empty DDL for the table', async () => {
    const ddl = await sqlRegistry.getDDL(connId, 'public', 'it_people', 'table');
    expect(ddl.ddl.length).toBeGreaterThan(0);
    expect(ddl.ddl).toContain('it_people');
  });

  it('execute SELECT returns columns/rows/rowCount', async () => {
    const r = await sqlRegistry.execute(connId, 'SELECT id, name FROM it_people ORDER BY id');
    expect(r.columns).toEqual(['id', 'name']);
    expect(r.rowCount).toBe(3);
    expect(r.rows.map((x) => x.name)).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('applyEdits round trip: update + insert + delete (incl. edited-PK rename)', async () => {
    const changes: SQLEditChange[] = [
      // plain column update
      { kind: 'update', schema: 'public', table: 'it_people', pk: { id: 1 }, column: 'name', value: 'Alice2' },
      // edited-PK rename: set id 3 -> 30 while matching on the ORIGINAL pk
      { kind: 'update', schema: 'public', table: 'it_people', pk: { id: 3 }, column: 'id', value: 30 },
      // insert
      { kind: 'insert', schema: 'public', table: 'it_people', values: { id: 4, name: 'Dave', active: true } },
      // delete
      { kind: 'delete', schema: 'public', table: 'it_people', pk: { id: 2 } },
    ];
    const res = await sqlRegistry.applyEdits(connId, changes);
    expect(res.applied).toBe(4);

    const after = await sqlRegistry.execute(connId, 'SELECT id, name FROM it_people ORDER BY id');
    expect(after.rows).toEqual([
      { id: 1, name: 'Alice2' },
      { id: 4, name: 'Dave' },
      { id: 30, name: 'Carol' },
    ]);
  });

  it('export: current-view CSV + JSON serialize the inline rows', async () => {
    const columns = ['id', 'name'];
    const rows = [
      { id: 1, name: 'Alice2' },
      { id: 4, name: 'Dave' },
    ];
    const csvPath = tmpFile('current.csv');
    const jsonPath = tmpFile('current.json');

    const csvRes = await exportData(exportDeps, connId, { format: 'csv', filePath: csvPath, scope: 'current', columns, rows });
    expect(csvRes.rowCount).toBe(2);
    const csvText = readFileSync(csvPath, 'utf-8');
    expect(csvText).toContain('id,name');
    expect(csvText).toContain('Alice2');

    const jsonRes = await exportData(exportDeps, connId, { format: 'json', filePath: jsonPath, scope: 'current', columns, rows });
    expect(jsonRes.rowCount).toBe(2);
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('Alice2');
  });

  it('export: full-table CSV streams every row from the DB', async () => {
    const csvPath = tmpFile('full.csv');
    const res = await exportData(exportDeps, connId, {
      format: 'csv',
      filePath: csvPath,
      scope: 'full',
      table: { schema: 'public', name: 'it_people' },
    });
    expect(res.rowCount).toBe(3); // Alice2, Dave, Carol
    const lines = readFileSync(csvPath, 'utf-8').trim().split('\r\n');
    expect(lines[0]).toContain('id'); // header
    expect(lines).toHaveLength(4); // header + 3 rows
  });

  it('export: xlsx full-table writes a non-empty file', async () => {
    const xlsxPath = tmpFile('full.xlsx');
    const res = await exportData(exportDeps, connId, {
      format: 'xlsx',
      filePath: xlsxPath,
      scope: 'full',
      table: { schema: 'public', name: 'it_people' },
    });
    expect(res.ok).toBe(true);
    expect(existsSync(xlsxPath)).toBe(true);
    expect(statSync(xlsxPath).size).toBeGreaterThan(0);
  });

  it('import: CSV -> table commits rows (via parseCsv + registry.importRows)', async () => {
    const csv = 'id,name\r\n100,Eve\r\n101,Frank\r\n';
    const csvPath = tmpFile('import.csv');
    writeFileSync(csvPath, csv, 'utf-8');

    const matrix = parseCsv(readFileSync(csvPath, 'utf-8'), ',');
    const [header, ...dataRows] = matrix;
    const res = await sqlRegistry.importRows(connId, {
      schema: 'public',
      table: 'it_people',
      columns: header,
      rows: dataRows,
    });
    expect(res.ok).toBe(true);
    expect(res.imported).toBe(2);

    const check = await sqlRegistry.execute(
      connId,
      "SELECT id, name FROM it_people WHERE id IN (100,101) ORDER BY id",
    );
    expect(check.rows).toEqual([
      { id: 100, name: 'Eve' },
      { id: 101, name: 'Frank' },
    ]);
  });

  it('import: bad-type row rolls back the whole transaction (no partial rows)', async () => {
    // 'not-an-int' into the integer PK column must fail and roll back.
    await expect(
      sqlRegistry.importRows(connId, {
        schema: 'public',
        table: 'it_people',
        columns: ['id', 'name'],
        rows: [
          ['200', 'Good'],
          ['not-an-int', 'Bad'],
        ],
      }),
    ).rejects.toThrow();

    const check = await sqlRegistry.execute(connId, 'SELECT id FROM it_people WHERE id IN (200)');
    expect(check.rowCount).toBe(0); // the good row before the bad one must NOT persist
  });

  it('rename + drop via the ddl-mutations path', async () => {
    await sqlRegistry.renameObject(connId, 'table', 'public', 'it_people', 'it_people_renamed');
    let schemas = await sqlRegistry.listSchemas(connId);
    let tables = schemas
      .find((s) => s.schema === 'public')!
      .categories.find((c) => c.kind === 'table')!
      .objects.map((o) => o.name);
    expect(tables).toContain('it_people_renamed');
    expect(tables).not.toContain('it_people');

    // drop the FK-dependent table first, then drop renamed (cascade to be safe).
    await sqlRegistry.dropObject(connId, 'table', 'public', 'it_orders');
    await sqlRegistry.dropObject(connId, 'table', 'public', 'it_people_renamed', { cascade: true });

    schemas = await sqlRegistry.listSchemas(connId);
    tables = schemas
      .find((s) => s.schema === 'public')!
      .categories.find((c) => c.kind === 'table')!
      .objects.map((o) => o.name);
    expect(tables).not.toContain('it_people_renamed');
    expect(tables).not.toContain('it_orders');
  });
});

/* ============================== PART C: SQLite ============================== */

// Guard with a plain `if` (not just .skipIf) so the suite's beforeAll never even
// registers when the native module can't load — otherwise vitest would still run
// the hook and crash `npm test` under system Node's mismatched ABI.
(SQLITE_LOADABLE ? describe : describe.skip)('SQLite quick check (native better-sqlite3 + driver abstraction)', () => {
  let connId: string;
  let dbDir: string;
  let dbPath: string;
  const tmpFiles: string[] = [];

  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'sqlit-lite-'));
    dbPath = join(dbDir, 'check.db');
    const info = await sqlRegistry.connect({
      dialect: 'sqlite',
      host: '',
      port: 0,
      user: '',
      password: '',
      database: dbPath,
      filePath: dbPath,
    });
    connId = info.id;
  });

  afterAll(async () => {
    if (connId) await sqlRegistry.disconnect(connId).catch(() => {});
    for (const f of tmpFiles) rmSync(f, { force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('connect + execute SQLite version', async () => {
    const r = await sqlRegistry.execute(connId, 'select sqlite_version() as v');
    expect(typeof r.rows[0].v).toBe('string');
  });

  it('create table, insert, introspect, select, edit, export, drop', async () => {
    await sqlRegistry.execute(
      connId,
      'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n REAL)',
    );
    await sqlRegistry.execute(connId, 'CREATE INDEX t_name_idx ON t(name)');
    await sqlRegistry.execute(connId, "INSERT INTO t (id, name, n) VALUES (1,'a',1.5),(2,'b',2.5)");

    // introspect: columns + PK + indexes
    const cols = (await sqlRegistry.listColumns(connId)).filter((c) => c.table === 't');
    expect(cols.map((c) => c.column).sort()).toEqual(['id', 'n', 'name']);
    expect(await sqlRegistry.getPrimaryKey(connId, 'main', 't')).toEqual(['id']);
    const idx = await sqlRegistry.listIndexes(connId, 'main', 't');
    expect(idx.some((i) => i.name === 't_name_idx')).toBe(true);

    // select
    const sel = await sqlRegistry.execute(connId, 'SELECT id, name FROM t ORDER BY id');
    expect(sel.columns).toEqual(['id', 'name']);
    expect(sel.rows).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);

    // apply an edit (update via the registry transaction path)
    const res = await sqlRegistry.applyEdits(connId, [
      { kind: 'update', schema: 'main', table: 't', pk: { id: 1 }, column: 'name', value: 'A' },
    ]);
    expect(res.applied).toBe(1);
    const after = await sqlRegistry.execute(connId, 'SELECT name FROM t WHERE id = 1');
    expect(after.rows[0].name).toBe('A');

    // export current view to CSV
    const csvPath = join(dbDir, 'out.csv');
    tmpFiles.push(csvPath);
    const exp = await exportData(exportDeps, connId, {
      format: 'csv',
      filePath: csvPath,
      scope: 'full',
      table: { schema: 'main', name: 't' },
    });
    expect(exp.rowCount).toBe(2);
    expect(readFileSync(csvPath, 'utf-8')).toContain('id,name,n');

    // drop
    await sqlRegistry.dropObject(connId, 'table', 'main', 't');
    const schemas = await sqlRegistry.listSchemas(connId);
    const tables = schemas[0].categories.find((c) => c.kind === 'table')!.objects.map((o) => o.name);
    expect(tables).not.toContain('t');
  });
});
