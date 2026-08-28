// zengram-lite — hello world (Node).
//
// The smallest complete tour of the memory tier: open → remember → recall →
// confirm/contradict/decay → raw SQL → snapshot round-trip. No model download:
// a tiny deterministic embedder stands in for a real one (see the note at the
// bottom for real, async models).
//
// Needs the nodejs-target bundle in demo/pkg/ — `scripts/build-from-source.sh`
// produces it (see demo/README.md). Run from the repo root:
//
//   node examples/hello.mjs

import { ZengramMemory } from "../demo/pkg/zengram_wasm.js";

const DIM = 64;

// Toy deterministic embedder: hashing bag-of-words, L2-normalized. Similar
// text lands near each other in cosine space — enough to show semantic recall.
function embed(text) {
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

// 1. Open an isolated in-memory database and register the embedder.
const mem = ZengramMemory.open(DIM);
mem.setEmbedFn(embed, DIM);

// 2. Remember facts in a scope. Distinct subjects — same-subject facts are
//    treated as updates (supersede/dedup).
const scope = "hello/world";
const idDark = mem.remember("editor", "I prefer dark mode", scope);
const idTea = mem.remember("beverage", "I drink green tea every morning", scope);
console.log("remembered:", idDark, idTea);

// 3. Recall by meaning — no shared keywords with the stored facts.
const hits = mem.recall("what UI theme do I use?", scope);
for (const h of hits) {
  console.log(`  ${h.score.toFixed(3)}  [${h.knowledgeId}] ${h.subject}: ${h.content}`);
}

// 4. Deterministic ops — no model needed.
mem.confirm(idDark); // validated → confidence up
mem.contradict(idTea); // wrong → confidence down
console.log("decayed facts:", mem.decay(30));

// 5. Raw SQL over the memory tables ($1/$2 positional binds).
const rows = mem.query(
  "SELECT subject, content, confidence, importance FROM knowledge WHERE scope = $1",
  [scope],
).rows;
console.log("knowledge table:", JSON.stringify(rows, null, 2));

// 6. Snapshot round-trip — the whole database in one byte blob.
const blob = mem.exportSnapshot();
const restored = ZengramMemory.openFromSnapshot(blob, DIM);
restored.setEmbedFn(embed, DIM);
console.log(
  "facts after restore:",
  restored.recall("what UI theme do I use?", scope).length,
);

// ── Real (async) models ────────────────────────────────────────────────────
// setEmbedFn needs a SYNC callback. For async models (Transformers.js, ORT-Web,
// a remote /v1/embeddings API), compute the vector in JS and hand it in:
//
//   const v = new Float32Array(await myModel.encode(text)); // length DIM
//   mem.rememberWithVector(subject, content, scope, v);
//   const hits = mem.recallWithVector(query, scope, qv);
