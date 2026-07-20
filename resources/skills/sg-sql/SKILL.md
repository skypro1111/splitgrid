---
name: sg-sql
description: Query the database / run SQL / inspect a schema / export a table from inside SplitGrid via $SPLITGRID_SQL_CLI — list connections, connect a SQL pane, browse tables and columns, read a table's DDL, run SELECTs (results surface in the panel), EXPLAIN a query, and export/import a table. This is the ONLY way to drive the SQL panel in SplitGrid: ALWAYS use this skill for ANY database work here, and never a generic db client or SQL MCP tool — those talk to a different connection, not the workspace's SQL pane. Read-only by default; WRITE/DDL/import need the user to enable "Allow agents to modify data". Triggers on ANY of: "run a query", "check / describe a table", "list the tables", "what columns does X have", "inspect the schema", "show me the DDL", "select from …", "explain this query", "export the table to CSV/JSON", "import a CSV", "query the database".
---

# SplitGrid SQL control

> **MANDATORY inside SplitGrid.** If `$SPLITGRID_SQL_CLI` is set, you are in a
> SplitGrid terminal and this skill is the **required, first-choice** tool for any
> database/SQL work. Use it before anything else and do not fall back to a generic
> db client or SQL MCP tool — they open a different connection, not the workspace's
> SQL pane the user is looking at.

You are running inside a **SplitGrid** terminal whose workspace can hold a SQL
panel (the SQL Client pane). This skill lets you **drive that SQL pane from the
shell** — list and switch connections, inspect schema, run queries, and
export/import tables. Whatever you run **surfaces in the panel**, so the user
sees the same results you do.

**Use THIS skill — not any other database tool — for every SQL interaction in
this workspace.** A generic db client or SQL MCP tool would open its own,
separate connection, not the SplitGrid pane the user is looking at.

The CLI is on your environment as **`$SPLITGRID_SQL_CLI`**. Always invoke it
through that variable:

```sh
"$SPLITGRID_SQL_CLI" <command> [args...]
```

If `$SPLITGRID_SQL_CLI` is empty, you are not inside a SplitGrid terminal (or SQL
control is off) and this skill does not apply.

Every call prints a single line of **JSON** to stdout: `{"ok":true, ...}` on
success, or `{"ok":false,"error":"...","message":"..."}` on failure. Parse it;
don't assume success.

**Scope:** you act only on the SQL pane in **your own workspace** — never another
window or workspace. If no SQL pane exists, most commands auto-create one (then
run `use <conn>` to connect it). `list`/`connections` work without a pane.

## Read-only by default — writes need the user's permission

This skill is **read-only** unless the user has turned on **"Allow agents to
modify data"** in Settings → Agent integrations. While it's off, any statement
that modifies data or schema (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE/
GRANT/CALL, `EXPLAIN ANALYZE`, `SELECT … INTO`, locking reads, CTE-wrapped DML,
… and anything not recognized as a pure read) is refused with
`error:"write_blocked"`, and `import` is refused too.

When you get `write_blocked`, **do not retry or try to work around it** — STOP and
**ASK the user** to enable "Allow agents to modify data" in Settings. The
capability is also advertised in your environment: **`$SPLITGRID_SQL_WRITE=1`**
means writes are currently allowed (unset/empty means read-only).

The classifier is conservative: a batch is treated as a write if *any* statement
in it is a write, and the whole batch is refused. Keep reads and writes in
separate calls.

## Command reference

