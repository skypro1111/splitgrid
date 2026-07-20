// Static, per-dialect capability table. Pure data + types — no runtime deps.
// Lives in `shared` so both main and renderer can import it.

import type { DialectCapabilities, SQLDialect } from './types';

export const DIALECT_CAPABILITIES: Record<SQLDialect, DialectCapabilities> = {
  postgres: {
    dialect: 'postgres',
    label: 'PostgreSQL',
    defaultPort: 5432,
    supportsSchemas: true,
    supportsMaterializedViews: true,
    supportsMultipleDatabases: true,
    identifierQuote: '"',
    identifierQuoteClose: '"',
    paramPlaceholder: 'numbered',
    supportsExplainAnalyze: true,
    requiresFilePath: false,
    supportsTransactions: true,
    supportsSequences: true,
    supportsProcedures: true,
    defaultSchema: 'public',
  },
  mysql: {
    dialect: 'mysql',
    label: 'MySQL',
    defaultPort: 3306,
    supportsSchemas: false, // schema == database in MySQL
    supportsMaterializedViews: false,
    supportsMultipleDatabases: true,
    identifierQuote: '`',
    identifierQuoteClose: '`',
    paramPlaceholder: 'question',
    supportsExplainAnalyze: true,
    requiresFilePath: false,
    supportsTransactions: true,
    supportsSequences: false,
    supportsProcedures: true,
    defaultSchema: null,
  },
  mariadb: {
    dialect: 'mariadb',
    label: 'MariaDB',
    defaultPort: 3306,
    supportsSchemas: false,
    supportsMaterializedViews: false,
    supportsMultipleDatabases: true,
    identifierQuote: '`',
    identifierQuoteClose: '`',
    paramPlaceholder: 'question',
    supportsExplainAnalyze: true,
    requiresFilePath: false,
    supportsTransactions: true,
    supportsSequences: true, // MariaDB 10.3+ has sequences
    supportsProcedures: true,
    defaultSchema: null,
  },
  sqlite: {
    dialect: 'sqlite',
    label: 'SQLite',
    defaultPort: null,
    supportsSchemas: false,
    supportsMaterializedViews: false,
    supportsMultipleDatabases: false,
    identifierQuote: '"',
    identifierQuoteClose: '"',
    paramPlaceholder: 'question',
    supportsExplainAnalyze: false, // EXPLAIN QUERY PLAN, not EXPLAIN ANALYZE
    requiresFilePath: true,
    supportsTransactions: true,
    supportsSequences: false,
    supportsProcedures: false,
    defaultSchema: null,
  },
  mssql: {
    dialect: 'mssql',
    label: 'Microsoft SQL Server',
    defaultPort: 1433,
    supportsSchemas: true,
    supportsMaterializedViews: false, // indexed views instead
    supportsMultipleDatabases: true,
    identifierQuote: '[',
    identifierQuoteClose: ']',
    paramPlaceholder: 'named',
    supportsExplainAnalyze: false, // SET STATISTICS / execution plans
    requiresFilePath: false,
    supportsTransactions: true,
    supportsSequences: true,
    supportsProcedures: true,
    defaultSchema: 'dbo',
  },
};

export function getDialectCapabilities(d: SQLDialect): DialectCapabilities {
  return DIALECT_CAPABILITIES[d];
}
