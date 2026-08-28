# zengram-lite — API reference

The JavaScript surface of the zengram-lite bundle: the **`ZengramMemory`**
agentic-memory tier plus the full **Zeta** SQL engine (`ZetaDb` / `ZetaTxn` /
`ZetaCursor`) re-exported from the same `.wasm`.

> **Authoritative types.** The bundle ships `zengram_wasm.d.ts` (wasm-bindgen
> output) next to the `.wasm` — that file is the machine-level truth and gives
> IDE autocomplete. This page is the human reference: what each method does,
> what it returns, and how the pieces fit.
>
> Every method on this page has been exercised against the current build
> (the demos, the smoke tests, or direct probes). If a future build changes
> behavior, the `.d.ts` is the first place to look.

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
| `mem.factsAboutPeer(peer, limit)` | `[{ id, scope, subject, content, importance }]` | Active facts attributed to a peer (e.g. `"peer-dana"`), most important first; `[]` when none. Attribution lives in `knowledge.subject_peer` — `remember()` has no peer parameter in v0.1, so set it with `query()` (`UPDATE knowledge SET subject_peer = $1 WHERE id = $2`). |
| `mem.query(sql, params?)` | `{ columns, rows }` | Raw SQL over the memory database, same shape as `ZetaDb.query`. Positional `$1`/`$2` binds; a write takes effect but returns an empty `rows` array. Prefer the typed methods for mutation — writing the framework's tables directly can break its invariants. |

### Agent surface (sessions, turns, tool calls, context)

The framework's core layer tracks the agent's conversation itself — not just
the knowledge it derives. These methods expose that layer, so a browser agent
can run its whole loop in the bundle: record the conversation, assemble the
next prompt under a token budget, call its LLM, record tool calls, and store
what it learned.

**Sessions & turns**

| Method | Returns | Notes |
| --- | --- | --- |
| `mem.createSession(projectId, opts?)` | `{ sessionId, branchId }` | Ensure the project row and create a session with its trunk branch. `opts`: `{ title, agent, modelId, providerId, channelType }` — all optional. |
| `mem.appendTurn(sessionId, branchId, role, opts?)` | turn id | `role`: `"user"` \| `"assistant"`. `opts`: `{ agent, parentTurnId }`. |
| `mem.addPart(turnId, sessionId, partType, data, position)` | part id | A part is an atomic content unit of a turn. `data` is any JSON value (e.g. `{ text: "…" }` for a text part, `{ toolCallId }` for a tool part). |
| `mem.completeTurn(turnId, tokensIn, tokensOut, costUsd, finishReason)` | — | Record token counts + finish reason. |
| `mem.getTurns(sessionId, branchId, limit, offset)` | `Turn[]` | Oldest first. `Turn`: `{ id, role, agent, status, tier, tokensInput, tokensOutput, costUsd, finishReason, summary, timeCreated, timeCompleted }`. |
| `mem.getParts(turnId)` | `Part[]` | In position order. `Part`: `{ id, type, data, position, timeCreated }`. |

**Tool calls**

| Method | Returns | Notes |
| --- | --- | --- |
| `mem.recordToolCall(opts)` | tool-call id | `opts`: `{ turnId, partId, sessionId, toolId, input?, category?, targetPaths? }`. Starts in `pending` state. |
| `mem.completeToolCall(toolCallId, opts?)` | — | `opts`: `{ output, error, durationMs, tokensConsumed }` — all optional. Setting `error` marks the call `error`; otherwise `completed`. |
| `mem.queryToolCalls(sessionId, opts?)` | `ToolCall[]` | Newest first. `opts`: `{ toolId, category, state, limit }` — `state`: `"pending"` \| `"running"` \| `"completed"` \| `"error"`. |

**Context assembly**

| Method | Returns | Notes |
| --- | --- | --- |
| `mem.assembleContext(sessionId, branchId, budget, opts?)` | `ContextWindow` | The framework's 6-phase prompt assembly (system → permission rules → knowledge → tasks → hot/warm/cold history → cross-branch summaries → pending state) under a token `budget`. `opts` (fractions of the budget, all optional): `{ knowledgeBudgetPct, taskBudgetPct, crossBranchBudgetPct, reservePct, hotBudgetPct }`. |
| `mem.enforceBudget(scope)` | `{ sessionsPruned, bytesFreed }` \| `null` | Prune oldest sessions if the scope is over its configured storage budget; `null` when no budget is configured or the scope is under it. |

`ContextWindow` shape:

```js
{
  blocks: [{ type, content, tokenCount, sourceIds }],
  // type: "system" | "permissionRules" | "knowledge" | "tasks" | "turn" | "branchSummary" | "pending"
  totalTokens: number,
  budget: number,
  turnsIncluded: number,
  turnsSummarized: number,
  turnsSkipped: number,
  knowledgeFingerprint: string,  // stable for an unchanged knowledge set — reuse signal for prompt prefixes / KV caches
}
```

The knowledge phase reads the session's **project scope**
(`/project/{projectId}`) plus the root scope (`/`), so store agent knowledge
there (or in `/`) to have it injected.

**Bring-your-own-result LLM bridges**

