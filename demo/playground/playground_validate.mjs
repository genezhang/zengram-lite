// Engine-level validation for the playground: drive the REAL wasm DB through
// the router + every example snippet + the concurrency demo SQL, so we prove the
// SQL the page ships actually runs. DOM/OPFS are browser-only and covered by the
// manual pass; this covers everything else.
//
// Uses the SAME web-target artifact the page loads (demo/pkg-web/), shared with
// the agentic-memory demo and fetched via scripts/fetch-artifact.sh. Run under a
// JS runtime that supports ESM + fetch of a local file URL, e.g.:
//
//   (from repo root) node demo/playground/playground_validate.mjs
//   (or)             bun demo/playground/playground_validate.mjs
//
// The web target is self-initializing via its default export; call it once
// before constructing a ZetaDb.

import init, { ZetaDb } from "../pkg-web/zengram_wasm.js";
import { runAll, run, classify } from "./console/router.mjs";
import { resultToGrid, statusLine } from "./console/format.mjs";

// The web target's default init() fetches its .wasm by URL, which works in the
// browser but not under node (undici won't fetch file://). Read the bytes off
// disk and hand them to init() directly so this harness runs under plain node.
import { readFile } from "node:fs/promises";
const wasmBytes = await readFile(
  new URL("../pkg-web/zengram_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
}

// The exact example SQL from playground.html (kept in sync by hand — this is the
// guardrail that catches drift).
const EXAMPLES = {
  tour: `CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE books  (id INTEGER PRIMARY KEY, author_id INTEGER, title TEXT, year INTEGER);
INSERT INTO authors VALUES (1,'Ursula K. Le Guin'), (2,'Toni Morrison'), (3,'Italo Calvino');
INSERT INTO books VALUES
  (1,1,'The Dispossessed',1974), (2,1,'A Wizard of Earthsea',1968),
  (3,2,'Beloved',1987), (4,3,'Invisible Cities',1972), (5,3,'If on a winters night',1979);
SELECT a.name, count(*) AS books, min(b.year) AS earliest
FROM authors a JOIN books b ON b.author_id = a.id
GROUP BY a.name ORDER BY books DESC, earliest;`,

  joins: `WITH RECURSIVE nums(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 5
)
SELECT n, n * n AS square,
       sum(n) OVER (ORDER BY n) AS running_sum
FROM nums ORDER BY n;`,

  window: `CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, author_id INTEGER, title TEXT, year INTEGER);
SELECT author_id, title, year,
       row_number() OVER w AS seq, rank() OVER w AS yr_rank, lag(year) OVER w AS prev_year
FROM books
WINDOW w AS (PARTITION BY author_id ORDER BY year)
ORDER BY author_id, year;`,

  vector: `CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT, embedding VECTOR(3));
INSERT INTO docs VALUES
  (1,'red apple',   '[0.9, 0.1, 0.0]'),
  (2,'green apple', '[0.8, 0.2, 0.1]'),
  (3,'blue sky',    '[0.0, 0.1, 0.9]');
CREATE INDEX docs_vec ON docs USING HNSW (embedding vector_l2_ops);
SELECT id, body, embedding <-> '[0.85, 0.15, 0.0]' AS dist
FROM docs ORDER BY dist LIMIT 3;`,

  fts: `CREATE TABLE posts (id INTEGER PRIMARY KEY, body TEXT);
INSERT INTO posts VALUES
  (1,'the quick brown fox jumps'),
  (2,'a lazy dog sleeps all day'),
  (3,'quick foxes are clever');
SELECT id, body,
       ts_rank(to_tsvector('english', body), plainto_tsquery('english','quick fox')) AS rank
FROM posts
WHERE to_tsvector('english', body) @@ plainto_tsquery('english','quick fox')
ORDER BY rank DESC;`,
  branching: `DROP TABLE IF EXISTS t;
CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
INSERT INTO t VALUES (1, 'on main');
CREATE BRANCH feat;
SET zeta_branch = 'feat';
INSERT INTO t VALUES (2, 'only on feat');
SELECT * FROM t ORDER BY id;
RESET zeta_branch;
SELECT * FROM t ORDER BY id;
MERGE BRANCH feat;
SELECT * FROM t ORDER BY id;`,
  jsonb: `CREATE TABLE products (id INT PRIMARY KEY, name TEXT, attrs JSONB);
INSERT INTO products VALUES
  (1,'Laptop',  '{"brand":"Acme","specs":{"ram":16,"ssd":512},"tags":["work","portable"]}'),
  (2,'Desk',    '{"brand":"Oak","specs":{"width":120},"tags":["home"]}'),
  (3,'Monitor', '{"brand":"Acme","specs":{"size":27},"tags":["work"]}');
SELECT name, attrs->'specs'->>'ram' AS ram, attrs->>'brand' AS brand
FROM products WHERE attrs @> '{"brand":"Acme"}' ORDER BY id;
SELECT jsonb_agg(name ORDER BY id) AS work_products
FROM products WHERE attrs->'tags' ? 'work';`,
  multidb: `CREATE DATABASE shop;
CREATE DATABASE analytics;
USE shop;
CREATE TABLE orders (id INT PRIMARY KEY, total NUMERIC);
INSERT INTO orders VALUES (1, 42.50), (2, 17.00);
SELECT current_database() AS db, count(*) AS orders, sum(total) AS revenue FROM orders;
RESET database;
SELECT count(*) AS shop_orders FROM shop.public.orders;`,
  pgq: `CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE knows (id INTEGER PRIMARY KEY, person1_id INTEGER, person2_id INTEGER, since INTEGER);
INSERT INTO person VALUES (1,'Alice'),(2,'Bob'),(3,'Carol'),(4,'Dave');
INSERT INTO knows VALUES (1,1,2,2020),(2,2,3,2021),(3,3,4,2022),(4,1,3,2019);
CREATE PROPERTY GRAPH social
  VERTEX TABLES (person KEY (id) LABEL Person PROPERTIES (name))
  EDGE TABLES (knows KEY (id) SOURCE KEY (person1_id) REFERENCES person (id) DESTINATION KEY (person2_id) REFERENCES person (id) LABEL Knows PROPERTIES (since));
SELECT * FROM GRAPH_TABLE(social MATCH (a:Person)-[e:Knows]->(b:Person) COLUMNS (a.name AS knower, b.name AS known, e.since AS year));
SELECT * FROM GRAPH_TABLE(social MATCH (a:Person)-[:Knows]->(b:Person)-[:Knows]->(c:Person) COLUMNS (a.name AS src, c.name AS reached));`,
};

function freshDb() { return ZetaDb.open(); }

// 1) Guided tour: routes correctly + final SELECT returns 3 grouped rows.
{
  const db = freshDb();
  const results = runAll(db, EXAMPLES.tour);
  for (const r of results) assert(!r.error, `tour stmt failed: ${r.sql} → ${r.error}`);
  const last = results[results.length - 1];
  assert(last.kind === "query", "tour last stmt is a query");
  assert(last.rows.length === 3, `tour GROUP BY → 3 authors (got ${last.rows.length})`);
  // statusLine + grid shape sanity
  assert(/^3 rows · /.test(statusLine(last)), "tour status line");
  const grid = resultToGrid(last);
  assert(grid.columns.includes("books"), "tour grid has 'books' column");
  console.log("tour →", statusLine(last), JSON.stringify(last.rows[0]));
}

// 2) Recursive CTE + correlated subquery.
{
  const db = freshDb();
  const results = runAll(db, EXAMPLES.joins);
  const last = results[results.length - 1];
  assert(!last.error, `joins failed: ${last.error}`);
  assert(last.rows.length === 5, `nums 1..5 (got ${last.rows.length})`);
  assert(Number(last.rows[4].running_sum) === 15, `running_sum at n=5 is 15 (got ${last.rows[4].running_sum})`);
  console.log("joins →", statusLine(last));
}

// 3) Window functions over the tour's `books` (reuse tour db so books exist).
{
  const db = freshDb();
  runAll(db, EXAMPLES.tour);
  const results = runAll(db, EXAMPLES.window);
  const last = results[results.length - 1];
  assert(!last.error, `window failed: ${last.error}`);
  assert(last.rows.length === 5, `window over 5 books (got ${last.rows.length})`);
  assert(last.columns.includes("yr_rank"), "window has yr_rank column");
  console.log("window →", statusLine(last), JSON.stringify(last.rows[0]));
}

// 4) Vector HNSW search: nearest to a reddish vector is a red/green apple, not sky.
{
  const db = freshDb();
  const results = runAll(db, EXAMPLES.vector);
  for (const r of results) assert(!r.error, `vector stmt failed: ${r.sql} → ${r.error}`);
  const last = results[results.length - 1];
  assert(last.rows.length === 3, `vector returns 3 rows (got ${last.rows.length})`);
  assert(last.rows[0].body !== "blue sky", `nearest to reddish query must not be 'blue sky' (got ${last.rows[0].body})`);
  console.log("vector →", statusLine(last), "nearest:", last.rows[0].body);
}

// 5) Full-text @@ match: rows 1 and 3 mention quick+fox, row 2 does not.
{
  const db = freshDb();
  const results = runAll(db, EXAMPLES.fts);
  for (const r of results) assert(!r.error, `fts stmt failed: ${r.sql} → ${r.error}`);
  const last = results[results.length - 1];
  assert(last.rows.length === 2, `@@ 'quick fox' matches 2 posts (got ${last.rows.length})`);
  const ids = last.rows.map((x) => Number(x.id)).sort();
  assert(JSON.stringify(ids) === "[1,3]", `@@ matches posts 1 and 3 (got ${JSON.stringify(ids)})`);
  console.log("fts →", statusLine(last), "ids:", JSON.stringify(ids));
}

// 5b) Branching example: branch isolation + merge, driven through the router
//     exactly as "Run all" does. Proves the shipped snippet runs clean and
//     demonstrates the feature (and ends back on main, so a re-run is safe).
{
  const db = freshDb();
  const results = runAll(db, EXAMPLES.branching);
  for (const r of results) assert(!r.error, `branching stmt failed: ${r.sql} → ${r.error}`);
  const queries = results.filter((r) => r.kind === "query" && Array.isArray(r.rows) && r.rows.length && "id" in r.rows[0]);
  // The three SELECTs on `t`: on-branch (1,2), back-on-main (1), after-merge (1,2).
  const ids = (r) => r.rows.map((x) => Number(x.id)).sort();
  assert(JSON.stringify(ids(queries[0])) === "[1,2]", `on-branch sees 1,2 (got ${JSON.stringify(ids(queries[0]))})`);
  assert(JSON.stringify(ids(queries[1])) === "[1]", `back-on-main sees only 1 (got ${JSON.stringify(ids(queries[1]))})`);
  assert(JSON.stringify(ids(queries[2])) === "[1,2]", `after-merge sees 1,2 (got ${JSON.stringify(ids(queries[2]))})`);
  assert(db.branch() == null, "branching example ends back on main");
  console.log("branching → on-branch [1,2] · main [1] · merged [1,2]");
}

// 5c) JSONB: path ops (-> / ->>), containment (@>), key existence (?), jsonb_agg.
{
  const db = freshDb();
  const results = runAll(db, EXAMPLES.jsonb);
  for (const r of results) assert(!r.error, `jsonb stmt failed: ${r.sql} → ${r.error}`);
  const qs = results.filter((r) => r.kind === "query");
  // First query: two Acme rows (Laptop with ram=16, Monitor with ram=null).
  assert(qs[0].rows.length === 2, `@> 'Acme' matches 2 rows (got ${qs[0].rows.length})`);
  assert(String(qs[0].rows[0].ram) === "16", `Laptop ram is 16 (got ${qs[0].rows[0].ram})`);
  // Second query: jsonb_agg of the two 'work'-tagged products.
  assert(
    JSON.stringify(qs[1].rows[0].work_products) === '["Laptop","Monitor"]',
    `work_products agg (got ${JSON.stringify(qs[1].rows[0].work_products)})`,
  );
  console.log("jsonb → @>Acme 2 rows · work_products [Laptop,Monitor]");
}

// 5d) Multi-database: USE switches the current db; unqualified names resolve into
//     it; cross-db access via a fully-qualified name.
{
  const db = freshDb();
  const results = runAll(db, EXAMPLES.multidb);
  for (const r of results) assert(!r.error, `multidb stmt failed: ${r.sql} → ${r.error}`);
  const qs = results.filter((r) => r.kind === "query");
  assert(qs[0].rows[0].db === "shop", `current_database() is shop (got ${qs[0].rows[0].db})`);
  assert(Number(qs[0].rows[0].orders) === 2, `2 orders in shop (got ${qs[0].rows[0].orders})`);
  // After RESET, the qualified count still reaches shop's table.
  assert(Number(qs[1].rows[0].shop_orders) === 2, `qualified shop.public.orders = 2 (got ${qs[1].rows[0].shop_orders})`);
  console.log("multidb → shop current_database, 2 orders, qualified reach OK");
}

// 5e) SQL/PGQ: property graph + GRAPH_TABLE MATCH (one-hop with edge prop, two-hop).
{
  const db = freshDb();
  const results = runAll(db, EXAMPLES.pgq);
  for (const r of results) assert(!r.error, `pgq stmt failed: ${r.sql} → ${r.error}`);
  const qs = results.filter((r) => r.kind === "query");
  assert(qs[0].rows.length === 4, `one-hop Knows has 4 edges (got ${qs[0].rows.length})`);
  // Two-hop: Alice→Carol, Alice→Dave, Bob→Dave = 3 reaches.
  assert(qs[1].rows.length === 3, `two-hop reach has 3 rows (got ${qs[1].rows.length})`);
  console.log("pgq → one-hop 4 edges · two-hop 3 reaches");
}

// 6) Schema sidebar via db.schema() (the wasm build has no information_schema
//    SQL shim — the page reads the catalog directly).
{
  const db = freshDb();
  runAll(db, EXAMPLES.tour);
  const s = db.schema();
  const names = (s.tables || []).map((t) => t.name).sort();
  assert(names.includes("authors") && names.includes("books"), `schema() sees tables (got ${JSON.stringify(names)})`);
  const books = s.tables.find((t) => t.name === "books");
  assert(books && books.columns.length === 4, `books has 4 columns (got ${books ? books.columns.length : "none"})`);
  const idCol = books.columns.find((c) => c.name === "id");
  assert(idCol && idCol.pk === true, "books.id is flagged pk");
  const authors = s.tables.find((t) => t.name === "authors");
  const nameCol = authors.columns.find((c) => c.name === "name");
  assert(nameCol && nameCol.nullable === false, "authors.name is NOT NULL");
  console.log("schema →", JSON.stringify(names), "| books cols:", books.columns.map((c) => c.name).join(","));
}

// 7) The concurrency demo, exactly as the page drives it: two overlapping txns,
//    A's snapshot count unchanged after B commits, both visible after A commits.
{
  const db = freshDb();
  db.execDdl("CREATE TABLE iso_demo (id INTEGER PRIMARY KEY)");
  db.execMut("INSERT INTO iso_demo (id) VALUES (1)");
  const a = db.begin();
  const aBefore = a.query("SELECT COUNT(*) AS c FROM iso_demo").rows[0].c;
  assert(Number(aBefore) === 1, "A initial snapshot sees 1");
  const b = db.begin();
  b.execMut("INSERT INTO iso_demo (id) VALUES (2)");
  b.commit();
  const aAfter = a.query("SELECT COUNT(*) AS c FROM iso_demo").rows[0].c;
  assert(Number(aAfter) === 1, `A must still see 1 after B commits (SI); got ${aAfter}`);
  a.commit();
  const fresh = db.query("SELECT COUNT(*) AS c FROM iso_demo").rows[0].c;
  assert(Number(fresh) === 2, `fresh read sees both; got ${fresh}`);
  console.log(`concurrency demo → A: ${aBefore}→${aAfter} while B committed; fresh: ${fresh}`);
}

// 8) Router guidance: an interactive BEGIN typed into the editor is refused, not
//    misrouted, and does not touch the db.
{
  const db = freshDb();
  const r = run(db, "BEGIN");
  assert(r.kind === "txn" && /autocommit|demo/i.test(r.error), "BEGIN is guided, not executed");
  console.log("router guidance → BEGIN refused with guidance");
}

// 8b) DML … RETURNING routes to the read path and renders the returned rows
//     (not just an affected count) — the console must show what the user asked
//     for. Proven against the real engine end-to-end through run().
{
  const db = freshDb();
  db.execDdl("CREATE TABLE r (id INTEGER PRIMARY KEY, v INTEGER)");
  const ins = run(db, "INSERT INTO r VALUES (1,10),(2,20) RETURNING id, v");
  assert(ins.kind === "query", "INSERT … RETURNING takes the read path");
  assert(ins.rows.length === 2, `INSERT … RETURNING renders 2 rows (got ${ins.rows.length})`);
  assert(Number(ins.rows[0].id) === 1 && Number(ins.rows[1].v) === 20, "RETURNING rows carry the values");
  // The mutation still happened.
  assert(Number(db.query("SELECT count(*) AS c FROM r").rows[0].c) === 2, "RETURNING also persisted the rows");
  const upd = run(db, "UPDATE r SET v = v + 1 RETURNING id, v");
  assert(upd.kind === "query" && upd.rows.length === 2, "UPDATE … RETURNING renders rows");
  const del = run(db, "DELETE FROM r WHERE id = 1 RETURNING id");
  assert(del.kind === "query" && del.rows.length === 1, "DELETE … RETURNING renders rows");
  // A plain mutation still takes the count path.
  const plain = run(db, "INSERT INTO r VALUES (3, 30)");
  assert(plain.kind === "mut" && plain.affected === 1, "plain INSERT stays on the count path");
  console.log("returning → INSERT/UPDATE/DELETE … RETURNING render rows; plain DML stays count");
}

// 9) Snapshot export/restore is what the OPFS Save/Load buttons call.
{
  const db = freshDb();
  runAll(db, EXAMPLES.tour);
  const snap = db.exportSnapshot();
  assert(snap instanceof Uint8Array && snap.length > 0, "exportSnapshot returns bytes");
  const restored = ZetaDb.openFromSnapshot(snap);
  const n = restored.query("SELECT count(*) AS c FROM books").rows[0].c;
  assert(Number(n) === 5, `restored db has the 5 books; got ${n}`);
  console.log("snapshot → export/restore preserved", n, "books");
}

// 9b) A VECTOR-column database snapshots and restores (catalog-log tag 21) — the
//     Save button used to throw on the vector example.
{
  const db = freshDb();
  runAll(db, EXAMPLES.vector);
  const snap = db.exportSnapshot();
  assert(snap instanceof Uint8Array && snap.length > 0, "VECTOR db exportSnapshot returns bytes");
  const restored = ZetaDb.openFromSnapshot(snap);
  const n = Number(restored.query("SELECT count(*) AS c FROM docs").rows[0].c);
  assert(n === 3, `restored VECTOR db has 3 docs; got ${n}`);
  const near = restored.query(
    "SELECT body FROM docs ORDER BY embedding <-> '[0.85,0.15,0.0]' LIMIT 1",
  ).rows[0].body;
  assert(near !== "blue sky", `vector search still works after restore (got ${near})`);
  console.log("snapshot → VECTOR-column db round-trips; nearest after restore:", near);
}

console.log(`\nOK: playground engine validation passed — ${checks} assertions across all 9 examples, the schema sidebar (db.schema()), the concurrency demo, router guidance, and snapshot round-trip.`);
