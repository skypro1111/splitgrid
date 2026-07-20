import type { SQLDialect, SQLSchemaObjectKind } from '../../shared/types';
import { getDialectCapabilities } from '../../shared/dialects';

/** Quote a SQL identifier for the given dialect (main-process copy of the
 * renderer's quoteIdent — same rules, no renderer import). */
function quoteIdent(name: string, dialect: SQLDialect): string {
  const caps = getDialectCapabilities(dialect);
  const open = caps.identifierQuote;
  const close = caps.identifierQuoteClose;
  return `${open}${name.split(close).join(close + close)}${close}`;
}

/** Map an object kind to the SQL object keyword used in CREATE/DROP/ALTER. */
function objectKeyword(kind: SQLSchemaObjectKind): string {
  switch (kind) {
    case 'view': return 'VIEW';
    case 'materializedView': return 'MATERIALIZED VIEW';
    case 'foreignTable': return 'FOREIGN TABLE';
    case 'function': return 'FUNCTION';
    case 'procedure': return 'PROCEDURE';
    case 'sequence': return 'SEQUENCE';
    case 'type': return 'TYPE';
    case 'table':
    default: return 'TABLE';
  }
}

/** A fully-qualified, dialect-quoted object reference (schema-aware). */
function ref(dialect: SQLDialect, schema: string, name: string): string {
  const caps = getDialectCapabilities(dialect);
  const n = quoteIdent(name, dialect);
  return caps.supportsSchemas && schema ? `${quoteIdent(schema, dialect)}.${n}` : n;
}

/** Build the per-dialect rename DDL. */
export function buildRenameSql(
  dialect: SQLDialect,
  kind: SQLSchemaObjectKind,
  schema: string,
  name: string,
  newName: string,
): string {
  const keyword = objectKeyword(kind);
  const from = ref(dialect, schema, name);
  const toBare = quoteIdent(newName, dialect);
  switch (dialect) {
    case 'postgres':
      // Tables/views/sequences/types: ALTER <kind> ... RENAME TO <newName>.
      return `ALTER ${keyword} ${from} RENAME TO ${toBare}`;
    case 'mysql':
    case 'mariadb':
      // MySQL only supports RENAME TABLE cleanly (views via ALTER are limited);
      // for tables use RENAME TABLE; everything else best-effort ALTER ... RENAME.
      if (kind === 'table') return `RENAME TABLE ${from} TO ${ref(dialect, schema, newName)}`;
      return `ALTER ${keyword} ${from} RENAME TO ${toBare}`;
    case 'sqlite':
      // SQLite supports renaming tables only.
      return `ALTER TABLE ${from} RENAME TO ${toBare}`;
    case 'mssql': {
      // T-SQL sp_rename takes STRING LITERALS (not identifiers), so quoteIdent
      // doesn't apply — escape embedded single quotes by doubling and use N''
      // literals to prevent SQL injection via object/new names.
      const lit = (s: string) => `N'${s.split("'").join("''")}'`;
      return `EXEC sp_rename ${lit((schema ? schema + '.' : '') + name)}, ${lit(newName)}`;
    }
    default:
      return `ALTER ${keyword} ${from} RENAME TO ${toBare}`;
  }
}

/** Build the per-dialect drop DDL. */
export function buildDropSql(
  dialect: SQLDialect,
  kind: SQLSchemaObjectKind,
  schema: string,
  name: string,
  opts?: { cascade?: boolean },
): string {
  const keyword = objectKeyword(kind);
  const target = ref(dialect, schema, name);
  switch (dialect) {
    case 'postgres':
      return `DROP ${keyword} IF EXISTS ${target}${opts?.cascade ? ' CASCADE' : ''}`;
    case 'mysql':
    case 'mariadb':
      // MySQL has no CASCADE on DROP; the keyword is accepted but ignored, so omit it.
      return `DROP ${keyword} IF EXISTS ${target}`;
    case 'sqlite':
      return `DROP ${keyword} IF EXISTS ${target}`;
    case 'mssql':
      // MSSQL: DROP <kind> IF EXISTS (SQL Server 2016+); no CASCADE.
      return `DROP ${keyword} IF EXISTS ${target}`;
    default:
      return `DROP ${keyword} IF EXISTS ${target}`;
  }
}
