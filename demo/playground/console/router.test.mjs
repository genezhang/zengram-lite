// Unit tests for the playground statement router + formatter.
//
// Pure JS — no wasm, no browser. Run with:  node harness/console/router.test.mjs
// (uses the built-in node:test runner; also works under `bun test`).
//
// These cover the two things that are easy to get subtly wrong and hard to catch
// by eyeballing the UI: (1) keyword→method classification, and (2) splitting a
// multi-statement buffer without breaking on a `;` inside a string, dollar-quote,
// or comment.

import test from "node:test";
import assert from "node:assert/strict";

import { classify, splitStatements, splitStatementSpans, statementAtCursor, run, runAll, parseBranchCommand, parseDatabaseCommand } from "./router.mjs";
import { valueText, valueCell, statusLine, formatDuration, csvField, resultToCsv } from "./format.mjs";

test("classify: read-path keywords", () => {
  for (const s of [
    "SELECT 1",
    "  select * from t",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "EXPLAIN SELECT 1",
    "SHOW search_path",
    "VALUES (1),(2)",
    "TABLE t",
  ]) {
    assert.equal(classify(s), "query", s);
  }
});

test("classify: mutation-path keywords", () => {
  assert.equal(classify("INSERT INTO t VALUES (1)"), "mut");
  assert.equal(classify("update t set v=1"), "mut");
  assert.equal(classify("DELETE FROM t"), "mut");
});

test("classify: ddl keywords", () => {
  assert.equal(classify("CREATE TABLE t (id INT)"), "ddl");
  assert.equal(classify("drop index t_idx"), "ddl");
  assert.equal(classify("ALTER TABLE t ADD COLUMN v INT"), "ddl");
  assert.equal(classify("TRUNCATE t"), "ddl");
});

test("classify: transaction-control keywords", () => {
  for (const s of ["BEGIN", "start transaction", "COMMIT", "ROLLBACK", "SAVEPOINT sp"]) {
    assert.equal(classify(s), "txn", s);
  }
});

test("classify: leading comments and whitespace are stripped", () => {
  assert.equal(classify("-- a comment\nSELECT 1"), "query");
  assert.equal(classify("/* block */ INSERT INTO t VALUES (1)"), "mut");
  assert.equal(classify("\n\n   \t CREATE TABLE t (id INT)"), "ddl");
  assert.equal(classify("-- only a comment\n   "), "empty");
  assert.equal(classify(""), "empty");
});

test("classify: unknown leading keyword defaults to query (read path)", () => {
  // Functions / set-returning calls / pragmas we don't enumerate must not land on
  // the DDL path (which would swallow their result set).
  assert.equal(classify("VACUUM"), "query"); // not in the table → query
  assert.equal(classify("(SELECT 1)"), "query"); // starts with paren
  assert.equal(classify("call foo()"), "query");
});

test("classify: DML … RETURNING routes to the read path (rows must render)", () => {
  assert.equal(classify("INSERT INTO t VALUES (1) RETURNING id"), "query");
  assert.equal(classify("insert into t values (1) returning *"), "query");
  assert.equal(classify("UPDATE t SET v = 1 RETURNING id, v"), "query");
  assert.equal(classify("DELETE FROM t WHERE id = 1 RETURNING id"), "query");
  // Multi-line, trailing semicolon.
  assert.equal(classify("INSERT INTO t (id)\n  VALUES (1)\n  RETURNING id;"), "query");
});

test("classify: plain DML without RETURNING stays on the mutation path", () => {
  assert.equal(classify("INSERT INTO t VALUES (1)"), "mut");
  assert.equal(classify("UPDATE t SET v = 1"), "mut");
  assert.equal(classify("DELETE FROM t WHERE id = 1"), "mut");
});

test("classify: a 'returning' inside a string or comment does NOT reroute", () => {
  // The word appears only inside a string literal — still a plain mutation.
  assert.equal(classify("INSERT INTO t (note) VALUES ('returning soon')"), "mut");
  assert.equal(classify("UPDATE t SET note = 'we are returning' WHERE id = 1"), "mut");
  // …or inside a comment.
  assert.equal(classify("INSERT INTO t VALUES (1) -- returning later"), "mut");
  assert.equal(classify("INSERT INTO t VALUES (1) /* returning */"), "mut");
  // A column literally named containing the substring must not false-positive on
  // word boundary: "returning" as a whole word only.
  assert.equal(classify("UPDATE t SET returning_flag = 1 WHERE id = 1"), "mut");
});

