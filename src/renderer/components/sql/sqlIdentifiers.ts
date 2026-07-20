import { getDialectCapabilities } from '../../../shared/dialects';
import type { SQLDialect } from '../../../shared/types';

/**
 * Quote a SQL identifier for the given dialect using the dialect's quote chars
 * (" for pg/sqlite, ` for mysql/mariadb, [ ] for mssql). The closing quote char
 * is doubled inside the name to escape it (e.g. pg `a"b` -> `"a""b"`). This is
 * the single source of truth for identifier quoting in generated queries.
 */
export function quoteIdent(name: string, dialect: SQLDialect): string {
  const caps = getDialectCapabilities(dialect);
  const open = caps.identifierQuote;
  const close = caps.identifierQuoteClose;
  return `${open}${name.split(close).join(close + close)}${close}`;
}
