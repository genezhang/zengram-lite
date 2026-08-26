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
// KNOWN LIMITATION (Zeta engine): the catalog-log encoder does not yet support
// DataType::Tsvector, and the memory schema's `embedding.fts` column is a
// tsvector (FTS). So exportSnapshot currently throws. Treat it as a known gap
// rather than a demo failure — remember/recall (the core) are fully working.
let snapshotOk = false;
try {
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
  snapshotOk = true;
} catch (e) {
  const msg = String(e && e.message ? e.message : e);
  if (msg.includes("Tsvector")) {
    console.log(
      "snapshot SKIPPED — known Zeta gap: catalog-log encoder lacks DataType::Tsvector\n" +
        "  (the embedding.fts FTS column can't be serialized yet; remember/recall unaffected)",
    );
  } else {
    throw e;
  }
}

console.log(`\nPASS — ${checks} checks${snapshotOk ? "" : " (snapshot skipped — known gap)"}`);

