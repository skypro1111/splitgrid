// SQL statement read/write classifier for the agent SQL bridge's write gate.
//
// The write gate is enforced in the renderer dispatch (useSqlAgentBridge) but the
// AUTHORITATIVE write flag is supplied by main on every command — the renderer
// can classify but can never self-grant write. This module is the pure, testable
// classification half: given a single statement's text, decide READ vs WRITE.
//
// Conservative by design: anything we don't positively recognize as a pure read
// is treated as WRITE, so an unfamiliar/obfuscated statement can never slip past
// the gate. Pairs with splitSqlStatements() (the tokenizer) — callers split a
// batch first, then classify each statement.

import { splitSqlStatements } from './sqlStatements';

export type SqlAccess = 'read' | 'write';

// Strip leading SQL comments / whitespace so the first keyword is reachable even
// when a statement opens with `-- note` or `/* */`.
function stripLeadingTrivia(sql: string): string {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    s = s.replace(/^--[^\n]*\n?/, '');
    s = s.replace(/^\/\*[\s\S]*?\*\//, '');
    if (s === before) break;
  }
  return s;
}

// Read-only leading keywords. SELECT/WITH need extra checks (CTE bodies, INTO,
// FOR UPDATE) handled below; the rest here are unconditionally read.
const READ_LEADERS = new Set([
  'select', 'show', 'explain', 'describe', 'desc', 'pragma', 'use', 'values', 'table',
]);

// Write leading keywords (DML + DDL + privilege + procedural). Not exhaustive —
// anything not positively a read falls through to WRITE anyway — but listed so
// intent is explicit.
const WRITE_LEADERS = new Set([
  'insert', 'update', 'delete', 'merge', 'replace', 'upsert',
  'create', 'alter', 'drop', 'truncate', 'rename', 'comment',
  'grant', 'revoke', 'call', 'do', 'exec', 'execute',
  'set', 'reset', 'begin', 'start', 'commit', 'rollback', 'savepoint',
  'vacuum', 'analyze', 'cluster', 'reindex', 'copy', 'load', 'lock', 'attach', 'detach',
]);

// Does a SELECT/CTE body contain DML or a side-effecting clause? Used to catch
// `SELECT ... INTO`, `SELECT ... FOR UPDATE/SHARE`, and CTEs whose body is DML
// (`WITH x AS (DELETE ...) SELECT ...`). Regexes are word-boundaried + case-
// insensitive; they intentionally over-match (conservative → WRITE).
function selectHasWriteClause(sql: string): boolean {
  // SELECT ... INTO <table> (new-table materialization). Excludes `INTO` that is
  // part of nothing-of-the-kind by requiring it after the SELECT list.
  if (/\bselect\b[\s\S]*\binto\b/i.test(sql)) return true;
  // Locking reads: FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE / FOR KEY SHARE.
  if (/\bfor\s+(no\s+key\s+)?(update|share|key\s+share)\b/i.test(sql)) return true;
  // DML embedded anywhere (CTE bodies, etc.).
  if (/\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|call)\b/i.test(sql)) return true;
  return false;
}

/** Classify a single SQL statement as a read or a write. Conservative: anything
 * not positively a pure read is WRITE. */
export function classifyStatement(sql: string): SqlAccess {
  const body = stripLeadingTrivia(sql);
  if (!body) return 'read'; // empty/comment-only — harmless
  const m = /^([a-zA-Z_]+)/.exec(body);
  const kw = (m?.[1] ?? '').toLowerCase();

  if (WRITE_LEADERS.has(kw)) return 'write';

  if (kw === 'select' || kw === 'with' || kw === 'table' || kw === 'values') {
    // WITH and SELECT (and bare TABLE/VALUES) are reads unless their body carries
    // a write clause or DML (CTE-wrapped writes, SELECT INTO, locking reads).
    return selectHasWriteClause(body) ? 'write' : 'read';
  }

  // EXPLAIN ANALYZE actually executes the plan → write; plain EXPLAIN is a read.
  if (kw === 'explain') {
    return /\banalyze\b/i.test(body) ? 'write' : 'read';
  }

  if (READ_LEADERS.has(kw)) return 'read';

  // Unknown leading keyword → conservative default.
  return 'write';
}

export interface BatchClassification {
  access: SqlAccess;      // 'write' if ANY statement is a write
  hasWrite: boolean;
  count: number;          // number of non-trivial statements
}

/** Split a batch and classify it as a whole. A batch is WRITE if ANY statement is
 * a write — the caller refuses the WHOLE batch (clearer than executing the reads
 * and blocking the writes mid-stream). */
export function classifyBatch(sql: string): BatchClassification {
  const stmts = splitSqlStatements(sql);
  let hasWrite = false;
  for (const s of stmts) {
    if (classifyStatement(s.text) === 'write') { hasWrite = true; break; }
  }
  return { access: hasWrite ? 'write' : 'read', hasWrite, count: stmts.length };
}
