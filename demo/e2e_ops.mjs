// Headless end-to-end test for the deterministic memory ops in the
// agent-memory page (index.html).
//
// Serves demo/ over HTTP, loads the page in real Chromium, and drives the
// ACTUAL DOM: type facts into the form, click 👍/👎 (confirm/contradict), click
// Decay — asserting the confidence bars move and the count is reported. This is
// the browser-only surface the Node smoke tests can't reach (DOM + a real
// fetch-loaded wasm module).
//
// The page pulls the all-MiniLM embedding model from a CDN. To run offline and
// fast, we intercept that import and serve a tiny deterministic stub embedder,
// so the real boot() finishes with no network. The ops under test
// (confirm/contradict/decay/query) don't touch embeddings at all — this just
// lets remember/recall work so there are facts to operate on.
//
//   npm install               # playwright (devDependency)
//   npx playwright install chromium
//   ../scripts/fetch-artifact.sh   # or build-from-source.sh — populates pkg-web/
//   node e2e_ops.mjs          # from demo/  (npm run e2e, from repo root)
//
// Skips cleanly (exit 0) if playwright or the wasm bundle isn't present, so it's
// safe as an optional CI job.

import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

// Skip (not fail) when prerequisites are absent — CI without browsers, or a
// checkout that hasn't fetched the artifact.
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

// Minimal static server, scoped to demo/.
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
const url = `http://127.0.0.1:${port}/index.html`;

let checks = 0, failed = false;
function assert(cond, msg) {
  checks++;
  console.log((cond ? "  ok  " : "FAIL  ") + msg);
  if (!cond) failed = true;
}

const browser = await chromium.launch(); // headless by default
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("   [page error]", m.text()); });
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));

// Stub the transformers CDN module: return a fake `pipeline` whose extractor
// yields a deterministic toy embedding. This lets the page's real boot() finish
// (mem created, model "loaded", inputs enabled) with NO network — so we drive
// the genuine UI, not a special test build. The memory ops under test
// (confirm/contradict/decay/query) don't touch embeddings at all.
await page.route(/@huggingface\/transformers/, (route) => {
  const DIM = 384;
  const js = `
    export const env = { allowRemoteModels: true };
    export async function pipeline() {
      return async (text) => {
        const v = new Float32Array(${DIM});
        for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % ${DIM}] += 1;
        let n = 0; for (const x of v) n += x*x; n = Math.sqrt(n) || 1;
        for (let i = 0; i < ${DIM}; i++) v[i] /= n;
        return { data: v };
      };
    }`;
  route.fulfill({ status: 200, contentType: "text/javascript", body: js });
});

await page.goto(url, { waitUntil: "domcontentloaded" });

// The page enables its input once boot() completes (mem + model ready). Wait on
// the real UI signal rather than a module-private variable.
await page.waitForSelector("#status.ready", { timeout: 20000 });
await page.waitForSelector("#input:not([disabled])", { timeout: 20000 });

// Store three facts through the real page path: type + submit the form.
for (const fact of ["I use dark mode", "I drink green tea", "I'm building a Rust project"]) {
  await page.fill("#input", fact);
  await page.click("#send");
  await page.waitForSelector("#input:not([disabled])", { timeout: 10000 }); // re-enabled after handle()
}

// The sidebar should now show 3 facts, each with confidence + importance bars.
await page.waitForSelector(".mem", { timeout: 5000 });
const cards = await page.$$(".mem");
assert(cards.length === 3, `sidebar shows 3 facts (query-driven) — got ${cards.length}`);

const firstConf = () => page.$eval(".mem:first-child .cval", (e) => parseFloat(e.textContent));
const before = await firstConf();
assert(before > 0 && before <= 1, `first fact has a confidence value (${before})`);

// Click 👍 confirm on the first fact → confidence rises.
await page.click(".mem:first-child .up");
const afterUp = await firstConf();
assert(afterUp > before, `confirm (👍) raised confidence ${before} → ${afterUp}`);

// Click 👎 contradict → confidence drops.
await page.click(".mem:first-child .down");
const afterDown = await firstConf();
assert(afterDown < afterUp, `contradict (👎) lowered confidence ${afterUp} → ${afterDown}`);

// Click Decay → reports a count.
await page.click("#decay");
const decayMsg = await page.$eval("#decaymsg", (e) => e.textContent);
assert(/decayed \d+ fact/.test(decayMsg), `decay button reported a count ("${decayMsg}")`);

// Optional screenshot for a visual record: E2E_SHOT=path node e2e_ops.mjs
if (process.env.E2E_SHOT) {
  await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  console.log("   screenshot →", process.env.E2E_SHOT);
}

await browser.close();
server.close();
console.log(`\n${failed ? "FAILED" : "PASS"} — ${checks} checks`);
process.exit(failed ? 1 : 0);
