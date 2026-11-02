---
name: sg-sql
description: Runs SQL and inspects databases through the SQL pane of this SplitGrid workspace via $SPLITGRID_SQL_CLI - list saved connections, connect the pane, list tables and columns, read a table's DDL, run queries and EXPLAIN (results also appear in the pane), and export or import tables. Use it for any database work from a SplitGrid terminal - querying data, checking a schema or the shape of a table, debugging a slow or wrong query, exporting rows to CSV/JSON/SQL/XLSX - even when the user doesn't mention the pane. Prefer it over psql, mysql or a SQL MCP tool for the workspace's saved connections, which open a separate connection the user can't see and lack SplitGrid's saved credentials. Read-only unless the user allows writes in Settings. Requires a SplitGrid terminal ($SPLITGRID_SQL_CLI set).
---

# SplitGrid SQL control

This CLI drives the workspace's SQL pane: switch connections, inspect schema,
run queries, export and import tables. What runs here surfaces in the pane, so
the user sees the same results.

```sh
"$SPLITGRID_SQL_CLI" <command> [args...]
```

If `$SPLITGRID_SQL_CLI` is empty, this is not a SplitGrid terminal (or SQL
control is off), and this skill does not apply. Each call prints one JSON line:
`{"ok":true, ...}` or `{"ok":false,"error":"...","message":"..."}`. Check `ok`
after every call.

## Rules

- **Read-only by default.** Unless the user has enabled "Allow agents to modify
  data" in Settings → Agent integrations, any statement that changes data or
  schema is refused with `write_blocked`: INSERT, UPDATE, DELETE, CREATE,
  ALTER, DROP, TRUNCATE, GRANT, CALL, `EXPLAIN ANALYZE`, `SELECT … INTO`,
  locking reads, CTE-wrapped DML, and anything not recognized as a pure read.
  `import` is refused too. `$SPLITGRID_SQL_WRITE=1` means writes are allowed.
- **On `write_blocked`, stop and ask** the user to enable "Allow agents to
  modify data". Don't retry or work around it.
- **Keep reads and writes in separate calls.** A batch with any write in it is
  treated as a write and refused whole.
- **Scope is this workspace's SQL pane.** Most commands create a pane if none
  exists (then run `use <conn>`), in this agent's zone; a subagent adds
  `--zone <name>` as with `$SPLITGRID_TERMINAL_CLI`. `list` and `connections`
  work without one.

## Typical flow

```sh
"$SPLITGRID_SQL_CLI" connections                  # what's saved
"$SPLITGRID_SQL_CLI" use prod-pg                   # connect the pane
"$SPLITGRID_SQL_CLI" tables                        # what tables exist
"$SPLITGRID_SQL_CLI" columns users                 # the shape of one
"$SPLITGRID_SQL_CLI" query "select id, email from users order by created_at desc limit 10"
# -> {"ok":true,"rowCount":10,"output":"+----+ ...","columns":["id","email"]}
```

- Run `use` (or `open`) before any schema or query command. A pane with no
  connection can't introspect or run SQL.
- Pass a whole statement as one quoted argument.
- `query`, `explain` and `columns` return a text table in `output` plus
  structured `columns` and `rowCount`. The text table is capped at 100 rows and
  says how many more there are. Narrow the query, or `export` when every row is
  needed.

## Commands

```sh
"$SPLITGRID_SQL_CLI" help                              # the authoritative command list

"$SPLITGRID_SQL_CLI" list                              # SQL panes in this workspace, the targeted one, connection/dialect/db
"$SPLITGRID_SQL_CLI" connections                       # saved SQL connections (label, dialect, host, db), no secrets

"$SPLITGRID_SQL_CLI" use <conn> [database]             # switch the targeted pane to a saved connection (name or id)
"$SPLITGRID_SQL_CLI" open <conn>                       # create a SQL pane if none exists, then connect it

"$SPLITGRID_SQL_CLI" tables [schema]                   # tables/views in a schema (default: current)
"$SPLITGRID_SQL_CLI" columns <table> [schema]          # columns with type / nullable / PK
"$SPLITGRID_SQL_CLI" ddl <table> [schema]              # the table's CREATE DDL

"$SPLITGRID_SQL_CLI" query <sql>                       # run SQL; results surface in a tab (write-gated)
"$SPLITGRID_SQL_CLI" explain <sql>                     # EXPLAIN (a read; EXPLAIN ANALYZE is a write)

"$SPLITGRID_SQL_CLI" export <table> <csv|json|sql|xlsx> <path> [schema]   # export to a file (a read)
"$SPLITGRID_SQL_CLI" import <table> <csvpath> [schema]                    # import a CSV (write-gated)
```

When a reply reports `targetedMultiple`, the workspace has several SQL panes and
the command acted on the first. Mention it if the user might have meant another.

## Errors

- `sql_disabled`: SQL agent access is off. Ask the user to enable it in
  Settings → Agent integrations.
- `write_blocked`: see Rules.
- `no_workspace`: the terminal's workspace couldn't be found; this may not be a
  SplitGrid terminal.
- `missing_connection` / `missing_table` / `missing_sql` / `usage`: bad or
  empty arguments. Read the usage line in `message`.
- `connect_failed`: the connection wasn't found or the database is unreachable.
  Run `connections` for valid names.
- `query_failed` / `explain_failed` / `ddl_failed` / `export_failed` /
  `import_failed`: the database returned an error. Read `message`.
- `pane_not_ready`: a new pane is still mounting. Retry once.
- `bad_format`: the export format must be `csv`, `json`, `sql` or `xlsx`.
