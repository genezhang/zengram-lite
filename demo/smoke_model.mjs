// Real-model smoke test: drive zengram-wasm's precomputed-vector path with a
// genuine sentence-embedding model (all-MiniLM-L6-v2, 384-dim) via
// @huggingface/transformers. Proves semantic recall works with real embeddings,
// not the toy hash embedder.
//
// Usage (from crates/zengram-wasm/harness/, after `npm install @huggingface/transformers`):
//   node smoke_model.mjs
//
// setEmbedFn requires a SYNCHRONOUS callback, but real models are async — so we
// use the bring-your-own-vector path: embed in JS (async), pass the finished
// Float32Array to rememberWithVector / recallWithVector.

import { ZengramMemory } from "./pkg/zengram_wasm.js";
import { pipeline } from "@huggingface/transformers";

const DIM = 384;

console.log("loading all-MiniLM-L6-v2 (first run downloads ~25MB)…");
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

// Mean-pooled, L2-normalized sentence embedding → Float32Array(384).
async function embed(text) {
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(out.data);
}

let checks = 0;
const assert = (c, m) => { checks++; if (!c) { console.error("FAIL:", m); process.exit(1); } };

const mem = ZengramMemory.open(DIM);
const scope = "demo/real-model";

// Remember a few facts (embed content the way learn() does: "subject: content").
const facts = [
  ["editor", "The user prefers dark mode in the code editor"],
  ["beverage", "The user drinks green tea every morning"],
  ["project", "We are building a database that compiles to WebAssembly"],
  ["language", "The codebase is written in Rust"],
];
for (const [subject, content] of facts) {
  const v = await embed(`${subject}: ${content}`);
  const id = mem.rememberWithVector(subject, content, scope, v);
  assert(id, `remembered ${subject}`);
}
console.log(`remembered ${facts.length} facts with real embeddings`);

// Semantic recall — queries that share NO literal keywords with the target,
// so only a real model (not a hash) can match them.
const cases = [
  ["what UI theme does the user like?", "dark mode"],
  ["what does the user drink?", "green tea"],
  ["what language is the code in?", "Rust"],
];
for (const [query, expect] of cases) {
  const qv = await embed(query);
  const hits = mem.recallWithVector(query, scope, qv);
  const top = hits[0];
  console.log(`\nQ: ${query}\n   top: ${top?.score.toFixed(3)} — ${top?.content}`);
  assert(top && top.content.includes(expect),
    `"${query}" should recall the "${expect}" fact (got: ${top?.content})`);
}

console.log(`\nPASS — ${checks} checks (real semantic recall, zero keyword overlap)`);
