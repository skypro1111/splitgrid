// Pragmatic SQL statement splitter. Not a full parser — it tokenizes just enough
// to know when a `;` is a real statement terminator vs. one sitting inside a
// string / comment / dollar-quoted block. Used for run-at-cursor, run-selection,
// run-all and for mapping postgres error positions back to editor locations.

export interface SqlStatement {
  /** Trimmed statement text (no trailing `;`). */
  text: string;
  /** Offset of the first non-trivia char of the statement, into the source. */
  start: number;
  /** Offset just past the last char (before the terminating `;`), into source. */
  end: number;
  /** Offset of `start` within the source, used verbatim for marker mapping. */
  rawStart: number;
  /** 1-based line of `start`. */
  startLine: number;
  /** 1-based line of `end`. */
  endLine: number;
}

/**
 * Split SQL text into individual statements. Handles:
 *  - single-quoted strings ('...'), with '' escape
 *  - double-quoted identifiers ("..."), with "" escape
 *  - backtick identifiers (`...`) for MySQL/MariaDB
 *  - line comments (-- ... \n)
 *  - block comments (slash-star ... star-slash), non-nested
 *  - Postgres dollar-quoted strings ($$ ... $$ and $tag$ ... $tag$)
 * Semicolons inside any of the above do NOT terminate a statement.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const len = sql.length;

  // Precompute line starts for offset->line mapping.
  const lineStarts: number[] = [0];
  for (let i = 0; i < len; i += 1) {
    if (sql[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    // binary search: last lineStart <= offset
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  };

  let i = 0;
  let segStart = 0; // start of current statement segment

  const pushSegment = (segEnd: number) => {
    // segEnd is exclusive of the terminating `;`
    const raw = sql.slice(segStart, segEnd);
    const trimmedLeft = raw.replace(/^\s+/, '');
    const leadingWs = raw.length - trimmedLeft.length;
    const text = raw.trim();
    if (!text) return;
    const rawStart = segStart + leadingWs;
    // end offset = rawStart + length of right-trimmed content
    const end = rawStart + text.length;
    statements.push({
      text,
      start: rawStart,
      end,
      rawStart,
      startLine: lineOf(rawStart),
      endLine: lineOf(Math.max(rawStart, end - 1)),
    });
  };

  while (i < len) {
    const ch = sql[i];

    // line comment
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') i += 1;
      continue;
    }
    // block comment
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // single-quoted string
    if (ch === "'") {
      i += 1;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    // double-quoted identifier
    if (ch === '"') {
      i += 1;
      while (i < len) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    // backtick identifier (mysql/mariadb)
    if (ch === '`') {
      i += 1;
      while (i < len && sql[i] !== '`') i += 1;
      i += 1;
      continue;
    }
    // dollar-quoted string ($$...$$ or $tag$...$tag$)
    if (ch === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0]; // includes both $...$
        i += tag.length;
        const closeIdx = sql.indexOf(tag, i);
        i = closeIdx === -1 ? len : closeIdx + tag.length;
        continue;
      }
    }
    // statement terminator
    if (ch === ';') {
      pushSegment(i);
      i += 1;
      segStart = i;
      continue;
    }
    i += 1;
  }

  // trailing segment without terminator
  pushSegment(len);

  return statements;
}

/** Find the statement whose range contains the cursor offset. Falls back to the
 * statement immediately before the cursor (so trailing-whitespace cursor still
 * runs the previous statement, DataGrip-style). */
export function statementAtOffset(
  statements: SqlStatement[],
  offset: number,
): SqlStatement | null {
  if (statements.length === 0) return null;
  for (const stmt of statements) {
    if (offset >= stmt.rawStart && offset <= stmt.end) return stmt;
  }
  // cursor in the gap between statements (whitespace/comments/`;`): pick the
  // last statement that starts at or before the cursor, else the first.
  let candidate: SqlStatement | null = null;
  for (const stmt of statements) {
    if (stmt.rawStart <= offset) candidate = stmt;
    else break;
  }
  return candidate ?? statements[0];
}
