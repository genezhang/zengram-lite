# Zengram-Lite: An In-Browser Agentic-Memory Framework — Semantic Knowledge, Session Tracking, and Token-Budgeted Context

**Working title / arXiv outline.** Status: outline agreed, prose drafted (see `draft.md`).

> **Title note.** The title leads with position (an in-browser agentic-memory
> *framework*) and names the three tiers that distinguish it from a vector store:
> **semantic knowledge**, **session tracking**, and **token-budgeted context**.
> The point of the title is the word *framework* — the contribution is that a
> coherent memory system (not a bag of primitives) runs client-side in one wasm
> artifact. Session tracking is given prominent billing because it is the tier no
> other in-browser memory system provides and the one that lets an agent run its
> *whole loop* in the tab. The engine underneath (Zeta) is summarized and cited,
> not re-derived: zengram-lite is a **superset** of zeta-lite, so the SQL/MVCC/
> branching/size story is carried by reference to the zeta-lite report.

## Framing decisions (locked)

- **Spine:** framework/systems. The contribution is a *complete agentic-memory
  framework* — a knowledge tier with a fact lifecycle, a session-tracking tier
  (sessions → turns → parts → tool calls), and a token-budgeted context-assembly
  tier — compiled to a single ~2.95 MB gzipped browser artifact that also carries
  the full SQL engine. The differentiator against "an HNSW index in the browser"
  (which zeta-lite already ships) is the *framework semantics on top*: confidence/
  decay, provenance, session structure, and 6-phase context assembly, bound by a
  46-table schema with invariants the framework maintains.
- **Relationship to zeta-lite:** zengram-lite is a **superset bundle**. The glue
  crate `zengram-wasm` links `zeta-wasm` into one cdylib, so a single `.wasm`
  exports the full SQL engine (`ZetaDb`/`ZetaTxn`/`ZetaCursor`) *and* the memory
  tier (`ZengramMemory`). The engine — log-centric MVCC, overlapping SI,
  copy-on-write branching, snapshot-to-OPFS durability, wasm-not-WASI, 2.87 MB —
  is the subject of the companion **zeta-lite** report [ZL]. This paper
  **summarizes** that substrate in one section and **cites** it; it does not
  re-argue it. The novelty here is one level up: the framework, and that it runs
  on the browser's synchronous surface at all.
- **Novelty (three-legged, defensible):**
  1. **A knowledge tier that is a system, not a store** — hybrid vector+FTS
     recall with a *lifecycle* (confidence via `confirm`/`contradict`, importance
     `decay`, supersession/dedup by subject, scope namespacing) over a schema the
     framework keeps consistent.
  2. **First-class session tracking, client-side** — sessions/turns/parts/
     tool-calls as real tables, plus **6-phase `assembleContext` under a token
     budget** with a `knowledgeFingerprint` reuse signal for prompt-prefix / KV
     caches. This is the tier that lets a browser agent run its entire loop
     (record conversation → assemble next prompt under budget → call LLM → record
     tool calls → derive knowledge) without a server. No other in-browser memory
     system provides it.
  3. **Running an LLM-dependent framework on a synchronous wasm surface** — the
     framework's canonical ops (fact extraction, reflection, embedding) call an
     LLM or an async model, but the wasm surface is synchronous. The
     **bring-your-own-result** seam (`rememberWithVector`, `extractWithFacts`,
     `reflectWithInsights`) resolves the impedance mismatch: the app computes the
     async result in JS and hands it in, and the framework runs its normal code
     paths (dedup, supersession, embedding, provenance) over it. This is a real
     design contribution, named as one.
- **Session tracking is a headline tier, not a footnote.** Most "agent memory"
  work is a vector store plus retrieval; the conversation itself is left to
  application code (arrays in `localStorage`, ad-hoc IndexedDB). Zengram-lite
  models the conversation as data — sessions, turns, typed parts, tool calls with
  state and provenance — and turns that structure into a *token-budgeted prompt*
  via `assembleContext`. Developed in §5 (mechanism) and §7.2 (the reproducible
  budget-eviction measurement).
