# Agent Memory demo — zengram in the browser

A tiny agent with **persistent, semantic memory**, running entirely in a browser
tab. Tell it facts; ask it questions; it recalls the relevant memories by
*meaning*, not keywords. No server, no backend.

This is **zengram**'s memory tier
(`remember` / `recall`) compiled to WebAssembly over the Zeta engine, with a real
sentence-embedding model (all-MiniLM-L6-v2) running in the same tab via
[Transformers.js](https://github.com/huggingface/transformers.js).

## Docs

- [API reference](../docs/api.md) — every `ZengramMemory` / `ZetaDb` method, with return shapes.
- [How the memory works](../docs/how-it-works.md) — the knowledge model, recall, confidence/decay, persistence.
- [Engine modes](../docs/engine-modes.md) — own vs shared engine, reserved table names.
- [examples/hello.mjs](../examples/hello.mjs) — minimal runnable tour (Node).

## Three pages, one bundle

zengram-lite is a **superset** — the same `.wasm` carries the full Zeta SQL engine
alongside the memory tier. This demo folder has three pages, all loading the one
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
- **`agent/index.html`** — a **local AI agent** running entirely in the tab: the
  agent loop, its tools (memory, files, web fetch), and its memory are all local;
  only LLM inference is a remote call to an OpenAI-compatible endpoint you
  configure. See the "Local agent" section below.

A page that needs memory *and* SQL imports only zengram-lite, so the engine
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
node smoke.mjs          # memory core + engine surface: txn/rollback/savepoints/streaming (toy embedder)
node smoke_agent.mjs    # agent surface: sessions/turns/tool calls/context/LLM bridges
npm install @huggingface/transformers && node smoke_model.mjs   # real model (vector path)
```

`smoke_agent.mjs` walks the full agent loop — `createSession` →
`appendTurn`/`addPart` → `recordToolCall`/`completeToolCall` →
`assembleContext` → `extractWithFacts` → `reflectWithInsights` — against the
nodejs bundle (27 checks). `smoke_model.mjs` proves real semantic recall —
queries with **zero keyword overlap** with the stored facts still retrieve the
right ones.

## Headless browser E2E (Playwright)

`e2e_ops.mjs` drives the **real page** in headless Chromium — the DOM path the
Node smokes can't reach. It types facts into the form, clicks 👍/👎
(`confirm`/`contradict`) and **Decay**, and asserts the confidence bars move.

```bash
npm install                        # installs playwright (devDependency)
npx playwright install chromium
../scripts/fetch-artifact.sh       # populate pkg-web/ (or build-from-source.sh)
npm run e2e                        # from the repo root  (or: node e2e_ops.mjs here)
```

It stubs the CDN embedding model with a deterministic vector, so it runs offline
and fast (the ops under test need no model). It **skips cleanly** (exit 0) if
Playwright or the wasm bundle isn't present — which is why CI can run it before
a fetchable artifact exists. Set `E2E_SHOT=out.png` to save a screenshot.

## Local agent (`agent/index.html`)

A working AI agent that runs **entirely in the browser tab**. The agent *loop*,
its *tools*, and its *memory* are all local; only the language model is remote.

- **Brain** — any **OpenAI-compatible** `/v1` endpoint you configure: llama.cpp
  `llama-server` (`:8080/v1`), LM Studio (`:1234/v1`), OpenAI, or a proxy. One
  adapter (`llm.mjs`) talks to all of them. Embeddings default to the *same*
  endpoint (`/v1/embeddings`); the page probes the dimension at boot and opens
  memory at it. If your chat server can't also serve embeddings (see below), set
  an optional **Embed base URL** to a second server.
- **Tools** (`tools.mjs`) — memory (`remember`/`recall`/`confirm`/`contradict`/
  read-only `query`), files (`readFile`/`writeFile`/`listFiles`/`deleteFile` over
  OPFS), and `webFetch`. The agent's memory and files are exactly zengram-lite +
  OPFS — the persistence layer of a browser agent.
- **The loop** (`agent.mjs`) — ask the model what to do, run the tools it calls,
  feed results back, repeat until it answers. The transcript shows each tool call
  and result inline, so you watch the agent think.

Memory persists across reloads (snapshotted to OPFS each turn). The modules are
plain JS with dependency injection, so the loop and tools are unit-tested in Node
(`agent.test.mjs`, `tools.test.mjs`) with no wasm or network.

## Try it: a 5-minute walkthrough

### 1. Start a local LLM (two llama.cpp servers)

The agent needs **two** models: a chat/tool-calling model (the brain) and an
embedding model (for memory vectors). LM Studio and OpenAI serve both from one
endpoint; **llama.cpp** loads one model per process, so run two `llama-server`
processes on two ports:

```bash
# terminal 1 — chat / tool-calling model on :8080
llama-server -m ~/models/Qwen3-8B-Q4_K_M.gguf \
  --port 8080 --jinja                 # --jinja drives the model's chat template
                                      # (tool-call parsing); default-on in recent
                                      # builds, pass it to be sure

# terminal 2 — embedding model on :8081
llama-server -m ~/models/Qwen3-Embedding-0.6B-Q8_0.gguf \
  --embeddings --port 8081
```

Notes:
- **CORS**: recent `llama-server` builds default `--cors-origins '*'`, so the
  browser can call them as-is. If Connect fails with "Could not reach…", add
  `--cors-origins '*'` to both.
- **Tool-calling**: `--jinja` makes the chat server apply the model's Jinja chat
  template so it emits OpenAI `tool_calls` (it's default-on in recent builds). A
  capable chat model (7B+ instruct, e.g. Qwen3) is far more reliable at
  tool-calling than a tiny one.
- **Models**: get GGUFs from Hugging Face — search e.g. `Qwen3-8B-GGUF` and
  `Qwen3-Embedding-0.6B-GGUF`. Any OpenAI-compatible chat + embedding pair works
  (nomic-embed-text, bge-*, all-MiniLM, …); the page probes the embed dimension
  at boot, so you don't hard-code it.

`llama-server` is [llama.cpp](https://github.com/ggml-org/llama.cpp)'s built-in
server. LM Studio users: load a chat model, enable the server + CORS, and leave
**Embed base URL** blank (one endpoint serves both).

### 2. Serve the demo and open the agent

The page must be served over HTTP (ES modules + OPFS don't work from `file://`):

```bash
../scripts/fetch-artifact.sh    # or build-from-source.sh — populate pkg-web/
python3 -m http.server 8137     # run from the demo/ directory
```

Open **http://localhost:8137/agent/index.html**.

### 3. Connect

In the sidebar's **LLM endpoint** panel:

| Field           | Value                        |
| --------------- | ---------------------------- |
| Base URL        | `http://localhost:8080/v1`   |
| Chat model      | `local-model` (llama.cpp serves its one loaded model regardless of name) |
| Embed model     | `local-embed`                |
| Embed base URL  | `http://localhost:8081/v1` ← the two-server field |
| API key         | *(blank for local)*          |

Click **Connect**. The status turns green: `ready · embed dim 1024` (or whatever
your embed model's dimension is — that number confirms the probe worked).

### 4. Test memory + embeddings

Store a few facts (each renders a `🔧 remember(...)` step and a sidebar card):

> remember that I prefer dark mode in my editor
> remember that I drink green tea every morning
> remember that my favorite language is Rust

Now recall by **meaning** — ask questions that share **no keywords** with what you
stored. If it still finds them, that's real vector search, not text matching:

> what hot beverage do I like?        → recalls the green-tea fact
> what are my UI preferences?         → recalls dark mode
> which language do I code in?        → recalls Rust

Then probe for a fact you never stored — a good agent says it doesn't know rather
than inventing one (recall returned only low-similarity hits):

> what car do I drive?

Expand a `🔧 recall(...)` step to see the ranked hits with `[id=…, score=0.xx]` —
those scores are the embedding similarities. Tell it a recalled fact is right or
wrong and it calls `confirm(id)` / `contradict(id)`, nudging the confidence bar.

### 5. Persistence — memory survives a full shutdown

When memory changes, the agent snapshots it to an OPFS file (`agent-mem.zeta`) —
see `persist()` / `flushNow()` in `index.html`. Two things keep the write cost
low without losing data:

- **Read-only turns don't write.** A `remember`/`confirm`/`contradict` marks
  memory dirty; a turn that only recalls or answers never re-saves.
- **Writes are throttled (~60 s) and flushed on close.** A run of new facts
  coalesces into one save instead of one-per-turn. When the tab is hidden or
  closing (`visibilitychange` / `beforeunload`), any pending save is flushed — so
  a clean quit loses nothing, and a hard crash (kill / power loss) loses at most
  one throttle window (~60 s) of facts.

Each save rewrites the whole snapshot (the wasm layer exposes `exportSnapshot` /
`openFromSnapshot`, not an incremental delta), so size grows with the number of
**remembered facts** — not with conversation length, which isn't stored. At a few
KB per fact (mostly the embedding vector) this is negligible for personal use;
`decay(halfLifeDays)` can fade stale facts to bound it over months. To see
persistence work:

1. Store a few facts.
2. **Fully quit the browser** (not just the tab).
3. Reopen **http://localhost:8137/agent/index.html** → the sidebar repopulates;
   ask *"what do you know about me?"* and it recalls everything.

Caveat: OPFS is **origin-scoped** browser storage. Same URL (scheme + host +
port) → your memory is there. A different port, a different browser/profile, or
"clear site data" starts fresh. It's sandboxed browser storage, not a file on
disk — though `exportSnapshot()` hands you the bytes if you want to keep a copy.

### 6. Web fetch — a browser reality

`webFetch` runs *in the tab*, so it's a cross-origin request bound by the target
site's CORS policy:

- **Public, CORS-enabled APIs work first try** — e.g.
  *"fetch https://api.github.com/repos/ggml-org/llama.cpp and tell me the description"*.
- **Most websites send no CORS headers** → the browser blocks the response and no
  retry helps. Reading arbitrary sites needs a local CORS proxy (not built in).
- **Private/authenticated URLs 404 or 401** — e.g. a private GitHub repo returns
  404 to an anonymous browser call (by design; we don't put a token in the tab).

A well-behaved model treats these errors as feedback and adapts — you'll see it
switch URLs or give up gracefully rather than crash.

page's origin (llama-server needs it enabled / a CORS proxy; LM Studio has a
toggle; OpenAI allows browser calls but then your key sits in the tab — fine for
a local demo, not production). Small local models are unreliable at tool-calling.
"Files" are OPFS blobs sandboxed to this origin, not your disk; `webFetch` is
subject to the target's CORS. Switching embedding models changes the vector
dimension and resets memory (old vectors are incompatible). If you split chat and
embeddings across two servers, note the API key (if any) is sent to **both** — so
don't pair a keyed hosted endpoint with an untrusted embed server.

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
