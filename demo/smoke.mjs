// Node smoke harness for zengram-wasm — the browser agentic-memory glue.
//
// Proves the full stack runs from a JS runtime: open a memory over the wasm
// engine, register a (toy, deterministic) embedder, remember a few facts, and
// recall them by semantic query. No model download — the embedder here is a
// tiny hashing bag-of-chars so the harness is self-contained and reproducible.
//
// Usage (from crates/zengram-wasm/):
//   1. RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo build --release \
//        --no-default-features --features wasm --target wasm32-unknown-unknown
//   2. wasm-bindgen --target nodejs --out-dir harness/pkg \
//        target/wasm32-unknown-unknown/release/zengram_wasm.wasm
//   3. node harness/smoke.mjs

import { ZengramMemory } from "./pkg/zengram_wasm.js";

const DIM = 64;

// A toy deterministic embedder: lowercase, split into word tokens, hash each
// token into a bucket, L2-normalize. Good enough that similar text lands near
// each other in cosine space — which is all the recall demo needs.
function toyEmbed(text) {
  const v = new Float32Array(DIM);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    v[(h >>> 0) % DIM] += 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return Array.from(v);
}

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// 1) Open a memory over the wasm engine + register the embedder.
const mem = ZengramMemory.open(DIM);
mem.setEmbedFn(toyEmbed, DIM);
console.log("opened ZengramMemory, embedder registered (dim", DIM + ")");

// 2) Remember a handful of facts in one scope. Distinct subjects — same-subject
// facts are treated as updates (supersede/dedup), which is correct behavior but
// not what we want to demo here.
const scope = "demo/agent";
const id1 = mem.remember("editor prefs", "The user prefers dark mode in the editor", scope);
const id2 = mem.remember("drink prefs", "The user likes tea, not coffee", scope);
const id3 = mem.remember("project", "The project ships a Rust database compiled to wasm", scope);
console.log("remembered 3 facts:", id1.slice(0, 8), id2.slice(0, 8), id3.slice(0, 8));
assert(id1 && id2 && id3, "each remember() should return a knowledge id");

// 3) Recall by query — the dark-mode fact should rank top for an editor query.
const hits = mem.recall("dark mode in the editor", scope);
console.log("recall('dark mode in the editor') ->");
for (const h of hits) console.log("   ", h.score.toFixed(3), h.subject, "—", h.content);
assert(Array.isArray(hits), "recall() should return an array");
assert(hits.length > 0, "recall() should surface at least one fact");
assert(
  hits[0].content.includes("dark mode"),
  "the dark-mode fact should rank top for an editor query",
);

// 4) Snapshot round-trip — export, reopen, recall survives.
// The memory schema's `embedding.fts` column is a tsvector; the catalog-log
// encoder now supports DataType::Tsvector, so a full export/restore works.
const blob = mem.exportSnapshot();
console.log("exported snapshot:", blob.length, "bytes");
const mem2 = ZengramMemory.openFromSnapshot(blob, DIM);
mem2.setEmbedFn(toyEmbed, DIM);
const hits2 = mem2.recall("dark mode in the editor", scope);
assert(
  hits2.some((h) => h.content.includes("dark mode")),
  "recall should still work after snapshot restore",
);
console.log("snapshot restore OK, recall survives");

// 5) No-LLM knowledge ops: confirm / contradict / decay / factsAboutPeer / query.
// These are deterministic (no embedder needed), so they run on the restored mem.
const beforeConf = mem2
  .query("SELECT confidence FROM knowledge WHERE id = $1", [id1])
  .rows[0].confidence;
mem2.confirm(id1);
const afterConf = mem2
  .query("SELECT confidence FROM knowledge WHERE id = $1", [id1])
  .rows[0].confidence;
assert(afterConf > beforeConf, "confirm() raises confidence");

mem2.contradict(id1);
const afterContra = mem2
  .query("SELECT confidence FROM knowledge WHERE id = $1", [id1])
  .rows[0].confidence;
assert(afterContra < afterConf, "contradict() lowers confidence");
console.log("confirm/contradict move confidence:", beforeConf.toFixed(2), "→", afterConf.toFixed(2), "→", afterContra.toFixed(2));

const decayed = mem2.decay(30);
assert(typeof decayed === "number" && decayed >= 1, "decay() returns a count of updated facts");
console.log("decay(30) touched", decayed, "facts");

// query() escape hatch returns the ZetaDb {columns, rows} shape.
const all = mem2.query("SELECT id, subject FROM knowledge ORDER BY subject", []);
assert(Array.isArray(all.columns) && Array.isArray(all.rows), "query() returns {columns, rows}");
assert(all.rows.length >= 3, "query() sees the seeded facts");
assert(all.columns.includes("subject"), "query() column names present");
console.log("query() over memory tables:", all.rows.length, "knowledge rows");

// factsAboutPeer() returns [] when nothing is peer-attributed (none seeded here).
const peerFacts = mem2.factsAboutPeer("nobody", 10);
assert(Array.isArray(peerFacts) && peerFacts.length === 0, "factsAboutPeer() with no matches is []");
console.log("factsAboutPeer('nobody') -> [] as expected");

console.log(`\nPASS — ${checks} checks`);

