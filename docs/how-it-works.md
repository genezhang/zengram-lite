# How the memory works

The behavioral contract of zengram-lite's memory tier — what it stores, how it
ranks, and what each operation does — without engine internals. For method
signatures, see [api.md](./api.md); for own-vs-shared engine, see
[engine-modes.md](./engine-modes.md).

## What a memory is

A **fact** is a row in the framework's `knowledge` table:

| Column | Meaning |
| --- | --- |
| `id` | knowledge id — returned by `remember`, used by `confirm` / `contradict` |
| `subject` | short label (e.g. `"editor prefs"`) |
| `content` | the fact, in a sentence |
| `scope` | namespace string (e.g. `"agent/session-42"`) — recall is scoped |
| `confidence` | 0..1 — how well-validated the fact is |
| `importance` | 0..1 — how much the fact matters; decays over time |
| `status` | lifecycle state; the demos filter on `status = 'active'` |
| `time_updated` | last update — drives decay |
| `times_confirmed` / `times_contradicted` | counters behind 👍 / 👎 |

(The columns above are the ones the demos query. The framework also reserves
other tables in the catalog — `event_log`, `embedding`, `session`, `turn`,
`tool_call`, `provenance`, `reminder`, `permission`, `episodic`, plus the
migration bookkeeping table `_zengram_migrations` — see
[engine-modes.md](./engine-modes.md). In the SQL playground, the
**🧠 Memory tables** button attaches the framework to the playground's
database so you can inspect all of them.)

## Remember

`remember(subject, content, scope)` embeds the fact (as `"subject: content"`)
and stores it; it returns the knowledge id. Async models use
`rememberWithVector` with a finished vector instead.

Facts with the **same subject** in a scope are treated as updates
(supersede/dedup), not duplicates — store distinct subjects for distinct facts.

`remember` stores what you give it **verbatim**: v0.1 does not split prose
into atomic facts (automatic fact-extraction is a stub pending a
completion-model callback).

## Recall

`recall(query, scope)` runs a **hybrid vector + full-text** search over the
scope's facts and returns them ranked by meaning — a query with zero keyword
overlap with a stored fact still retrieves it (that's the point of the
embeddings; `demo/smoke_model.mjs` proves it with real all-MiniLM vectors).
Each hit carries a `score` (similarity) and the fact's `importance`.

## Confidence, importance, decay

The deterministic ops adjust a fact's standing — no embedder or model needed:

- **`confirm(id)`** — the fact was seen/validated again → confidence goes up.
- **`contradict(id)`** — the fact was wrong → confidence goes down.
- **`decay(halfLifeDays)`** — importance decays exponentially with the given
  half-life, charging only the time since each fact's last decay; returns the
  number of facts updated. Use it to bound memory over months.

The agent-memory demo's sidebar is a live view of exactly this: `mem.query()`
reads the `knowledge` table, 👍/👎 call `confirm` / `contradict`, and the
**Decay** button calls `decay(7)`.

## Persistence

Durability is **snapshot-based**: `exportSnapshot()` serializes the whole
database to a `Uint8Array`; `openFromSnapshot(bytes, dim)` rehydrates it.
There is no incremental-save API — each save is O(database size). The browser
agent (`demo/agent/index.html`) shows the production pattern: dirty-flag (only
memory-writing turns mark dirty), ~60 s throttle (a run of remembers coalesces
into one save), and flush-on-hide/close.

Snapshots are origin-agnostic bytes — store them in OPFS, IndexedDB, or ship
them wherever. In shared-engine mode a snapshot includes your SQL tables too,
since they are one database.

## What's stubbed in v0.1

- **Automatic fact-extraction** — `remember` stores verbatim; it won't split
  prose into atomic facts until a completion-model callback is wired.
- **Reflection** — not wired yet.
- Everything else in [api.md](./api.md) is fully functional.

## Source availability

The **Zengram framework** (the memory tier) is intended to be open-sourced;
the **Zeta engine** remains closed. Until the framework repo is public, this
document plus [api.md](./api.md) are the behavioral reference for what the
memory tier does.
