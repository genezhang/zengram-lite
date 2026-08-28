# zengram-lite — API reference

The JavaScript surface of the zengram-lite bundle: the **`ZengramMemory`**
agentic-memory tier plus the full **Zeta** SQL engine (`ZetaDb` / `ZetaTxn` /
`ZetaCursor`) re-exported from the same `.wasm`.

> **Authoritative types.** The bundle ships `zengram_wasm.d.ts` (wasm-bindgen
> output) next to the `.wasm` — that file is the machine-level truth and gives
> IDE autocomplete. This page is the human reference: what each method does,
> what it returns, and how the pieces fit.
>
> Items marked **⚠** are not exercised by this repo's demos or tests (they come
> from the README or the engine's documented surface) — verify them against the
> `.d.ts` before relying on them.

## Loading the bundle

Two build targets ship with the artifact:

| Target | Location | For | Import |
| --- | --- | --- | --- |
| **web** | `demo/pkg-web/` | browsers | `import init, { ZengramMemory, ZetaDb } from "./pkg-web/zengram_wasm.js"` — then `await init()` once before first use |
| **nodejs** | `demo/pkg/` | Node | `import { ZengramMemory } from "./pkg/zengram_wasm.js"` — no init step |

The web module is self-initializing: `init()` fetches and instantiates the
`.wasm`, which is why the demo must be served over `http://`, not `file://`.
`scripts/fetch-artifact.sh` populates `demo/pkg-web/` from the published
package; `scripts/build-from-source.sh` (maintainers) builds both targets.

All API methods below are **synchronous** — the only async part of a real
integration is computing embeddings in JS (see the bring-your-own-vector note
under *Remember / recall*).

## ZengramMemory

The memory tier. One instance = one database — its own, or shared with your
SQL (see [engine-modes.md](./engine-modes.md)).

### Construction

| Method | Returns | Notes |
| --- | --- | --- |
| `ZengramMemory.open(dim)` | `ZengramMemory` | Fresh, isolated in-memory database. `dim` = your embedding dimension. |
| `ZengramMemory.overEngine(db, dim)` | `ZengramMemory` | Memory over an existing `ZetaDb`'s engine — one wasm heap, one database. Migrations are idempotent; attaching twice (or over a restored snapshot) is safe. |
| `ZengramMemory.openFromSnapshot(bytes, dim)` | `ZengramMemory` | Rehydrate a database from `exportSnapshot()` bytes. |

`dim` must match your embedder's output dimension. Switching embedding models
changes the dimension and invalidates stored vectors — the browser agent
resets memory in that case (`demo/agent/index.html`).

### Embedder

| Method | Notes |
| --- | --- |
| `mem.setEmbedFn(fn, dim)` | Register a **synchronous** embedder `fn: (text: string) => number[]`. Used by `remember` / `recall`. Real models are async — embed in JS and use the `…WithVector` methods instead. |

### Remember / recall

| Method | Returns |
| --- | --- |
| `mem.remember(subject, content, scope)` | knowledge id (`string`) |
| `mem.recall(query, scope)` | `Hit[]` ranked by meaning |
| `mem.rememberWithVector(subject, content, scope, vec)` | knowledge id — `vec: Float32Array` of length `dim` |
| `mem.recallWithVector(query, scope, vec)` | `Hit[]` |

`Hit` shape (as used by the demos):

```js
{
  knowledgeId: string,   // pass to confirm() / contradict()
  subject: string,
  content: string,
  score: number,         // similarity — higher is closer
  importance: number,
}
```

Notes:

- `scope` is a free-form namespace string (e.g. `"agent/session-42"`); recall
  only sees facts stored in the scope you pass.
- Facts with the **same subject** in a scope are treated as updates
  (supersede/dedup), not duplicates — store distinct subjects for distinct
  facts (see `demo/smoke.mjs`).
- `remember` / `recall` embed `"subject: content"` / the query with the
  registered embedder. The `…WithVector` pair takes finished vectors, which is
  how async models (Transformers.js, ORT-Web, a remote `/v1/embeddings` API)
  plug in — see `demo/smoke_model.mjs` and `examples/hello.mjs`.

### Deterministic ops (no model needed)

Pure database work — they run even before you wire an embedder.

| Method | Returns | Effect |
| --- | --- | --- |
| `mem.ensureProject(scope)` | project id (`string`) | Ensure a project row exists for `scope` (optional — `remember` works without it). |
| `mem.confirm(id)` | — | Fact seen/validated again → raise its confidence. |
| `mem.contradict(id)` | — | Fact was wrong → lower its confidence. |
| `mem.decay(halfLifeDays)` | `number` (facts updated) | Exponential importance decay with the given half-life; charges only the time since each fact's last decay. |
| `mem.factsAboutPeer(peer, limit)` | facts ⚠ | Facts attributed to a peer (e.g. `"peer-dana"`), most important first. Element shape follows the knowledge row — check the `.d.ts`. |
| `mem.query(sql, params?)` | `{ columns, rows }` | Raw SQL over the memory database, same shape as `ZetaDb.query`. Positional `$1`/`$2` binds; a write takes effect but returns an empty `rows` array. Prefer the typed methods for mutation — writing the framework's tables directly can break its invariants. |

