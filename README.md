# zengram-lite

**Agentic memory for AI agents, in the browser.** A WebAssembly build of the
**Zengram** memory framework over the embedded **Zeta** database engine. An agent
running in a browser tab can **remember** facts and **recall** them by meaning —
fully client-side, no server, no network.

> **Free to use, including commercially.** This repo is the public distribution
> mirror: the hand-authored demo plus the mechanics to fetch/run the published
> `.wasm`. The **Zengram framework** source is planned for open-source release
> under **Apache-2.0** (publication pending); the **Zeta engine** stays closed.
> The shipped `.wasm` links both, so it is distributed as a prebuilt binary. See
> [LICENSE](./LICENSE).

- **Semantic memory** — hybrid vector + full-text recall over a local store.
- **Superset bundle** — the same `.wasm` also carries the full
  [zeta-lite](https://github.com/genezhang/zeta-lite) SQL engine
  (`ZetaDb`/`ZetaTxn`/`ZetaCursor`). One engine, one download.
- **Bring your own model** — plug any embedder (Transformers.js, ORT-Web, a
  remote API); no model is bundled.
- **~2.9 MB gzipped** — the whole stack.

## What's in this repo

- `demo/` — three hand-authored browser pages on one wasm bundle: an
  **agent-memory** demo (remember/recall by meaning), a full **SQL playground**,
  and a **local AI agent** whose loop, tools, and memory all run in the tab (only
  LLM inference is a remote OpenAI-compatible call). `demo/pkg-web/` is
  **gitignored** — the compiled `.wasm` is fetched, not committed.
- `scripts/` — `fetch-artifact.sh` (pull the published wasm) and
  `build-from-source.sh` (rebuild from the monorepo; maintainers only).
- `docs/` — [API reference](./docs/api.md), [how the memory works](./docs/how-it-works.md), and [engine modes](./docs/engine-modes.md).
- `examples/` — [hello.mjs](./examples/hello.mjs), a minimal runnable tour of the memory tier (Node).
- `LICENSE` — Zengram Lite License (free for any use, including commercial; the
  compiled artifact is distributed, not itself open source).

**This repo does not contain the framework or engine source.** The compiled
`zengram_wasm_bg.wasm` is built in the monorepo (`crates/zengram-wasm`) and
attached to a **GitHub Release** (npm publication pending).

## Quick start — run the demo

```bash
# 1. Get the wasm artifact into demo/pkg-web/ from the GitHub Release (needs gh):
./scripts/fetch-artifact.sh            # latest release
# ./scripts/fetch-artifact.sh v0.1.0   # a specific release tag
#    Alternatives:
# ZENGRAM_LITE_PKG=/path/to/pkg-web ./scripts/fetch-artifact.sh   # a local build
# ZENGRAM_LITE_NPM=1 ./scripts/fetch-artifact.sh v0.1.0           # from npm (once published)

# 2. Serve the demo (any static server; wasm needs http://, not file://)
python3 -m http.server -d demo 8080
#   → open http://localhost:8080
```

## Use as a library (npm)

> **Status:** the `zengram-lite` npm package is pending publication (v0.1.0).
> Until then, the bundle comes from `scripts/build-from-source.sh` (needs the
> monorepo); `scripts/fetch-artifact.sh` works once the package is live.

```bash
npm install zengram-lite
```

Full method reference — every `ZengramMemory` / `ZetaDb` method with return
shapes: [docs/api.md](./docs/api.md).

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

v0.1 preview. In-memory engine; durability is snapshot-based. Embed, recall,
the deterministic ops (confirm/contradict/decay/factsAboutPeer/query), and the
agent surface (sessions/turns/tool calls/context assembly) are fully wired;
fact-extraction and reflection are bring-your-own-result — call your completion
model in JS, then hand the results to `extractWithFacts` / `reflectWithInsights`
(see [docs/api.md](./docs/api.md)).

The Zengram framework is planned for open-source release under **Apache-2.0**
(publication pending) — only the Zeta engine stays closed. The zengram-lite
`.wasm` is a prebuilt binary linking both (built from `zeta-wasm` +
`zengram-wasm` in the monorepo), so it is distributed as an artifact rather than
built from public source. Until the framework repo is public,
[docs/how-it-works.md](./docs/how-it-works.md) documents the memory tier's
behavior.

## License

[Zengram Lite License](./LICENSE) — free for commercial use; the framework and
engine source are not open. `THIRD-PARTY-NOTICES.txt` (shipped in the npm
package and fetched alongside the `.wasm`) lists the open-source crates linked
into the artifact.