- **Evaluation scope:** functional coverage + artifact size + a small set of
  genuinely-reproducible framework measurements (context-assembly budget behavior
  and fingerprint stability; real zero-keyword-overlap recall with all-MiniLM),
  all generated from the *published* artifact. **No engine micro-benchmarks** —
  the throughput/concurrency/soak numbers are zeta-lite's and are cited, not
  re-run. This is stated plainly: the framework layer's evidence is that it
  *works, completely, in the target environment*, shown by the smoke/e2e harnesses
  and the shipped local agent, not a speed contest.
- **The 46 tables are referenced, not dumped.** The paper groups them by tier
  with counts and names the load-bearing ones; the authoritative full list lives
  in the repo (`docs/engine-modes.md`) and is reachable at runtime via
  `db.schema()`. Cite, don't enumerate.

---

## Abstract
Browser agents increasingly need durable memory, but the client-side state of the
art is a vector index plus ad-hoc application code for the conversation itself.
Zengram-lite is an **agentic-memory framework** — not a store — compiled to a
single ~2.95 MB gzipped WebAssembly artifact that runs entirely in a browser tab.
It provides three tiers: a **knowledge** tier (hybrid vector+full-text recall with
a fact lifecycle — confidence, importance decay, supersession, scope namespacing);
a **session-tracking** tier (sessions, turns, typed parts, and tool calls as
first-class data); and a **context-assembly** tier that turns that structure into
a token-budgeted prompt with a stable reuse fingerprint. The bundle is a
**superset** of the zeta-lite SQL engine [ZL] — the same `.wasm` carries the full
Postgres-compatible surface, MVCC, and copy-on-write branching — so memory inherits
transactional consistency and branchable state for free. Because the wasm surface
is synchronous while the framework's canonical operations depend on an
(asynchronous) LLM and embedder, zengram-lite exposes a **bring-your-own-result**
seam that lets the framework's real code paths run over results the application
computes in JS. We report the framework's behavioral contract, the client-side
embodiment, and functional coverage against the published artifact. v0.1 preview.

