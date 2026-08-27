// End-to-end driver for the zengram-lite database switcher, exercising the SAME
// path the browser console uses: typed SQL text → router.run(db, sql) → the
// REAL compiled wasm engine (nodejs target). This is the headless equivalent of
// clicking around the playground: it types `CREATE DATABASE`, switches with all
// three syntaxes the console accepts (`USE`, `SET database`, `RESET database`),
// and proves current_database() + unqualified name resolution track the switch
// with real per-database isolation — not a cosmetic label.
//
// Unlike playground_validate.mjs (which drives the switcher only via db.setX
// bindings), this goes through parseDatabaseCommand + run()'s interception, so
// it covers the console's actual keystroke → effect chain.
//
//   (from repo root, after build-from-source.sh) node demo/playground/console/switcher_driver.mjs

import { ZetaDb } from "../../pkg/zengram_wasm.js";
import { run } from "./router.mjs";

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// Run one line of "console input" through the real router+engine and return the
// RunResult, exactly as the page's editor does.
function type(db, sql) {
  return run(db, sql);
}

// The scalar text of a single-cell SELECT, via the router's query path.
function scalar(db, sql) {
  const r = type(db, sql);
  assert(!r.error, `${sql} errored: ${r.error}`);
  assert(r.rows && r.rows.length >= 1, `${sql} returned no rows`);
  // nodejs binding exposes rows as objects keyed by column name.
  const row = r.rows[0];
  const val = Array.isArray(row) ? row[0] : Object.values(row)[0];
  return String(val);
}

const db = ZetaDb.open();

// —— A fresh console starts on the system-default database ————————————————————
assert(
  scalar(db, "SELECT current_database()") === "zeta",
  "a fresh console must start on the system-default database (zeta)",
);
assert(
  typeof db.setDatabase === "function" && typeof db.databases === "function",
  "the switcher bindings must be present on the compiled engine",
);

// —— Create two tenant databases via typed DDL ————————————————————————————————
for (const name of ["tenant_a", "tenant_b"]) {
  const r = type(db, `CREATE DATABASE ${name}`);
  assert(!r.error, `CREATE DATABASE ${name} errored: ${r.error}`);
}
// databases() lists them, zeta first.
const dbs = db.databases();
assert(
  Array.isArray(dbs) && dbs[0] === "zeta" && dbs.includes("tenant_a") && dbs.includes("tenant_b"),
  `databases() must list zeta first + both tenants; got ${JSON.stringify(dbs)}`,
);

// —— Switch syntax #1: MySQL-style `USE <db>` —————————————————————————————————
{
  const r = type(db, "USE tenant_a");
  assert(!r.error && r.kind === "ddl", `USE tenant_a should be an intercepted ddl-shaped confirm; got ${JSON.stringify(r)}`);
  assert(db.database() === "tenant_a", "USE must switch the connected database");
  assert(
    scalar(db, "SELECT current_database()") === "tenant_a",
    "current_database() must report tenant_a after USE",
  );
}

// An UNQUALIFIED CREATE/INSERT/SELECT resolves into tenant_a.public — the crux.
{
  const c = type(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  assert(!c.error, `unqualified CREATE in tenant_a errored: ${c.error}`);
  const i = type(db, "INSERT INTO t VALUES (1, 'from_tenant_a')");
  assert(!i.error, `unqualified INSERT in tenant_a errored: ${i.error}`);
  assert(
    scalar(db, "SELECT v FROM t") === "from_tenant_a",
    "unqualified SELECT must read tenant_a's row",
  );
}

// —— Switch syntax #2: `SET database = '<db>'` ————————————————————————————————
{
  const r = type(db, "SET database = 'tenant_b'");
  assert(!r.error && r.kind === "ddl", `SET database should be an intercepted confirm; got ${JSON.stringify(r)}`);
  assert(db.database() === "tenant_b", "SET database must switch the connected database");
  assert(
    scalar(db, "SELECT current_database()") === "tenant_b",
    "current_database() must report tenant_b after SET database",
  );
  // tenant_a's unqualified `t` must NOT be visible from tenant_b — real
  // namespace separation. The identical bare name `t` does not exist here, so
  // this must fail specifically as "not found" (not merely any error — an
  // unrelated failure would be a false positive for isolation).
  const miss = type(db, "SELECT v FROM t");
  assert(
    miss.error && /not found|does not exist|no such/i.test(miss.error),
    `unqualified t (created in tenant_a) must NOT resolve from tenant_b; got error: ${miss.error}`,
  );
}

// —— Cross-database reachability by fully-qualified name ———————————————————————
assert(
  scalar(db, "SELECT v FROM tenant_a.public.t") === "from_tenant_a",
  "tenant_a's row must still be reachable by fully-qualified name from tenant_b",
);

// —— Switch syntax #3: `RESET database` → back to the system default ——————————
{
  const r = type(db, "RESET database");
  assert(!r.error && r.kind === "ddl", `RESET database should be an intercepted confirm; got ${JSON.stringify(r)}`);
  assert(db.database() === null, "RESET database must clear the selection (null)");
  assert(
    scalar(db, "SELECT current_database()") === "zeta",
    "current_database() must report zeta after RESET",
  );
  // The tenant tables are invisible unqualified on the default db too.
  assert(
    /not found|does not exist|no such/i.test(type(db, "SELECT v FROM t").error ?? ""),
    "unqualified t must not resolve on the default db",
  );
}

// —— Switching to an unknown database is a clean, contained error ——————————————
{
  const r = type(db, "USE nonesuch");
  assert(r.error, "USE of an unknown database must error");
  assert(
    /does not exist/i.test(r.error),
    `error should say the database does not exist; got: ${r.error}`,
  );
  // ...and it must NOT have moved the selection.
  assert(db.database() === null, "a failed switch must leave the current database unchanged");
  assert(
    scalar(db, "SELECT current_database()") === "zeta",
    "still on zeta after a failed switch",
  );
}

// —— Case-insensitive: `USE ZETA` normalizes to the default ———————————————————
{
  type(db, "USE tenant_a");
  assert(db.database() === "tenant_a", "precondition: on tenant_a");
  const r = type(db, "USE ZETA");
  assert(!r.error, `USE ZETA errored: ${r.error}`);
  assert(db.database() === null, "USE ZETA (any case) normalizes to the default (null)");
}

console.log(
  `\nOK: switcher driver passed — ${checks} assertions across USE / SET database / RESET, ` +
    `unqualified resolution, cross-db qualified access, unknown-db error containment, and ZETA normalization, ` +
    `all through the real router + compiled wasm engine.`,
);