test("splitStatements: simple semicolon split, trailing statement kept", () => {
  const stmts = splitStatements("SELECT 1; SELECT 2; SELECT 3");
  assert.deepEqual(
    stmts.map((s) => s.trim()),
    ["SELECT 1", "SELECT 2", "SELECT 3"],
  );
});

test("splitStatements: empty fragments dropped", () => {
  const stmts = splitStatements("SELECT 1;; ; SELECT 2;");
  assert.deepEqual(
    stmts.map((s) => s.trim()),
    ["SELECT 1", "SELECT 2"],
  );
});

test("splitStatements: semicolon inside a single-quoted string does not split", () => {
  const stmts = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1");
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /'a;b'/);
  assert.equal(stmts[1].trim(), "SELECT 1");
});

test("splitStatements: doubled quote is an escaped literal quote, not a close", () => {
  // 'it''s; fine' is ONE string literal containing a semicolon.
  const stmts = splitStatements("INSERT INTO t VALUES ('it''s; fine'); SELECT 2");
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /'it''s; fine'/);
});

test("splitStatements: semicolon inside a double-quoted identifier does not split", () => {
  const stmts = splitStatements('SELECT * FROM "weird;name"; SELECT 2');
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /"weird;name"/);
});

test("splitStatements: semicolon inside a dollar-quoted body does not split", () => {
  const body = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql";
  const stmts = splitStatements(`${body}; SELECT 9`);
  assert.equal(stmts.length, 2, "dollar-quoted body must stay one statement");
  assert.equal(stmts[1].trim(), "SELECT 9");
});

test("splitStatements: tagged dollar-quote ($tag$) is respected", () => {
  const stmts = splitStatements("SELECT $q$ a; b; c $q$; SELECT 2");
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /\$q\$ a; b; c \$q\$/);
});

test("splitStatements: semicolon inside line and block comments does not split", () => {
  assert.equal(splitStatements("SELECT 1 -- x; y\n; SELECT 2").length, 2);
  assert.equal(splitStatements("SELECT 1 /* x; y */ ; SELECT 2").length, 2);
});

// splitStatementSpans / statementAtCursor — run-at-cursor mapping. The bug this
// fixes: a trailing comment after a statement is lexically part of the NEXT
// fragment, so a cursor on the comment used to run the wrong statement.

test("splitStatementSpans: spans cover the buffer and expose content offsets", () => {
  const buf = "SELECT 1;\nSELECT 2;";
  const spans = splitStatementSpans(buf);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].text, "SELECT 1");
  assert.equal(buf.slice(spans[0].contentStart).startsWith("SELECT 1"), true);
  // end includes the terminating `;`.
  assert.equal(buf[spans[0].end - 1], ";");
  // The second span's text retains its leading whitespace; contentStart points
  // at the keyword.
  assert.equal(spans[1].text.trim(), "SELECT 2");
  assert.equal(buf.slice(spans[1].contentStart).startsWith("SELECT 2"), true);
});

test("statementAtCursor: cursor in a trailing comment maps to the statement it follows", () => {
  const buf = "SET zeta_branch = 'feat';        -- now on the branch\nINSERT INTO t VALUES (2, 'x');";
  const onComment = buf.indexOf("-- now") + 5;
  assert.equal(statementAtCursor(buf, onComment), "SET zeta_branch = 'feat';");
  // End of the comment line still maps to the SET, not the INSERT below.
  const endOfComment = buf.indexOf("\n");
  assert.equal(statementAtCursor(buf, endOfComment), "SET zeta_branch = 'feat';");
  // Cursor actually on the INSERT maps to the INSERT (clean, no glued comment).
  const onInsert = buf.indexOf("INSERT") + 3;
  assert.equal(statementAtCursor(buf, onInsert), "INSERT INTO t VALUES (2, 'x');");
});

test("statementAtCursor: cursor before the first statement maps to the first", () => {
  const buf = "-- header comment\nSELECT 1;\nSELECT 2;";
  assert.equal(statementAtCursor(buf, 0), "SELECT 1;");
  assert.equal(statementAtCursor(buf, 5), "SELECT 1;"); // inside the leading comment
});

