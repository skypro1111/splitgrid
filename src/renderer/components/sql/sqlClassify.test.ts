import { describe, it, expect } from 'vitest';
import { classifyStatement, classifyBatch } from './sqlClassify';

// The classifier is the security gate that protects the user's DB: anything not
// positively recognized as a pure read must be treated as WRITE so an
// unfamiliar/obfuscated statement can never slip past the "Allow agents to modify
// data" toggle. These tests are intentionally exhaustive.

describe('classifyStatement — reads', () => {
  const reads: Array<[string, string]> = [
    ['plain SELECT', 'SELECT * FROM users'],
    ['SELECT with WHERE', "select id from users where name = 'bob'"],
    ['WITH ... SELECT (CTE read)', 'WITH t AS (SELECT 1 AS n) SELECT n FROM t'],
    ['nested CTE read', 'with a as (select 1), b as (select 2 from a) select * from b'],
    ['SHOW', 'SHOW TABLES'],
    ['plain EXPLAIN', 'EXPLAIN SELECT 1'],
    ['EXPLAIN with parens (no analyze)', 'EXPLAIN (FORMAT JSON) SELECT 1'],
    ['PRAGMA', 'PRAGMA table_info(users)'],
    ['DESCRIBE', 'DESCRIBE users'],
    ['DESC', 'DESC users'],
    ['VALUES', 'VALUES (1), (2), (3)'],
    ['bare TABLE read', 'TABLE users'],
    ['USE (db switch, treated as read leader)', 'USE analytics'],
    ['leading line comment then select', '-- pick users\nSELECT * FROM users'],
    ['leading block comment then select', '/* note */ SELECT 1'],
    ['multiple leading comments + whitespace', '\n  -- a\n  /* b */\n\n  select 1'],
    ['lowercase', 'select 1'],
    ['UPPERCASE', 'SELECT 1'],
    ['MiXeD case', 'SeLeCt 1'],
    ['leading newlines stripped', '\n\n\nSELECT 1'],
    ['empty string', ''],
    ['comment-only', '-- just a note'],
    ['whitespace-only', '   \n  '],
  ];
  for (const [label, sql] of reads) {
    it(`reads: ${label}`, () => expect(classifyStatement(sql)).toBe('read'));
  }
});