The framework's automatic knowledge extraction and reflection call an LLM. In
the browser the completion model lives in JS (async), so the surface uses a
sync **bring-your-own-result** pattern — the same seam as
`rememberWithVector`: call your model, hand the finished results in, and the
framework runs its normal code paths (dedup, supersession, embedding via
`setEmbedFn`, provenance).

| Method | Returns | Notes |
| --- | --- | --- |
| `mem.extractWithFacts(turnText, scope, sessionId, turnId, facts)` | knowledge ids (`string[]`) | `facts`: `[{ subject, content, categories? }]` — the atomic facts your LLM extracted from `turnText`. Each fact is embedded via `setEmbedFn` (must be registered) and stored with session/turn provenance. |
| `mem.reflectWithInsights(scope, insights, limit)` | knowledge ids (`string[]`) | `insights`: `[{ subject, content, sourceIds? }]` — insights your LLM synthesized over the scope's knowledge. `limit` bounds how many recent knowledge entries the framework fetches first. No-op (empty array) when the scope has no active knowledge. |

A full tour of this surface: `demo/smoke_agent.mjs`.

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
| `db.stream(sql, params?)` | `ZetaCursor` | Bounded streaming cursor — memory is O(batch), not O(result). See *ZetaCursor*. |
| `db.exportSnapshot()` | `Uint8Array` | Whole database. |
| `db.checkpoint()` | — | Force a durable checkpoint. **No-op in the browser build** (in-memory backend) — use `exportSnapshot` there; it flushes committed rows on the server-side persistence path. |
| `db.databases()` | `string[]` | Databases in the catalog (logical namespaces over the one shared catalog — see the playground's *Multi-database* example). |
| `db.database()` | `string \| null` | Current database; `null` = the system default (`"zeta"`). |
| `db.setDatabase(name \| null)` | — | Switch the current database. The embedded SQL path has no `USE` statement, so this is the only way. |
| `db.branch()` | `string \| null` | Active copy-on-write branch; `null` = main. |
| `db.setBranch(name \| null)` | — | Switch branches. The embedded SQL path rejects `SET zeta_branch`, so this is the only way. |
| `db.schema()` | `{ tables: [{ name, columns: [{ name, type, pk, nullable }] }] }` | Catalog introspection (no `information_schema` in this build). Lists **all** databases' tables — it does not yet filter by the current database. |
| `db.setEmbedFn(fn, dims)` | — | Register a JS embedder for the SQL `embed()` function. |

Every handle (`ZetaDb`, `ZetaTxn`, `ZetaCursor`, `ZengramMemory`) also has a
`free()` for explicit early release — optional; GC reclaims them otherwise.

The SQL *language* itself (types, FTS, vectors, JSONB, PGQ, branching, …) is
documented in the **zeta-lite** repo's `docs/sql_reference.md` — the
playground in this repo is a copy of zeta-lite's, running on this superset
bundle.

## ZetaTxn

Returned by `db.begin()`. Same statement methods as `ZetaDb`, plus
transaction control:

| Method | Returns | Notes |
| --- | --- | --- |
| `txn.query(sql, params?)` | `{ columns, rows }` | |
| `txn.execMut(sql, params?)` | affected-row count | |
| `txn.execDdl(sql)` | — | |
| `txn.commit()` | — | A second commit/rollback throws (`transaction already finished`). |
| `txn.rollback()` | — | Discards everything the txn wrote; the pre-txn state is intact. |
| `txn.savepoint(name)` | — | Establish a named savepoint. |
| `txn.rollbackToSavepoint(name)` | — | Undo back to the savepoint, keeping it. |
| `txn.releaseSavepoint(name)` | — | Release the savepoint without rolling back. |

Transactions are snapshot-isolated and concurrent — see the playground's
*Concurrent transactions* panel and `demo/playground/playground_validate.mjs`.
An uncommitted txn rolls back on drop.

## ZetaCursor

Returned by `db.stream(sql, params?)` — a bounded streaming cursor over a
query result (memory is O(batch), not O(result)):

| Method | Returns | Notes |
| --- | --- | --- |
| `cur.columns()` | `string[]` | Column names. |
| `cur.next()` | row object \| `null` | Pulls the next row as `{ col: value, … }`; `null` at end of stream (keeps returning `null` past the end). |
| `cur.free()` | — | Release early. Also `[Symbol.dispose]` for `using`/auto-cleanup. |

## In the bundle, not yet exposed

The `zengram-mem` *lite* build compiles more of the framework into the
`.wasm` than the JS surface above currently exposes: episodic timelines
(`session_timeline`, `turns_since`, …), provenance tracing (`traceBack` /
`traceForward`), the event log, reminders, permission rules, turn
summarization, and in-browser memory branching (`fork` / `merge` /
`rebase`). Today those are reachable only by inspecting their tables with
`query()` — a wider JS surface is planned. (Fleet coordination, pgwire, and
OKF ingest are excluded from the browser build by design: they belong
server-side and pull native dependencies.)

## Result shapes

```js
// query() results
{ columns: ["subject", "content"], rows: [{ subject: "…", content: "…" }] }
```

Rows are plain objects keyed by column name. (The demos coerce with `Number()`
where they do arithmetic — probe a value if you need the exact JS type.)