test("statementAtCursor: single statement and empty buffer", () => {
  assert.equal(statementAtCursor("SELECT 42", 0), "SELECT 42");
  assert.equal(statementAtCursor("   \n  -- just a comment\n", 3), "");
});

test("statementAtCursor: cursor past the last statement maps to the last", () => {
  const buf = "SELECT 1;\nSELECT 2;";
  assert.equal(statementAtCursor(buf, buf.length), "SELECT 2;");
});

// A minimal fake ZetaDb capturing the method a statement was routed to, so we can
// assert dispatch without wasm.
function fakeDb() {
  const calls = [];
  return {
    calls,
    query(sql) {
      calls.push(["query", sql]);
      return { columns: ["n"], rows: [{ n: 1 }] };
    },
    execMut(sql) {
      calls.push(["execMut", sql]);
      return 3;
    },
    execDdl(sql) {
      calls.push(["execDdl", sql]);
    },
    setBranch(name) {
      calls.push(["setBranch", name]);
    },
    setDatabase(name) {
      calls.push(["setDatabase", name]);
    },
  };
}

test("run: dispatches each kind to the right method and normalizes the result", () => {
  const db = fakeDb();

  const q = run(db, "SELECT 1");
  assert.equal(q.kind, "query");
  assert.deepEqual(q.columns, ["n"]);
  assert.equal(q.rows.length, 1);
  assert.equal(typeof q.ms, "number");

  const m = run(db, "INSERT INTO t VALUES (1)");
  assert.equal(m.kind, "mut");
  assert.equal(m.affected, 3);

  const d = run(db, "CREATE TABLE t (id INT)");
  assert.equal(d.kind, "ddl");
  assert.equal(d.error, undefined);

  assert.deepEqual(
    db.calls.map((c) => c[0]),
    ["query", "execMut", "execDdl"],
  );
});

test("run: transaction-control statement is reported as guidance, not executed", () => {
  const db = fakeDb();
  const r = run(db, "BEGIN");
  assert.equal(r.kind, "txn");
  assert.match(r.error, /autocommit|Concurrent-transaction demo/i);
  assert.equal(db.calls.length, 0, "txn statement must not hit any db method");
});

test("run: engine error is captured into result.error, never thrown", () => {
  const db = {
    query() {
      throw new Error("relation \"nope\" does not exist");
    },
    execMut() {},
    execDdl() {},
  };
  const r = run(db, "SELECT * FROM nope");
  assert.equal(r.kind, "query");
  assert.match(r.error, /does not exist/);
});

test("parseBranchCommand: recognizes SET/RESET zeta_branch and extracts target", () => {
  // Select a branch — single- and double-quoted, TO and =, case-insensitive.
  assert.deepEqual(parseBranchCommand("SET zeta_branch = 'feat'"), { branch: "feat" });
  assert.deepEqual(parseBranchCommand("set zeta_branch to 'feat'"), { branch: "feat" });
  assert.deepEqual(parseBranchCommand('SET zeta_branch = "feat"'), { branch: "feat" });
  assert.deepEqual(parseBranchCommand("SET zeta_branch = 'feat';"), { branch: "feat" });
  // Back to main.
  assert.deepEqual(parseBranchCommand("RESET zeta_branch"), { branch: null });
  assert.deepEqual(parseBranchCommand("SET zeta_branch = DEFAULT"), { branch: null });
  assert.deepEqual(parseBranchCommand("SET zeta_branch TO default"), { branch: null });
  assert.deepEqual(parseBranchCommand("SET zeta_branch = ''"), { branch: null });
  // Not a branch command → null (leaves normal routing intact).
  assert.equal(parseBranchCommand("SET search_path = public"), null);
  assert.equal(parseBranchCommand("SELECT 1"), null);
  assert.equal(parseBranchCommand("SET zeta.foo = 1"), null);
});

test("run: SET zeta_branch is routed to db.setBranch, not the SQL path", () => {
  const db = fakeDb();
  const r = run(db, "SET zeta_branch = 'feat'");
  assert.equal(r.kind, "ddl", "reported as a no-rows ddl-shaped result");
  assert.equal(r.error, undefined);
  assert.deepEqual(db.calls, [["setBranch", "feat"]], "went to setBranch, not query/execDdl");

  const back = run(db, "RESET zeta_branch");
  assert.equal(back.kind, "ddl");
  assert.deepEqual(db.calls, [["setBranch", "feat"], ["setBranch", null]]);
});

