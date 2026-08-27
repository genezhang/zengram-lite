# zengram-lite

**Agentic memory for AI agents, in the browser.** A WebAssembly build of the
[Zengram](https://github.com/genezhang/zengram) memory framework over the
embedded [Zeta](https://github.com/genezhang/zeta) database engine. An agent
running in a browser tab can **remember** facts and **recall** them by meaning —
fully client-side, no server, no network.

> **Free to use, including commercially — but not open source.** This repo is the
> public distribution mirror: the hand-authored demo plus the mechanics to
> fetch/run the published `.wasm`. The framework and engine source live in
> separate closed repositories. See [LICENSE](./LICENSE).

- **Semantic memory** — hybrid vector + full-text recall over a local store.
- **Superset bundle** — the same `.wasm` also carries the full
  [zeta-lite](https://github.com/genezhang/zeta-lite) SQL engine
  (`ZetaDb`/`ZetaTxn`/`ZetaCursor`). One engine, one download.
- **Bring your own model** — plug any embedder (Transformers.js, ORT-Web, a
  remote API); no model is bundled.
- **~2.9 MB gzipped** — the whole stack.

## What's in this repo

- `demo/` — a tiny browser agent that remembers facts you tell it and recalls
  them by meaning (hand-authored HTML + JS). `demo/pkg-web/` is **gitignored** —
  the compiled `.wasm` is fetched, not committed.
- `scripts/` — `fetch-artifact.sh` (pull the published wasm) and
  `build-from-source.sh` (rebuild from the monorepo; maintainers only).
- `docs/` — engine modes and preview notes.
- `LICENSE` — Zengram Lite License (free commercial use; not open source).

**This repo does not contain the framework or engine source.** The compiled
`zengram_wasm_bg.wasm` is built in the monorepo (`crates/zengram-wasm`) and
published to npm / GitHub Releases.

## Quick start — run the demo

```bash
# 1. Fetch the published wasm artifact into demo/pkg-web/
./scripts/fetch-artifact.sh            # latest published npm version
# ./scripts/fetch-artifact.sh v0.1.0   # a specific release tag

# 2. Serve the demo (any static server; wasm needs http://, not file://)
python3 -m http.server -d demo 8080
#   → open http://localhost:8080
```

## Use as a library (npm)

```bash
npm install zengram-lite
```

```js
import { ZengramMemory } from "zengram-lite";

const mem = ZengramMemory.open(384);                 // your embedding dimension
mem.setEmbedFn((text) => myModel.encodeSync(text), 384);   // sync embedder

const scope = "agent/session-42";
mem.remember("preferences", "the user prefers dark mode", scope);
const hits = mem.recall("what UI theme do they like?", scope);
// -> [{ knowledgeId, subject, content, score, importance }, …]  ranked by meaning
```

Real (async) models — compute the vector in JS and hand it in:

```js
const v = new Float32Array((await extractor(text, { pooling: "mean", normalize: true })).data);
mem.rememberWithVector("preferences", "prefers dark mode", scope, v);
const hits = mem.recallWithVector(query, scope, qv);
```

## Two engine modes

Memory stores into a Zeta engine. You choose whether it gets its own or shares
one with your app's SQL — see [docs/engine-modes.md](./docs/engine-modes.md).

**Own engine (isolated):**

```js
const mem = ZengramMemory.open(384);   // fresh, isolated in-memory database
```

**Shared engine (one database):**

```js
import { ZetaDb, ZengramMemory } from "zengram-lite";

const db = ZetaDb.open();                        // your app's SQL database
const mem = ZengramMemory.overEngine(db, 384);   // memory over the SAME engine
```

One wasm heap, one database — your SQL tables and the agent's memory in the same
catalog. In shared mode, avoid app table names that collide with memory's
reserved names (see the engine-modes doc).

## Deterministic memory ops (no model needed)

Beyond `remember`/`recall`, a few operations are pure database work — no embedder
or completion model — so they run anywhere, even before you wire a model:

```js
mem.confirm(knowledgeId);          // saw this again → raise its confidence
mem.contradict(knowledgeId);       // this was wrong → lower its confidence
const n = mem.decay(30);           // half-life (days): let stale facts fade; returns count updated
const facts = mem.factsAboutPeer("peer-dana", 10);  // facts attributed to a peer, most important first

// Escape hatch: raw SQL over the memory database, same shape as ZetaDb.query
const r = mem.query("SELECT subject, content FROM knowledge WHERE scope = $1", ["agent/session-42"]);
// r = { columns: [...], rows: [{ subject, content }, …] }
```

`query` runs any statement ($1/$2 positional binds); a write takes effect but
returns an empty `rows` array. Use the typed methods above for mutation — writing
memory's own tables directly can break the tier's invariants.

## zeta-lite vs zengram-lite

- Import **[zeta-lite](https://github.com/genezhang/zeta-lite)** for SQL-only
  pages — the lean engine (~2.8 MB gz).
- Import **zengram-lite** when you need agent memory — it re-exports the full
  `ZetaDb`/`ZetaTxn`/`ZetaCursor` API **plus** `ZengramMemory` from one `.wasm`,
  one engine (~2.9 MB gz).

A page needing both imports **only** zengram-lite, so the Zeta engine loads
exactly once — never two engines in one tab.

## Persistence (OPFS)

Snapshot the whole database (SQL + memory) to a byte blob and rehydrate later:

```js
const blob = mem.exportSnapshot();                 // Uint8Array → store in OPFS
const mem2 = ZengramMemory.openFromSnapshot(blob, 384);
```

## Status & limitations

v0.1 preview. In-memory engine; durability is snapshot-based. Embed, recall, and
the deterministic ops (confirm/contradict/decay/factsAboutPeer/query) are fully
wired; automatic fact-extraction and reflection are stubs pending a
completion-model callback. Single database per engine.

## License

[Zengram Lite License](./LICENSE) — free for commercial use; the framework and
engine source are not open. `THIRD-PARTY-NOTICES.txt` (shipped in the npm
package and fetched alongside the `.wasm`) lists the open-source crates linked
into the artifact.
