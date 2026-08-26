# CLAUDE.md — zengram-lite

Guidance for Claude Code when working in the **zengram-lite** public-facing repo.

## What this repo is

zengram-lite is the **public distribution repo** for the WebAssembly build of the
Zengram agentic-memory framework over the Zeta engine — the in-browser teaser for
the closed Zengram + Zeta products. The compiled build is **free to use,
including commercially, but not open source**. It mirrors the `genezhang/zeta-lite`
distribution pattern: the closed framework/engine stay in private monorepos
(`genezhang/zengram`, `genezhang/zeta`), and this repo holds the **hand-authored
surface** plus the mechanics to fetch/run the published binary.

**This repo does NOT contain the framework or engine source.** The compiled
`zengram_wasm_bg.wasm` is built in the monorepo (`crates/zengram-wasm`) and
published to npm / GitHub Releases. Do not attempt to add engine or framework
Rust source here.

## The superset bundle

zengram-lite is a **superset** of zeta-lite: because the glue crate
`zengram-wasm` links `zeta-wasm` into one cdylib, the single `.wasm` exports the
full SQL engine (`ZetaDb`/`ZetaTxn`/`ZetaCursor`) **and** the memory tier
(`ZengramMemory`). A page needing both imports only zengram-lite — never two
engines. zeta-lite stays the lean SQL-only package.

## Layout

- `demo/` — the interactive agent-memory demo (hand-authored HTML + JS glue).
  - `index.html` — the browser agent (copied from monorepo
    `crates/zengram-wasm/harness/agent_demo.html`, mirrored via the zengram
    monorepo's `demos/agent-memory/`).
  - `smoke.mjs` / `smoke_model.mjs` — Node smoke tests (toy embedder / real
    all-MiniLM model). Import the nodejs-target build from `demo/pkg/`.
  - `pkg-web/`, `pkg/` — **gitignored**; the fetched/built wasm artifact lands
    here.
- `scripts/` — `fetch-artifact.sh` (pull published wasm), `build-from-source.sh`
  (rebuild from the monorepo, maintainers only).
- `docs/engine-modes.md` — own vs shared engine, and the reserved-table-name
  caveat.
- `LICENSE` — Zengram Lite License (free to use, including commercially; **not**
  open source — the framework/engine source is not in this repo).

## Source of truth

The demo is **downstream** of the monorepo's `crates/zengram-wasm/harness/`
(mirrored through the zengram repo's `demos/agent-memory/`). Substantive demo
changes should be made in the monorepo harness first (where the engine +
smoke tests live), then synced here. This repo is the distribution mirror, not
the development home.

## Verifying changes

- Fetch or build the artifact: `./scripts/fetch-artifact.sh`, or
  `ZETA_REPO=/path/to/zeta ./scripts/build-from-source.sh`.
- Smoke tests (need the fetched/built nodejs bundle in `demo/pkg/`):
  `node demo/smoke.mjs` (toy embedder) and `node demo/smoke_model.mjs` (real
  model, downloads all-MiniLM once).
- Serve locally: `python3 -m http.server -d demo 8080` (wasm needs `http://`,
  not `file://`).

## Guardrails

- **Never commit the `.wasm`** or `pkg/`/`pkg-web/` — they're published
  artifacts, gitignored on purpose.
- **Never push directly to `main`** — feature branch + PR.
- The framework/engine source is closed and not in this repo; do not add anything
  that discloses closed internals beyond what the public JS API already exposes.