test("run: setBranch failure is captured into result.error, never thrown", () => {
  const db = {
    setBranch() {
      throw new Error("branch \"gone\" does not exist");
    },
  };
  const r = run(db, "SET zeta_branch = 'gone'");
  assert.equal(r.kind, "ddl");
  assert.match(r.error, /does not exist/);
});

test("run: SET zeta_branch falls through to SQL path when handle has no setBranch", () => {
  // A ZetaTxn handle has no setBranch — the statement must NOT be intercepted
  // (you can't switch branches mid-transaction); it goes to the query path.
  const calls = [];
  const txnLike = {
    query(sql) { calls.push(["query", sql]); return { columns: [], rows: [] }; },
    execMut() {},
    execDdl() {},
  };
  const r = run(txnLike, "SET zeta_branch = 'feat'");
  assert.deepEqual(calls, [["query", "SET zeta_branch = 'feat'"]]);
  assert.equal(r.kind, "query");
});

test("parseSessionValue hardening: trailing junk after a quoted value is rejected", () => {
  // (Exercised through both parsers.) A quoted value must be the WHOLE
  // remainder — junk after the close is NOT swallowed into the name.
  assert.equal(parseBranchCommand("SET zeta_branch = 'a' WHERE 1=1"), null);
  assert.equal(parseBranchCommand("SET zeta_branch = 'a' 'b'"), null);
  assert.equal(parseDatabaseCommand("SET database = 'a' -- c"), null);
  assert.equal(parseDatabaseCommand("USE 'a' extra"), null);
  // But a clean quoted value, with optional trailing `;`, still parses.
  assert.deepEqual(parseBranchCommand("SET zeta_branch = 'a;b';"), { branch: "a;b" });
  assert.deepEqual(parseDatabaseCommand("USE 'ten ant'"), { database: "ten ant" });
});

test("parseDatabaseCommand: recognizes USE / SET database / RESET and extracts target", () => {
  // USE <db> — bare and quoted.
  assert.deepEqual(parseDatabaseCommand("USE tenant_a"), { database: "tenant_a" });
  assert.deepEqual(parseDatabaseCommand("use 'tenant_a'"), { database: "tenant_a" });
  assert.deepEqual(parseDatabaseCommand("USE tenant_a;"), { database: "tenant_a" });
  // SET database = / TO, quoted / bare / double-quoted.
  assert.deepEqual(parseDatabaseCommand("SET database = 'tenant_a'"), { database: "tenant_a" });
  assert.deepEqual(parseDatabaseCommand("set database to tenant_a"), { database: "tenant_a" });
  assert.deepEqual(parseDatabaseCommand('SET database = "tenant_a"'), { database: "tenant_a" });
  // Back to default.
  assert.deepEqual(parseDatabaseCommand("RESET database"), { database: null });
  assert.deepEqual(parseDatabaseCommand("SET database = DEFAULT"), { database: null });
  assert.deepEqual(parseDatabaseCommand("SET database = ''"), { database: null });
  // Case of the NAME is preserved (databases fold to lowercase in the engine,
  // but the parser must not pre-mangle it).
  assert.deepEqual(parseDatabaseCommand("USE 'Tenant_A'"), { database: "Tenant_A" });
  // Not a database command → null (normal routing preserved).
  assert.equal(parseDatabaseCommand("SET search_path = public"), null);
  assert.equal(parseDatabaseCommand("SELECT 1"), null);
  assert.equal(parseDatabaseCommand("SET databasex = 1"), null);
  assert.equal(parseDatabaseCommand("USER foo"), null); // not USE
});

test("run: USE / SET database is routed to db.setDatabase, not the SQL path", () => {
  const db = fakeDb();
  const r = run(db, "USE tenant_a");
  assert.equal(r.kind, "ddl");
  assert.equal(r.error, undefined);
  assert.deepEqual(db.calls, [["setDatabase", "tenant_a"]]);

  run(db, "SET database = 'tenant_b'");
  run(db, "RESET database");
  assert.deepEqual(db.calls, [
    ["setDatabase", "tenant_a"],
    ["setDatabase", "tenant_b"],
    ["setDatabase", null],
  ]);
});

test("run: setDatabase failure (unknown db) is captured into result.error", () => {
  const db = {
    setDatabase() { throw new Error("database \"gone\" does not exist"); },
  };
  const r = run(db, "USE gone");
  assert.equal(r.kind, "ddl");
  assert.match(r.error, /does not exist/);
});

