// Headless end-to-end test for the local browser agent page.
//
// Loads demo/agent/index.html in real Chromium and drives a full agent turn:
// the user asks the agent to remember something, the (stubbed) LLM emits a
// `remember` tool call, the tool runs against REAL wasm memory, and the final
// answer + the memory sidebar update. The LLM is faked via page.route — but the
// memory (wasm) and OPFS paths are real, so this proves the loop wiring, tool
// dispatch, serialization, and persistence end to end.
//
//   npm install && npx playwright install chromium
//   ../scripts/fetch-artifact.sh   # or build-from-source.sh — populates pkg-web/
//   node demo/agent/e2e_agent.mjs  # (npm run e2e:agent, from repo root)
//
// Skips cleanly (exit 0) if playwright or the wasm bundle isn't present.

import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// This file sits in demo/agent/; serve from demo/ so ../pkg-web/ resolves.
const AGENT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(AGENT_DIR, "..");

async function have(p) { try { await access(join(ROOT, p)); return true; } catch { return false; } }
if (!(await have("pkg-web/zengram_wasm_bg.wasm"))) {
  console.log("SKIP — pkg-web/ not present (run fetch-artifact.sh or build-from-source.sh)");
  process.exit(0);
}
let chromium;
try {
  ({ chromium } = (await import("playwright")).default);
} catch {
  console.log("SKIP — playwright not installed (npm install && npx playwright install chromium)");
  process.exit(0);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(req.url.split("?")[0]));
    if (p === "/" || p === "\\") p = "/index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/agent/index.html`;

let checks = 0, failed = false;
function assert(cond, msg) {
  checks++;
  console.log((cond ? "  ok  " : "FAIL  ") + msg);
  if (!cond) failed = true;
}

const DIM = 16;
function toyVec(text) {
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % DIM] += 1;
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("   [page error]", m.text()); });
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));

// Pre-seed the endpoint config so boot() auto-connects (the host is irrelevant —
// the routes below intercept every /v1 call).
await page.addInitScript(() => {
  localStorage.setItem(
    "zengram.agent.config",
    JSON.stringify({ baseUrl: "http://stub.local/v1", model: "m", embedModel: "e", apiKey: "" }),
  );
});

// Stub /v1/embeddings → deterministic toy vector (this sets the memory dim).
await page.route("**/v1/embeddings", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  const input = Array.isArray(body.input) ? body.input[0] : String(body.input || "");
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: [{ embedding: toyVec(input), index: 0 }] }),
  });
});

// Stub /v1/chat/completions → a scripted two-step conversation:
//   call 1 → a `remember` tool call;  call 2 → a final answer.
let chatCalls = 0;
await page.route("**/v1/chat/completions", async (route) => {
  chatCalls++;
  let message;
  if (chatCalls === 1) {
    message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "remember", arguments: JSON.stringify({ subject: "tea", content: "the user drinks green tea" }) },
        },
      ],
    };
  } else {
    message = { role: "assistant", content: "Done — I'll remember that you drink green tea." };
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ choices: [{ message }] }),
  });
});

await page.goto(url, { waitUntil: "domcontentloaded" });

// boot() auto-connects from the seeded config → probes embed dim → opens memory.
await page.waitForSelector("#status.ready", { timeout: 20000 });
assert(true, "page booted and connected (status ready) against real wasm");

await page.waitForSelector("#input:not([disabled])", { timeout: 20000 });

// Drive one full agent turn.
await page.fill("#input", "remember that I drink green tea");
await page.click("#send");

// The final answer bubble arrives once chat call 2 returns.
await page.waitForFunction(
  () => [...document.querySelectorAll(".msg.agent")].some((n) => n.textContent.includes("remember that you drink green tea")),
  { timeout: 20000 },
);
assert(true, "agent produced the final answer after the tool round-trip");

// A tool-call step was rendered for `remember`.
const stepText = await page.$$eval("details.step summary", (els) => els.map((e) => e.textContent).join(" | "));
assert(/remember/.test(stepText), `a remember tool-call step was rendered ("${stepText}")`);

// The tool executed against REAL wasm memory → the sidebar now shows the fact.
await page.waitForFunction(
  () => document.querySelectorAll("#mems .mem").length >= 1,
  { timeout: 10000 },
);
const memText = await page.$eval("#mems", (e) => e.textContent);
assert(/green tea/.test(memText), "memory sidebar shows the remembered fact (real wasm write)");

assert(chatCalls === 2, `LLM was called twice (tool round-trip), got ${chatCalls}`);

// ── persistence across a reload (exercises the debounced close-flush) ────────
// The per-turn save is throttled (60s), so an immediate reload would lose the
// write UNLESS the tab-hidden flush fires. Dispatch visibilitychange→hidden to
// trigger flushNow(), wait for the OPFS snapshot to be written, then reload and
// confirm the fact rehydrates from OPFS (not just in-memory state).
await page.evaluate(async () => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
// Wait for the snapshot file to land — with a SHORT timeout well under the 60s
// throttle, so only the immediate close-flush (not the ordinary timer) can
// satisfy this. A broken visibilitychange handler would time out here.
await page.waitForFunction(
  async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.getFileHandle("agent-mem.zeta", { create: false });
      return true; // snapshot file exists → close-flush completed
    } catch { return false; }
  },
  { timeout: 3000, polling: 100 },
);
assert(true, "close-flush wrote the memory snapshot to OPFS");

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#status.ready", { timeout: 20000 });
await page.waitForFunction(
  () => document.querySelectorAll("#mems .mem").length >= 1,
  { timeout: 10000 },
);
const afterReload = await page.$eval("#mems", (e) => e.textContent);
assert(/green tea/.test(afterReload), "fact survives a reload (rehydrated from the OPFS snapshot)");

if (process.env.E2E_SHOT) {
  await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  console.log("   screenshot →", process.env.E2E_SHOT);
}

await browser.close();
server.close();
console.log(`\n${failed ? "FAILED" : "PASS"} — ${checks} checks`);
process.exit(failed ? 1 : 0);