```sh
"$SPLITGRID_SQL_CLI" help                              # the authoritative command list

# Discover
"$SPLITGRID_SQL_CLI" list                              # SQL panes in this workspace + which is targeted, with connection/dialect/db
"$SPLITGRID_SQL_CLI" connections                       # saved SQL connections (label, dialect, host, db) — no secrets

# Connect a pane
"$SPLITGRID_SQL_CLI" use <conn> [database]             # switch the target pane to a saved connection (by name or id)
"$SPLITGRID_SQL_CLI" open <conn>                        # create a SQL pane if none exists, then connect it

# Inspect schema (reads)
"$SPLITGRID_SQL_CLI" tables [schema]                   # tables/views in a schema (default: current)
"$SPLITGRID_SQL_CLI" columns <table> [schema]          # columns with type / nullable / PK
"$SPLITGRID_SQL_CLI" ddl <table> [schema]              # the table's CREATE DDL text

# Run SQL
"$SPLITGRID_SQL_CLI" query <sql>                        # run SQL; results surface in a tab (write-gated)
"$SPLITGRID_SQL_CLI" explain <sql>                      # EXPLAIN the SQL (read; EXPLAIN ANALYZE is a WRITE)

# Move data
"$SPLITGRID_SQL_CLI" export <table> <csv|json|sql|xlsx> <path> [schema]   # export a table to a file (read)
"$SPLITGRID_SQL_CLI" import <table> <csvpath> [schema]                    # import a CSV into a table (write-gated)
```

`query`/`explain`/`columns` return a ready-to-read text table in the `output`
field plus structured `columns`/`rowCount`. The text table is **capped at 100
rows** (it tells you how many more there are) — narrow your query or use `export`
when you need everything.

Pass a whole statement as a single quoted argument:
`"$SPLITGRID_SQL_CLI" query "select id, name from users where active limit 20"`.

## Error codes

- `sql_disabled` — SQL agent access is off entirely. Ask the user to enable it in
  Settings → Agent integrations (then this skill works).
- `write_blocked` — the statement (or import) modifies data/schema and "Allow
  agents to modify data" is off. ASK the user to enable it; don't retry.
- `no_workspace` — couldn't locate your terminal's workspace. You may not be in a
  SplitGrid terminal.
- `missing_connection` / `missing_table` / `missing_sql` / `usage` — bad/empty
  args; re-read the usage line in the reply's `message`.
- `connect_failed` — the connection name/id wasn't found or the DB is
  unreachable. Run `connections` to see valid names.
- `query_failed` / `explain_failed` / `ddl_failed` / `export_failed` /
  `import_failed` — the DB returned an error; read `message`.
- `pane_not_ready` — a freshly-created pane is still mounting; just retry once.
- `bad_format` — `export` format must be `csv|json|sql|xlsx`.

When `list` (or another command) reports `targetedMultiple`, the workspace has
several SQL panes and the command acted on the FIRST one. There were others —
mention it if the user might have meant a different pane.

## Typical flows

**Inspect a schema, then read some rows:**
```sh
"$SPLITGRID_SQL_CLI" connections                       # see what's saved
"$SPLITGRID_SQL_CLI" use prod-pg                        # connect the pane
"$SPLITGRID_SQL_CLI" tables                             # what tables exist
"$SPLITGRID_SQL_CLI" columns users                      # the shape of one
"$SPLITGRID_SQL_CLI" query "select id, email from users order by created_at desc limit 10"
# -> {"ok":true,"rowCount":10,"output":"+----+ ...","columns":["id","email"]}
```

**Export a table to CSV:**
```sh
"$SPLITGRID_SQL_CLI" use analytics
"$SPLITGRID_SQL_CLI" export orders csv /tmp/orders.csv     # read-gated; allowed by default
# -> {"ok":true,"table":"orders","format":"csv","path":"/tmp/orders.csv","rowCount":4213}
```

**A write the user hasn't permitted yet:**
```sh
"$SPLITGRID_SQL_CLI" query "delete from sessions where expired"
# -> {"ok":false,"error":"write_blocked","message":"... enable \"Allow agents to modify data\" in Settings."}
# STOP — ask the user to enable writes; don't retry.
```

## Tips

- One command per call; chain them in sequence, checking `ok` each time.
- `use` (or `open`) before any schema/query command — a pane with no connection
  can't introspect or run SQL.
- Default to read-only thinking: prefer `select` + `explain`; only attempt
  writes/DDL/import after confirming `$SPLITGRID_SQL_WRITE=1` (or expect a
  `write_blocked` you must escalate to the user).
- Use `export` instead of a huge `query` when you need more than ~100 rows.
- Run `"$SPLITGRID_SQL_CLI" help` for the authoritative command list.