test("run: USE falls through to SQL path when handle has no setDatabase", () => {
  // A ZetaTxn handle has no setDatabase — USE must not be intercepted.
  const calls = [];
  const txnLike = {
    query(sql) { calls.push(["query", sql]); return { columns: [], rows: [] }; },
    execMut() {},
    execDdl() {},
  };
  const r = run(txnLike, "USE tenant_a");
  assert.deepEqual(calls, [["query", "USE tenant_a"]]);
  assert.equal(r.kind, "query");
});

test("runAll: runs every statement in order; stopOnError halts", () => {
  const db = fakeDb();
  const results = runAll(db, "CREATE TABLE t (id INT); INSERT INTO t VALUES (1); SELECT 1");
  assert.deepEqual(
    results.map((r) => r.kind),
    ["ddl", "mut", "query"],
  );

  const failing = {
    query() {
      throw new Error("boom");
    },
    execMut() {
      return 1;
    },
    execDdl() {},
  };
  const stopped = runAll(failing, "SELECT 1; INSERT INTO t VALUES (1)", { stopOnError: true });
  assert.equal(stopped.length, 1, "stopOnError must halt after the first error");
  assert.match(stopped[0].error, /boom/);
});

test("format: valueText maps null, objects, scalars", () => {
  assert.equal(valueText(null), "∅");
  assert.equal(valueText(undefined), "∅");
  assert.equal(valueText(42), "42");
  assert.equal(valueText("hi"), "hi");
  assert.equal(valueText({ a: 1 }), '{"a":1}');
  assert.equal(valueText([1, 2, 3]), "[1,2,3]");
});

test("format: valueCell flags null and numeric", () => {
  assert.deepEqual(valueCell(null), { text: "∅", isNull: true, isNumber: false, title: "NULL" });
  assert.deepEqual(valueCell(7), { text: "7", isNull: false, isNumber: true, title: "7" });
  const s = valueCell("x");
  assert.equal(s.isNull, false);
  assert.equal(s.isNumber, false);
});

test("format: statusLine tags match statement kind", () => {
  assert.match(statusLine({ kind: "query", rows: [{}, {}], ms: 0.4 }), /^2 rows · /);
  assert.match(statusLine({ kind: "query", rows: [{}], ms: 0.4 }), /^1 row · /);
  assert.match(statusLine({ kind: "mut", sql: "INSERT INTO t VALUES (1)", affected: 3, ms: 0.1 }), /^INSERT 3 · /);
  assert.match(statusLine({ kind: "ddl", sql: "CREATE TABLE t (id INT)", ms: 0.2 }), /^CREATE TABLE · /);
  assert.match(statusLine({ kind: "query", error: "nope", ms: 1 }), /^ERROR: nope$/);
});

test("format: formatDuration switches units", () => {
  assert.match(formatDuration(0.4), /µs$/);
  assert.match(formatDuration(4.2), /ms$/);
  assert.match(formatDuration(250), /ms$/);
});

test("format: csvField quotes per RFC 4180", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField(42), "42");
  assert.equal(csvField(null), ""); // NULL → empty field
  assert.equal(csvField(undefined), "");
  assert.equal(csvField("a,b"), '"a,b"'); // comma → quoted
  assert.equal(csvField('he said "hi"'), '"he said ""hi"""'); // quotes doubled
  assert.equal(csvField("line1\nline2"), '"line1\nline2"'); // newline → quoted
  assert.equal(csvField({ a: 1 }), '"{""a"":1}"'); // object → JSON, then quoted
  assert.equal(csvField([1, 2]), '"[1,2]"');
});

test("format: resultToCsv builds header + rows, CRLF", () => {
  const result = {
    kind: "query",
    columns: ["id", "name"],
    rows: [
      { id: 1, name: "ada" },
      { id: 2, name: "b,o" }, // comma forces quoting
      { id: 3, name: null }, // NULL → empty field
    ],
  };
  const csv = resultToCsv(result);
  assert.equal(csv, 'id,name\r\n1,ada\r\n2,"b,o"\r\n3,');
  // A column-less / non-query result yields empty string.
  assert.equal(resultToCsv({ kind: "ddl", columns: [] }), "");
  assert.equal(resultToCsv({ kind: "mut" }), "");
});