## 1. Introduction
- Browser agents are here; they need memory that is **more than a vector store**.
- The gap: client-side memory today is (a) a vector index and (b) whatever the app
  builds around it for sessions/turns/tool-calls; there is no coherent *framework*
  in the tab. Server-hosted agent-memory systems exist but put the memory (and the
  user's data) back on a server.
- The bet: compile a real agentic-memory framework — knowledge + session + context
  — to wasm, over a transactional engine, as one artifact. Memory that is
  queryable, structured, private to the device, and complete enough to run the
  whole loop.
- **Contributions:**
  1. A knowledge tier with a fact lifecycle (recall + confidence/decay/
     supersession), not just similarity search.
  2. First-class, client-side **session tracking** and **6-phase token-budgeted
     context assembly** with a reuse fingerprint — the tier that runs the agent
     loop in the tab.
  3. The **bring-your-own-result** design for running an LLM-dependent framework
     on a synchronous wasm surface.
  4. The **superset** embodiment — memory + full SQL engine + branching in one
     ~2.95 MB `.wasm`, over the zeta-lite engine [ZL], with own-vs-shared engine
     modes.
  5. Position in the Zeta/Zengram family and the closed products it teases.

## 2. Background & Related Work
- **Agent-memory systems**: mem0, MemGPT/Letta, LangChain/LlamaIndex memory —
  mostly server-hosted or library-in-a-server; the store is remote, the framework
  runs in a Python/Node process. Position: zengram-lite puts the *whole* framework
  client-side.
- **Vector-in-browser**: transformers.js / ORT-Web for embeddings; HNSW-in-wasm;
  IndexedDB vector libs. These are *stores*; they carry no session model, no
  lifecycle, no context assembly.
- **Client-side agent state today**: `localStorage`/IndexedDB arrays of messages,
  hand-rolled context truncation. The thing zengram-lite replaces.
- **The engine**: zeta-lite [ZL] — the SQL/MVCC/branching substrate, summarized
  in §3 and cited, not repeated.
- **Delta**: no in-browser system offers a coherent agentic-memory framework
  (knowledge lifecycle + session tracking + budgeted context) in one artifact.

## 3. The Zeta Substrate (summary; full account in the zeta-lite report)
*(One section. Summarize + cite [ZL]; do not re-derive.)*
- **3.1 What zengram-lite inherits.** Log-centric async MVCC; overlapping
  snapshot-isolated transactions on one thread; a feature-complete Postgres
  surface (JSONB+GIN, FTS, HNSW vector, SQL/PGQ, multi-DB); **copy-on-write
  database branching**; snapshot-to-OPFS durability with no worker /
  SharedArrayBuffer / COOP-COEP; wasm-not-WASI host binding; ~2.87 MB engine.
  Each in one or two sentences, with a pointer to the zeta-lite section.
- **3.2 The superset bundle.** `zengram-wasm` links `zeta-wasm` + the framework
  into one cdylib; one `.wasm` exports `ZetaDb`/`ZetaTxn`/`ZetaCursor` **and**
  `ZengramMemory`. A page needing memory *and* SQL loads one engine. Size delta:
  ~2.95 MB gzip vs the engine's 2.87 MB — the framework tier is ~cheap on top.
- **3.3 Why memory over a SQL engine.** The memory tiers are *tables* — the
  knowledge tier is HNSW+FTS over `knowledge`/`embedding`; recall is a hybrid
  query; branching (inherited) means memory can fork. Consistency across all
  three tiers is one transaction, not a cross-store 2PC problem.

## 4. The Knowledge Tier
- **4.1 What a fact is.** The `knowledge` row: subject, content, scope,
  confidence, importance, status, counters, timestamps. Scope is a free-form
  namespace; recall is scoped.
- **4.2 Remember & recall.** `remember` embeds `"subject: content"` and stores it;
  `recall` runs **hybrid vector + full-text** over the scope and ranks by meaning
  (zero-keyword-overlap retrieval — the point of the embeddings). Same-subject =
  update (supersede/dedup), not duplicate.
- **4.3 The lifecycle (deterministic, no model).** `confirm`/`contradict` move
  confidence; `decay(halfLifeDays)` fades importance exponentially, charging only
  time since each fact's last decay. This is what makes it *memory* and not a
  frozen index — facts strengthen, weaken, and fade. Peer attribution
  (`factsAboutPeer`).
- **4.4 Provenance.** Facts derived from a turn carry session/turn provenance
  (`extractWithFacts`), so recall can be traced to the conversation that produced
  it. (traceBack/traceForward in-bundle, not-yet-exposed — §8.)

## 5. The Session-Tracking Tier (the centerpiece)
- **5.1 The conversation as data.** sessions → turns → **typed parts** →
  tool calls, each a table (`session`, `turn`, `part`, `tool_call`), with a trunk
  branch per session. Turns carry role, status, token counts, cost, finish reason;
  parts are atomic typed content units; tool calls have state (pending → running →
  completed/error), category, target paths, timing. The full agent transcript is
  structured, queryable data — not an opaque message array.
- **5.2 The loop, in the bundle.** `createSession` → `appendTurn`/`addPart` →
  `recordToolCall`/`completeToolCall` → `assembleContext` → `extractWithFacts` /
  `reflectWithInsights`. A browser agent records its conversation, assembles the
  next prompt, calls its LLM, records tool calls, and stores what it learned — all
  through the bundle. (`demo/smoke_agent.mjs` walks exactly this, 27 checks.)
- **5.3 Token-budgeted context assembly.** `assembleContext(session, branch,
  budget)` — the framework's **6-phase** assembly: system → permission rules →
  knowledge → tasks → hot/warm/cold history → cross-branch summaries → pending
  state, packed under a token budget with per-phase fractions. It reads the
  session's project scope + root scope for knowledge, includes as many recent
  turns as fit, and skips/summarizes the rest. Returns typed blocks with
  `tokenCount`/`sourceIds`, `turnsIncluded/Summarized/Skipped`, and a
  `knowledgeFingerprint` — **stable for an unchanged knowledge set**, a reuse
  signal for prompt prefixes / KV caches. This is the mechanism that makes "run
  the agent in the tab" tractable: context management is the framework's job, not
  the app's. Storage-budget enforcement (`enforceBudget`) prunes oldest sessions.
- **5.4 Why this is the hard part.** Anyone can store vectors; the value is
  turning a growing conversation into a bounded, reusable prompt under a schema
  that keeps knowledge, session, and provenance consistent. §7.2 shows the budget
  actually evicting turns and the fingerprint holding stable.

## 6. Running a Framework on a Synchronous Browser Surface
- **6.1 The impedance mismatch.** The wasm surface is **synchronous** (query
  execution is synchronous on the single thread); the framework's canonical ops
  depend on **asynchronous** JS — a real embedding model, a completion LLM. You
  cannot `await` inside the sync wasm call.
- **6.2 The bring-your-own-result seam.** Instead of the framework calling out,
  the app computes the async result in JS and hands the *finished* result in:
  `rememberWithVector` (finished embedding), `extractWithFacts` (facts your LLM
  extracted from a turn), `reflectWithInsights` (insights your LLM synthesized).
  The framework then runs its **normal** code paths — dedup, supersession,
  embedding via `setEmbedFn`, provenance, storage — over the supplied result. The
  seam is the same shape everywhere, which is what makes it a design choice rather
  than three special cases. `setEmbedFn` (sync) covers lightweight/precomputed
  embedders; the `…WithVector` pair covers real async models.
- **6.3 Engine modes.** `ZengramMemory.open(dim)` — own isolated engine;
  `ZengramMemory.overEngine(db, dim)` — memory over an existing `ZetaDb` (one heap,
  one catalog, query memory's tables in SQL alongside your own). Reserved-table-
  name caveat in shared mode (46 names; idempotent migrations). Snapshot
  persistence identical in both; in shared mode the snapshot includes app SQL too.
- **6.4 Persistence pattern.** Snapshot-based (`exportSnapshot`/`openFromSnapshot`,
  O(db size), no incremental delta), inheriting zeta-lite's snapshot-to-OPFS
  model. The shipped agent's production pattern: dirty-flag (only memory-writing
  turns), ~60 s throttle, flush-on-hide/close — at most one throttle window lost
  on a hard crash.

## 7. Evaluation: Coverage, Framework Behavior, and Size
*(Framework evidence, not an engine speed contest. All against the published
artifact; reproducible from the public repo.)*
- **7.1 Functional coverage.** The smoke/e2e harnesses driving the real artifact:
  `smoke.mjs` (memory core + engine surface — recall, confirm/contradict, decay,
  snapshot round-trip, peer facts; **19 checks**), `smoke_agent.mjs` (the full
  agent loop — sessions/turns/parts/tool-calls/context/BYOR bridges; **27
  checks**), `smoke_model.mjs` (real all-MiniLM vectors — **zero-keyword-overlap
  recall**), `e2e_ops.mjs` (the real DOM path in headless Chromium). Coverage
  table: tier → APIs → harness.
- **7.2 Context assembly under a token budget (the framework money figure).**
  Reproducible measurement from the published bundle: with 5 knowledge facts and
  12 turns, `assembleContext` at budget **200** packs **141 tokens / 3 turns
  included / 9 skipped**; at budget **1000 and 4000** it packs **579 tokens / 12
  turns / 0 skipped** — the budget is the binding constraint, and it evicts oldest
  turns first. The `knowledgeFingerprint` is **identical** across repeated calls on
  an unchanged knowledge set (the reuse signal is stable). This is the
  session-tier claim, measured.
- **7.3 Artifact size.** 10,400,328 bytes raw / **2.95 MB gzipped** — the superset
  (memory + full SQL engine + branching). Contrast the zeta-lite engine at 2.87 MB
  [ZL]: the entire agentic-memory framework adds ~0.08 MB gzip on top of the engine
  it already ships. Table: raw / gzip; delta vs zeta-lite.
- **7.4 The schema, by tier.** The 46-table catalog grouped: knowledge/embedding;
  session/turn/part/tool_call; provenance/event_log; project/account/environment;
  config tables; and the in-bundle-not-yet-exposed set (tasks, reminders,
  permission rules, code-graph, OKF, fleet). Names load-bearing tables; points to
  `docs/engine-modes.md` + `db.schema()` for the authoritative list rather than
  enumerating all 46 inline.
- **7.5 End-to-end: the shipped local agent.** `demo/agent/` — loop, tools
  (memory/files/webFetch), and memory all in the tab; only LLM inference is a
  remote OpenAI-compatible call. Memory persists to OPFS across a full browser
  restart. This is the framework working as a system, not just its unit tests
  passing.

## 8. Limitations & Future Work
- **Bring-your-own-result, not auto-pull.** Automatic extraction/reflection are
  not wired to call a model themselves (they can't, from sync wasm) — the app
  supplies results. `remember` stores verbatim; it does not split prose into
  atomic facts on its own.
- **Surface in the bundle, not yet exposed.** Episodic timelines
  (`session_timeline`, `turns_since`), provenance tracing (`traceBack`/
  `traceForward`), event log, reminders, permission rules, turn summarization, and
  **in-browser memory branching** (`fork`/`merge`/`rebase`) are compiled in but
  reachable today only via `query()`. A wider typed JS surface is planned.
  (Fleet/pgwire/OKF-ingest are excluded by design — server-side, native deps.)
- **Durability is snapshot-based** (inherited): durable as of the last snapshot;
  no incremental save; snapshots don't yet capture engine branches [ZL §8].
- **Framework evidence is functional, not throughput.** Engine performance is
  zeta-lite's [ZL]; this paper does not add framework micro-benchmarks. Stated
  plainly.
- **Future work**: the wider typed surface, auto-extraction when an async bridge
  lands, memory branching exposed, and the closed Zengram/Zeta products this
  teaser fronts.

## 9. Conclusion
The client side has had vector stores but not a *memory framework*. Zengram-lite
is one — knowledge with a lifecycle, sessions/turns/tool-calls as data, and
token-budgeted context assembly — in a single ~2.95 MB artifact that also carries
a full transactional SQL engine with branching. Because it sits on the zeta-lite
engine [ZL], it gets consistency and branchable state for free; because it resolves
the sync-wasm/async-LLM seam with bring-your-own-result, the whole framework runs
in the tab. It is the smallest, most complete form of the closed Zengram framework,
and the in-browser teaser for it.

---

## Cross-reference discipline (for the drafter)
- The **engine** (MVCC, SI, branching, snapshot-OPFS, wasm/WASI, throughput, soak)
  is **[ZL]** — cite the zeta-lite report; summarize in §3, never re-derive.
- The **46 tables** are grouped-with-counts in §7.4 and pointed to
  `docs/engine-modes.md`; do not paste the full list into the prose.
- Every number in §7 comes from the **published artifact** and is reproducible
  from this repo: sizes (`gzip -c pkg-web/*_bg.wasm | wc -c`), smokes
  (`node demo/smoke.mjs`, `node demo/smoke_agent.mjs`, `node demo/smoke_model.mjs`),
  context-budget probe (documented in §7.2). Keep them honest; reproduce in shape.