### Persistence

| Method | Returns |
| --- | --- |
| `mem.exportSnapshot()` | `Uint8Array` — the whole database (in shared mode: your SQL tables too) |

Round-trip with `ZengramMemory.openFromSnapshot(bytes, dim)`. There is no
incremental-save API — each save is O(database size). The browser agent
(`demo/agent/index.html`) shows the production pattern: dirty-flag (only
memory-writing turns mark dirty), ~60 s throttle (a run of remembers coalesces
into one save), flush-on-hide/close.

## ZetaDb

The embedded Zeta SQL engine — the same surface zeta-lite ships. zengram-lite
re-exports it so a page needing memory *and* SQL loads one engine, not two.

Statement kind is split across three methods — there is **no single
`exec(sql)`**:

| Method | For | Returns |
| --- | --- | --- |
| `db.query(sql, params?)` | reads: `SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `VALUES`, `TABLE`, and `INSERT/UPDATE/DELETE … RETURNING` | `{ columns: string[], rows: object[] }` |
| `db.execMut(sql, params?)` | `INSERT` / `UPDATE` / `DELETE` (without `RETURNING`) | affected-row count (`number`) |
| `db.execDdl(sql)` | `CREATE` / `DROP` / `ALTER` / `TRUNCATE` / … | — |

Positional `$1`/`$2` binds in `query` / `execMut`.

| Method | Returns | Notes |
| --- | --- | --- |
| `ZetaDb.open()` | `ZetaDb` | Fresh in-memory database. |
| `ZetaDb.openFromSnapshot(bytes)` | `ZetaDb` | Rehydrate from `exportSnapshot()`. |
| `db.begin()` | `ZetaTxn` | Explicit snapshot-isolated transaction. |
| `db.exportSnapshot()` | `Uint8Array` | Whole database. |
| `db.databases()` | `string[]` | Databases in the catalog (logical namespaces over the one shared catalog — see the playground's *Multi-database* example). |
| `db.database()` | `string \| null` | Current database; `null` = the system default (`"zeta"`). |
| `db.setDatabase(name \| null)` | — | Switch the current database. The embedded SQL path has no `USE` statement, so this is the only way. |
| `db.branch()` | `string \| null` | Active copy-on-write branch; `null` = main. |
| `db.setBranch(name \| null)` | — | Switch branches. The embedded SQL path rejects `SET zeta_branch`, so this is the only way. |
| `db.schema()` | `{ tables: [{ name, columns: [{ name, type, pk, nullable }] }] }` | Catalog introspection (no `information_schema` in this build). Lists **all** databases' tables — it does not yet filter by the current database. |
| `db.setEmbedFn(fn, dims)` | — | Register a JS embedder for the SQL `embed()` function. |

The SQL *language* itself (types, FTS, vectors, JSONB, PGQ, branching, …) is
documented in the **zeta-lite** repo's `docs/sql_reference.md` — the
playground in this repo is a copy of zeta-lite's, running on this superset
bundle.

## ZetaTxn

Returned by `db.begin()`. Same method names as `ZetaDb` for the statement
paths, plus transaction control:

| Method | Returns |
| --- | --- |
| `txn.query(sql, params?)` | `{ columns, rows }` |
| `txn.execMut(sql, params?)` | affected-row count |
| `txn.commit()` | — |
| `txn.rollback()` ⚠ | — |

Transactions are snapshot-isolated and concurrent — see the playground's
*Concurrent transactions* panel and `demo/playground/playground_validate.mjs`.

## ZetaCursor

⚠ Advertised as part of the superset bundle (README), but not exercised by any
demo or test in this repo. Check the `.d.ts` for its shape.

## In the bundle, not yet exposed

The `zengram-mem` *lite* build compiles more of the framework into the
`.wasm` than the JS surface above currently exposes: sessions/turns/tool
calls, episodic memory, provenance, the event log, reminders, permissions,
token-budgeted context assembly, knowledge extraction/reflection, and
in-browser memory branching. Today those tables are reachable only by
inspecting them with `query()` — a wider JS surface is planned. (Fleet
coordination, pgwire, and OKF ingest are excluded from the browser build by
design: they belong server-side and pull native dependencies.)

## Result shapes

```js
// query() results
{ columns: ["subject", "content"], rows: [{ subject: "…", content: "…" }] }
```

Rows are plain objects keyed by column name. (The demos coerce with `Number()`
where they do arithmetic — probe a value if you need the exact JS type.)
