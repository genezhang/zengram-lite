# Changelog

All notable changes to the **zengram-lite** distribution are documented here.
This repo ships the hand-authored surface (demos, docs, examples, fetch/build
scripts) plus the mechanics to run the published WebAssembly artifact; the
compiled `.wasm` is distributed via GitHub Releases (and, later, npm), not
committed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-01

Initial public preview of zengram-lite: the browser build of the Zengram
agentic-memory framework over the embedded Zeta engine, distributed as a single
WebAssembly artifact.

Distributed as a **GitHub Release** with the web-target bundle
(`zengram_wasm_bg.wasm` + wasm-bindgen glue + `THIRD-PARTY-NOTICES.txt`)
attached. Publication to npm as `zengram-lite` is pending; until then
`scripts/fetch-artifact.sh` pulls from the release, and
`scripts/build-from-source.sh` rebuilds from the monorepo (maintainers).

### Added

- **Superset bundle.** One `.wasm` re-exports the full zeta-lite SQL engine
  (`ZetaDb` / `ZetaTxn` / `ZetaCursor`) **and** the memory tier
  (`ZengramMemory`) — one engine, one download (~2.9 MB gzipped).
- **Knowledge tier.** Hybrid vector + full-text `recall` over a local store;
  `remember` / `rememberWithVector`; the deterministic lifecycle ops
  `confirm` / `contradict` / `decay`; `factsAboutPeer`; scope namespacing and
  same-subject supersession.
- **Session-tracking tier.** Sessions, turns, typed parts, and tool calls as
  queryable tables: `createSession`, `appendTurn`, `addPart`, `recordToolCall`,
  `completeToolCall`.
- **Context-assembly tier.** Six-phase, token-budgeted `assembleContext`
  returning a typed `ContextWindow` with per-block provenance and a stable
  `knowledgeFingerprint` reuse signal; `enforceBudget` for storage bounds.
- **Bring-your-own-result seam.** `extractWithFacts` / `reflectWithInsights` /
  `rememberWithVector` / `recallWithVector` — run the framework's real code
  paths over async results computed in JS, resolving the sync-wasm/async-model
  mismatch.
- **Two engine modes.** `ZengramMemory.open(dim)` (isolated engine) and
  `ZengramMemory.overEngine(db, dim)` (shared catalog with your app's SQL);
  idempotent migrations tracked in `_zengram_migrations`.
- **Snapshot persistence.** `exportSnapshot()` / `openFromSnapshot(bytes, dim)`
  serialize and rehydrate the whole database (SQL + memory) to bytes for OPFS.
- **Three demos.** An agent-memory demo, a full SQL playground, and a local AI
  agent whose loop, tools, and memory all run in the tab (only LLM inference is
  a remote OpenAI-compatible call), with throttled snapshot-to-OPFS persistence.
- **Docs.** API reference (`docs/api.md`), behavioral notes
  (`docs/how-it-works.md`), engine modes (`docs/engine-modes.md`), a runnable
  Node example (`examples/hello.mjs`), and a technical report
  (`docs/paper/`).
- **Verification harnesses.** `demo/smoke.mjs` (19 checks),
  `demo/smoke_agent.mjs` (27 checks), `demo/smoke_model.mjs` (real all-MiniLM
  recall), and `demo/e2e_ops.mjs` / `demo/agent/e2e_agent.mjs` (headless
  Chromium), all run against the published artifact.
- **Supply-chain integrity.** `fetch-artifact.sh` reports (and can pin, via
  `ZENGRAM_LITE_SHA512`) the artifact's SRI integrity, extracts tarballs
  defensively, and propagates `THIRD-PARTY-NOTICES.txt` alongside the `.wasm`.

### Known limitations (v0.1 preview)

- **In-memory engine; snapshot-based durability.** No incremental save; each
  snapshot is O(database size). A committed change is durable only as of the
  last snapshot the application persisted.
- **Extraction and reflection are bring-your-own-result, not automatic.** The
  synchronous wasm surface cannot call an async model itself; the application
  supplies extracted facts / synthesized insights. `remember` stores content
  verbatim.
- **Part of the compiled framework is not yet a typed JS surface.** Episodic
  timelines, provenance tracing (`traceBack` / `traceForward`), reminders,
  permission rules, and in-browser memory branching are reachable today only via
  `query()`; typed APIs are planned.

### Source availability

The **Zengram framework** source is planned for release as open source under
**Apache-2.0** (publication pending). The **Zeta engine** remains closed. The
zengram-lite `.wasm` links both and is therefore distributed as a prebuilt
binary; see [LICENSE](./LICENSE) (Zengram Lite License — free for any use,
including commercial).

### Build provenance

The `.wasm` is compiled from `crates/zengram-wasm` in the Zeta monorepo, which
links three private source trees via path deps. The v0.1.0 artifact is built
from these commits, each tagged `zengram-lite-v0.1.0`:

| Source repo | Supplies | Commit |
|---|---|---|
| `genezhang/zengram` | `zengram-mem`, `zengram-common` (memory tier) | `8db91ce` |
| `genezhang/zeta` | `zeta-wasm`, `zeta-embedded` (engine) | `ab0ba01b` |
| `genezhang/zeta-embedded` | `zeta-embedded-api` (shared types) | `8f72971` |

[0.1.0]: https://github.com/genezhang/zengram-lite/releases/tag/v0.1.0
