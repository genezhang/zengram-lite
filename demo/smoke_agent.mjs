// Node smoke harness for the zengram-wasm AGENT SURFACE — sessions, turns,
// parts, tool calls, context assembly, and the bring-your-own-result LLM
// bridges (extractWithFacts / reflectWithInsights).
//
// This is the loop a browser agent runs entirely in the bundle:
//   createSession → appendTurn/addPart → (call the LLM) → completeTurn
//   → recordToolCall/completeToolCall → assembleContext → extractWithFacts
//
// Like smoke.mjs, the embedder is a toy deterministic hashing embedder — no
// model download. The "LLM" for the bridges is simulated by passing the
// extracted facts / synthesized insights directly (that IS the contract: the
// JS side calls its real completion model and hands the results in).
//
// Usage (from crates/zengram-wasm/):
//   1. RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo build --release \
//        --no-default-features --features wasm --target wasm32-unknown-unknown
//   2. wasm-bindgen --target nodejs --out-dir harness/pkg \
//        target/wasm32-unknown-unknown/release/zengram_wasm.wasm
//   3. node harness/smoke_agent.mjs

import { ZengramMemory } from "./pkg/zengram_wasm.js";

const DIM = 64;

// Same toy deterministic embedder as smoke.mjs.
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
function assertThrows(fn, msg) {
  checks++;
  try {
    fn();
  } catch {
    return;
  }
  console.error("FAIL (no throw):", msg);
  process.exit(1);
}

const mem = ZengramMemory.open(DIM);
mem.setEmbedFn(toyEmbed, DIM);

// 1) createSession — auto-ensures the project row, returns the trunk branch.
const { sessionId, branchId } = mem.createSession("proj/agent", {
  title: "smoke session",
  agent: "smoke-agent",
});
assert(sessionId && branchId, "createSession returns {sessionId, branchId}");
console.log("session:", sessionId.slice(0, 8), "branch:", branchId.slice(0, 8));

// 2) user turn + text part.
const t1 = mem.appendTurn(sessionId, branchId, "user", {});
assert(t1, "appendTurn returns a turn id");
const p1 = mem.addPart(t1, sessionId, "text", { text: "What is the weather in Tokyo?" }, 0);
assert(p1, "addPart returns a part id");

// 3) tool call against the part, then completed.
const tc1 = mem.recordToolCall({
  turnId: t1,
  partId: p1,
  sessionId,
  toolId: "webFetch",
  input: { url: "https://example.com/weather" },
  category: "web",
});
assert(tc1, "recordToolCall returns a tool-call id");
mem.completeToolCall(tc1, { output: "sunny, 27C", durationMs: 120 });

// 4) assistant turn (child of the user turn), completed with token counts.
const t2 = mem.appendTurn(sessionId, branchId, "assistant", { parentTurnId: t1 });
mem.completeTurn(t2, 10, 20, 0.001, "stop");

// 5) getTurns — camelCase keys, oldest first, token counts recorded.
const turns = mem.getTurns(sessionId, branchId, 50, 0);
assert(Array.isArray(turns) && turns.length === 2, "getTurns returns both turns");
assert(turns[0].role === "user" && turns[1].role === "assistant", "turn order + roles");
assert(turns[1].tokensInput === 10 && turns[1].tokensOutput === 20, "token counts camelCased");
console.log("turns:", turns.map((t) => t.role).join(" → "));

// 6) getParts — the text part's data round-trips as JSON.
const parts = mem.getParts(t1);
assert(parts.length === 1 && parts[0].type === "text", "getParts returns the text part");
assert(parts[0].data.text.includes("Tokyo"), "part data round-trips");

// 7) queryToolCalls — state + duration recorded, camelCased.
const calls = mem.queryToolCalls(sessionId, { toolId: "webFetch" });
assert(calls.length === 1, "queryToolCalls finds the recorded call");
assert(calls[0].state === "completed" && calls[0].durationMs === 120, "tool call state/duration");
assert(calls[0].output === "sunny, 27C", "tool call output stored");
const noCalls = mem.queryToolCalls(sessionId, { toolId: "noSuchTool" });
assert(noCalls.length === 0, "queryToolCalls filters by toolId");

// 8) assembleContext — knowledge injection + budget + stable fingerprint.
// The knowledge phase reads the project scope, so remember there.
mem.remember("prefs", "The user prefers dark mode", "/project/proj/agent");
const win1 = mem.assembleContext(sessionId, branchId, 4000, {});
assert(win1.totalTokens <= 4000, "context window respects the budget");
assert(win1.blocks.length > 0, "context window has blocks");
assert(
  win1.blocks.some((b) => b.type === "knowledge"),
  "project-scope knowledge is injected",
);
assert(
  win1.blocks.some((b) => b.type === "turn"),
  "conversation turns are included",
);
const win2 = mem.assembleContext(sessionId, branchId, 4000, {});
assert(
  win1.knowledgeFingerprint === win2.knowledgeFingerprint,
  "knowledgeFingerprint is stable for unchanged knowledge",
);
console.log(
  "context:",
  win1.blocks.map((b) => b.type).join(","),
  `(${win1.totalTokens}/${win1.budget} tokens)`,
);

// 9) extractWithFacts — the browser path for automatic knowledge extraction:
// the JS LLM extracted these facts from the turn; the framework stores them
// (embedded, deduped, provenance-linked to the session/turn).
const ids = mem.extractWithFacts(
  "The user says they drink green tea and prefer dark mode.",
  "proj/agent",
  sessionId,
  t1,
  [
    { subject: "drink", content: "the user drinks green tea" },
    { subject: "theme", content: "the user prefers dark mode" },
  ],
);
assert(Array.isArray(ids) && ids.length === 2, "extractWithFacts stores both facts");
const hits = mem.recall("what does the user drink?", "proj/agent");
assert(
  hits.some((h) => h.content.includes("green tea")),
  "extracted fact is recallable by meaning",
);
const prov = mem.query(
  "SELECT count(*) AS c FROM knowledge WHERE source_session = $1 AND source_turn = $2",
  [sessionId, t1],
);
assert(prov.rows[0].c === 2, "extracted facts carry session/turn provenance");
console.log("extractWithFacts stored:", ids.map((i) => i.slice(0, 8)).join(", "));

// 10) reflectWithInsights — the browser path for reflection.
const insightIds = mem.reflectWithInsights(
  "proj/agent",
  [
    {
      subject: "preferences",
      content: "the user has consistent UI and beverage preferences",
    },
  ],
  100,
);
assert(insightIds.length === 1, "reflectWithInsights stores the insight");
const empty = mem.reflectWithInsights("no-such-scope", [{ subject: "x", content: "y" }], 100);
assert(Array.isArray(empty) && empty.length === 0, "reflect on an empty scope is a no-op");

// 11) enforceBudget — no budget configured → null.
assert(mem.enforceBudget("/project/proj/agent") === null, "enforceBudget is null without a budget");

// 12) Error paths.
assertThrows(() => mem.appendTurn(sessionId, branchId, "robot", {}), "bad role throws");
assertThrows(
  () => mem.recordToolCall({ turnId: t1, partId: p1, sessionId }),
  "recordToolCall without toolId throws",
);
const bare = ZengramMemory.open(DIM); // no setEmbedFn
assertThrows(
  () => bare.extractWithFacts("t", "s", "sid", "tid", [{ subject: "a", content: "b" }]),
  "extractWithFacts without setEmbedFn throws",
);

console.log(`\nPASS — ${checks} checks`);