describe('classifyStatement — writes', () => {
  const writes: Array<[string, string]> = [
    ['INSERT', "INSERT INTO users (name) VALUES ('x')"],
    ['UPDATE', "UPDATE users SET name = 'x' WHERE id = 1"],
    ['DELETE', 'DELETE FROM users WHERE id = 1'],
    ['CREATE TABLE', 'CREATE TABLE t (id int)'],
    ['ALTER TABLE', 'ALTER TABLE t ADD COLUMN c int'],
    ['DROP TABLE', 'DROP TABLE t'],
    ['TRUNCATE', 'TRUNCATE TABLE t'],
    ['GRANT', 'GRANT SELECT ON t TO bob'],
    ['REVOKE', 'REVOKE SELECT ON t FROM bob'],
    ['CALL (procedure)', 'CALL do_stuff(1)'],
    ['MERGE', 'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = 1'],
    ['REPLACE', "REPLACE INTO t VALUES (1)"],
    ['SET', 'SET search_path TO public'],
    ['BEGIN', 'BEGIN'],
    ['COMMIT', 'COMMIT'],
    ['ROLLBACK', 'ROLLBACK'],
    ['VACUUM', 'VACUUM ANALYZE'],
    ['COPY', "COPY t FROM '/tmp/x.csv'"],
    ['LOCK', 'LOCK TABLE t IN EXCLUSIVE MODE'],
    ['EXEC', 'EXEC sp_who'],
    ['EXPLAIN ANALYZE (executes the plan)', 'EXPLAIN ANALYZE SELECT * FROM users'],
    ['EXPLAIN (ANALYZE) parenthesized', 'EXPLAIN (ANALYZE, BUFFERS) SELECT 1'],
    ['SELECT ... INTO (materializes a table)', 'SELECT * INTO new_users FROM users'],
    ['SELECT ... FOR UPDATE (locking read)', 'SELECT * FROM users FOR UPDATE'],
    ['SELECT ... FOR SHARE', 'SELECT * FROM users FOR SHARE'],
    ['SELECT ... FOR NO KEY UPDATE', 'SELECT * FROM users FOR NO KEY UPDATE'],
    ['CTE wrapping DELETE (data-modifying CTE)', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'],
    ['CTE wrapping INSERT', 'WITH i AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM i'],
    ['CTE wrapping UPDATE', 'WITH u AS (UPDATE t SET x = 1 RETURNING *) SELECT * FROM u'],
    ['unknown leading keyword', 'FROBNICATE the_database'],
    ['gibberish', 'asdfqwer zxcv'],
    ['comment then DROP', '-- cleanup\nDROP TABLE t'],
    ['uppercase DROP', 'DROP TABLE T'],
    ['lowercase drop', 'drop table t'],
    ['leading whitespace then update', '   UPDATE t SET x = 1'],
  ];
  for (const [label, sql] of writes) {
    it(`writes: ${label}`, () => expect(classifyStatement(sql)).toBe('write'));
  }
});

describe('classifyStatement — conservative over-matching (SAFE direction)', () => {
  // The body scan for embedded DML/keywords intentionally over-matches: it does
  // NOT exclude string literals or identifiers. A SELECT that merely *mentions* a
  // write keyword is classified WRITE. This errs toward blocking — a harmless read
  // may be refused, but a real write can NEVER be misclassified as a read. These
  // tests pin that deliberate behavior so a future "fix" that loosens it (and
  // could let a write slip past the gate) fails loudly.
  const conservativeWrites: Array<[string, string]> = [
    ['string literal containing the word drop', "SELECT 'please drop everything' AS note"],
    ['column literally named update', 'SELECT update FROM changelog'],
    ['column named update with alias', 'SELECT u.update AS last_update FROM u'],
    ['string literal mentioning delete', "SELECT 'soft delete' AS kind FROM t"],
  ];
  for (const [label, sql] of conservativeWrites) {
    it(`treated as write (conservative): ${label}`, () => expect(classifyStatement(sql)).toBe('write'));
  }
});

describe('classifyBatch', () => {
  it('all-read batch is read', () => {
    const r = classifyBatch('SELECT 1; SELECT 2; SHOW TABLES');
    expect(r.access).toBe('read');
    expect(r.hasWrite).toBe(false);
    expect(r.count).toBe(3);
  });

  it('any write in the batch makes the whole batch write', () => {
    const r = classifyBatch("SELECT 1; DELETE FROM t WHERE id = 1; SELECT 2");
    expect(r.access).toBe('write');
    expect(r.hasWrite).toBe(true);
    expect(r.count).toBe(3);
  });

  it('a single write statement', () => {
    const r = classifyBatch('DROP TABLE t');
    expect(r.access).toBe('write');
    expect(r.hasWrite).toBe(true);
  });

  it('a single read statement', () => {
    const r = classifyBatch('SELECT 42');
    expect(r.access).toBe('read');
    expect(r.hasWrite).toBe(false);
  });

  it('semicolon inside a string literal does NOT split (still one read)', () => {
    const r = classifyBatch("SELECT 'a;b;c' AS s");
    expect(r.count).toBe(1);
    expect(r.access).toBe('read');
  });

  it('semicolon inside a string literal does not split into a second statement', () => {
    // The splitter is string-aware: the ; lives inside the literal, so this is
    // ONE statement, not two. (It is still classified WRITE because the body scan
    // conservatively matches the word "drop" — the safe direction; see the
    // over-matching suite. The load-bearing assertion here is count === 1.)
    const r = classifyBatch("SELECT 'x; drop table t' AS note");
    expect(r.count).toBe(1);
    expect(r.access).toBe('write');
  });

  it('trailing semicolon / empty trailing statement is ignored', () => {
    const r = classifyBatch('SELECT 1;');
    expect(r.count).toBe(1);
    expect(r.access).toBe('read');
  });

  it('comment-only batch counts no statements and is read', () => {
    const r = classifyBatch('-- nothing here');
    expect(r.hasWrite).toBe(false);
    expect(r.access).toBe('read');
  });

  it('write hidden after leading reads is still caught', () => {
    const r = classifyBatch('SELECT 1; SELECT 2; UPDATE t SET x = 1');
    expect(r.access).toBe('write');
    expect(r.hasWrite).toBe(true);
  });
});
