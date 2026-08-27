# Agent Memory demo — zengram in the browser

A tiny agent with **persistent, semantic memory**, running entirely in a browser
tab. Tell it facts; ask it questions; it recalls the relevant memories by
*meaning*, not keywords. No server, no backend.

This is [zengram](https://github.com/genezhang/zengram)'s memory tier
(`remember` / `recall`) compiled to WebAssembly over the Zeta engine, with a real
sentence-embedding model (all-MiniLM-L6-v2) running in the same tab via
[Transformers.js](https://github.com/huggingface/transformers.js).

## Two pages, one bundle

zengram-lite is a **superset** — the same `.wasm` carries the full Zeta SQL engine
alongside the memory tier. This demo folder has two pages, both loading the one
`pkg-web/zengram_wasm.js`:

- **`index.html`** — the agent-memory demo (`remember` / `recall` by meaning).
- **`playground/index.html`** — the full in-browser SQL playground exercising
  `ZetaDb` directly: a CodeMirror editor, a psql-style command router (`\d`,
  `\dt`, `USE`/`RESET database`), OPFS snapshot save/restore, CSV export, and
  worked examples (DDL, bound `$1`/`$2` params, aggregates, CTEs, window
  functions, vectors, FTS, JSONB, PGQ graph, branching, concurrent SI
  transactions). It's the same playground shipped by
  [zeta-lite](https://github.com/genezhang/zeta-lite), running on this superset
  bundle — no second engine, no second download.

A page that needs both memory *and* SQL imports only zengram-lite, so the engine
loads exactly once.

## What it shows

- **Semantic recall.** Ask "what UI theme do I like?" and it recalls "prefers
  dark mode" — zero shared keywords. Real embeddings, real vector search.
- **Deterministic memory ops, live.** The sidebar is built from `mem.query()`
  (raw SQL over the `knowledge` table); 👍/👎 on each fact call `confirm(id)` /
  `contradict(id)` and the confidence/importance bars move, and **Decay** calls
  `decay(halfLifeDays)`. All no-model, no-embedder — pure database work.
- **Fully local.** The database (Zeta), the vector index (HNSW), and the
  embedding model all run in the browser. Nothing leaves the tab.
- **Concurrent-SI transactional store** underneath — the same engine as the
  [zeta-lite](https://github.com/genezhang/zeta-lite) SQL playground.

## Architecture

```
 index.html  (this demo — pure HTML/JS, no build step)
   ├─ ./pkg-web/zengram_wasm.js  ← the memory bundle (wasm + JS glue)
   │     └─ ZengramMemory: open / remember / recall / rememberWithVector /
   │         confirm / contradict / decay / factsAboutPeer / query / …
   └─ @huggingface/transformers  ← the embedding model (CDN)
```

The bundle is produced by the `zengram-wasm` glue crate, which links zengram's
memory tier to the Zeta wasm engine. That crate lives in the closed Zeta
monorepo (it links the full engine, like `zeta-wasm` does); this repo ships only
the **demo** and the recipe to build/fetch the bundle.

## Run it

The compiled bundle (`pkg-web/`, `pkg/`) is **not committed** — get it first:

**Maintainers (engine-source access):**
```bash
ZETA_REPO=/path/to/zeta ../scripts/build-from-source.sh
```

**Everyone else:** fetch the published bundle into `pkg-web/` and `pkg/`:
```bash
../scripts/fetch-artifact.sh        # from the repo root: ./scripts/fetch-artifact.sh
```

Then serve over HTTP (ES modules + wasm can't load from `file://`):
```bash
python3 -m http.server 8080     # or any static server
# open http://localhost:8080/index.html
```

Try: `I use dark mode`, `I drink green tea`, `I'm building a Rust project`, then
ask `what do you know about me?` or `what language am I using?`.

## Headless smoke tests (Node)

```bash
node smoke.mjs          # toy deterministic embedder (setEmbedFn path)
npm install @huggingface/transformers && node smoke_model.mjs   # real model (vector path)
```

`smoke_model.mjs` proves real semantic recall — queries with **zero keyword
overlap** with the stored facts still retrieve the right ones.

## The two embedding paths

`setEmbedFn` takes a **synchronous** `(text) => number[]` callback — good for a
lightweight or precomputed embedder. Real models are **async**, so for those use
the **bring-your-own-vector** API: embed in JS (await the model), then pass the
finished `Float32Array` to `rememberWithVector` / `recallWithVector`. This demo
uses the vector path with all-MiniLM-L6-v2.

## Status / limitations (v0.1)

- **Persistence works.** `exportSnapshot()` / `openFromSnapshot()` round-trip the
  whole database (including the `tsvector` FTS column) — store the blob in OPFS to
  survive a reload.
- **Deterministic ops are available** even without a model: `confirm(id)` /
  `contradict(id)` adjust a fact's confidence, `decay(halfLifeDays)` fades stale
  facts, `factsAboutPeer(peer, limit)` queries peer-attributed facts, and
  `query(sql, params)` runs raw SQL over the memory tables (ZetaDb's
  `{columns, rows}` shape).
- **Automatic fact extraction / reflection** are not wired yet — `remember` stores
  what you give it verbatim; it doesn't split prose into atomic facts (needs a
  completion-model callback). Embedding + recall are fully working.
