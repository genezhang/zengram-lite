// Unit tests for the tool registry — schemas, arg handling, serialization,
// path safety, the read-only query guard. Fakes for mem/opfs/embed/fetch, no wasm.
// Run: node --test demo/agent/tools.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { makeTools, _internal } from "./tools.mjs";

const { safeFileName, FILE_PREFIX } = _internal;

// A fake ZengramMemory capturing calls.
function fakeMem() {
  return {
    remembered: [],
    confirmed: [],
    contradicted: [],
    queries: [],
    rememberWithVector(subject, content, scope, vec) {
      this.remembered.push({ subject, content, scope, dim: vec.length });
      return "id-" + this.remembered.length;
    },
    recallWithVector() {
      return [
        { knowledgeId: "k1", subject: "tea", content: "drinks green tea", score: 0.9, importance: 0.5 },
        { knowledgeId: "k2", subject: "editor", content: "dark mode", score: 0.7, importance: 0.5 },
      ];
    },
    confirm(id) {
      this.confirmed.push(id);
    },
    contradict(id) {
      this.contradicted.push(id);
    },
    query(sql, params) {
      this.queries.push({ sql, params });
      return { columns: ["id", "subject"], rows: [{ id: "k1", subject: "tea" }] };
    },
  };
}

function fakeOpfs() {
  const files = new Map();
  return {
    files,
    async writeFileText(name, text) {
      files.set(name, text);
    },
    async readFileText(name) {
      return files.has(name) ? files.get(name) : null;
    },
    async listFiles() {
      return [...files.keys()];
    },
    async deleteFromOpfs(name) {
      files.delete(name);
    },
  };
}

const fakeEmbed = async (text) => new Float32Array([text.length % 7, 1, 2, 3]);

function build(overrides = {}) {
  const mem = overrides.mem || fakeMem();
  const opfs = overrides.opfs || fakeOpfs();
  const tools = makeTools({
    mem,
    scope: "s",
    embed: overrides.embed || fakeEmbed,
    opfs,
    fetchImpl: overrides.fetchImpl || (async () => ({ ok: true, text: async () => "web body" })),
  });
  return { tools, mem, opfs };
}

test("schemas are OpenAI function-tool shaped with all expected tools", () => {
  const { tools } = build();
  const names = tools.schemas.map((s) => s.function.name).sort();
  assert.deepEqual(names, [
    "confirm",
    "contradict",
    "deleteFile",
    "listFiles",
    "query",
    "readFile",
    "recall",
    "remember",
    "webFetch",
    "writeFile",
  ]);
  for (const s of tools.schemas) {
    assert.equal(s.type, "function");
    assert.equal(typeof s.function.name, "string");
    assert.equal(typeof s.function.description, "string");
    assert.equal(s.function.parameters.type, "object");
  }
});

test("remember embeds subject+content and calls rememberWithVector", async () => {
  const { tools, mem } = build();
  const out = await tools.dispatch("remember", { subject: "a", content: "b" });
  assert.equal(mem.remembered.length, 1);
  assert.equal(mem.remembered[0].subject, "a");
  assert.match(out, /Remembered \(id=id-1\)\./);
});

test("recall serializes hits with ids and scores", async () => {
  const { tools } = build();
  const out = await tools.dispatch("recall", { query: "drink" });
  assert.match(out, /Found 2 memories/);
  assert.match(out, /\[id=k1, score=0\.90\]/);
  assert.match(out, /drinks green tea/);
});

test("recall honors limit", async () => {
  const { tools } = build();
  const out = await tools.dispatch("recall", { query: "x", limit: 1 });
  assert.match(out, /Found 1 memory/);
});

test("confirm and contradict pass the id through", async () => {
  const { tools, mem } = build();
  await tools.dispatch("confirm", { id: "k1" });
  await tools.dispatch("contradict", { id: "k2" });
  assert.deepEqual(mem.confirmed, ["k1"]);
  assert.deepEqual(mem.contradicted, ["k2"]);
});

test("query allows SELECT and returns {columns, rows} JSON", async () => {
  const { tools, mem } = build();
  const out = await tools.dispatch("query", { sql: "SELECT * FROM knowledge" });
  assert.equal(mem.queries.length, 1);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.columns, ["id", "subject"]);
  assert.equal(parsed.rows.length, 1);
});

test("query rejects non-SELECT (read-only guard)", async () => {
  const { tools, mem } = build();
  await assert.rejects(
    () => tools.dispatch("query", { sql: "DELETE FROM knowledge" }),
    /read-only/,
  );
  assert.equal(mem.queries.length, 0, "the write must never reach the engine");
});

test("query rejects stacked statements (defense-in-depth)", async () => {
  const { tools, mem } = build();
  await assert.rejects(
    () => tools.dispatch("query", { sql: "SELECT 1; DELETE FROM knowledge" }),
    /single SELECT/,
  );
  assert.equal(mem.queries.length, 0, "a stacked write must never reach the engine");
});

test("writeFile/readFile/listFiles/deleteFile round-trip through the prefix namespace", async () => {
  const { tools, opfs } = build();
  await tools.dispatch("writeFile", { path: "notes.txt", content: "hello" });
  assert.ok(opfs.files.has(FILE_PREFIX + "notes.txt"), "stored under the agentfile__ prefix");

  const read = await tools.dispatch("readFile", { path: "notes.txt" });
  assert.equal(read, "hello");

  const list = await tools.dispatch("listFiles", {});
  assert.equal(list, "notes.txt", "listFiles strips the prefix");

  await tools.dispatch("deleteFile", { path: "notes.txt" });
  assert.equal(await tools.dispatch("listFiles", {}), "(no files)");
});

test("listFiles hides non-agent OPFS entries (e.g. the memory snapshot)", async () => {
  const opfs = fakeOpfs();
  opfs.files.set("agent-mem.zeta", "snapshot bytes");
  opfs.files.set(FILE_PREFIX + "visible.txt", "x");
  const { tools } = build({ opfs });
  const list = await tools.dispatch("listFiles", {});
  assert.equal(list, "visible.txt");
});

test("readFile returns a clear message for a missing file", async () => {
  const { tools } = build();
  const out = await tools.dispatch("readFile", { path: "nope.txt" });
  assert.match(out, /No such file: nope\.txt/);
});

test("safeFileName rejects traversal and slashes", () => {
  assert.throws(() => safeFileName("../etc"), /slashes|'\.\.'/); // caught by slash rule (or .. rule)
  assert.throws(() => safeFileName(".."), /'\.\.'/); // bare .. (no slash) caught by the .. rule
  assert.throws(() => safeFileName("a/b"), /slashes/);
  assert.throws(() => safeFileName(""), /empty/);
  assert.equal(safeFileName("ok.txt"), "ok.txt");
});

test("webFetch returns text for a good URL and rejects non-http", async () => {
  const { tools } = build();
  const out = await tools.dispatch("webFetch", { url: "https://example.com" });
  assert.equal(out, "web body");
  await assert.rejects(() => tools.dispatch("webFetch", { url: "file:///etc/passwd" }), /http/);
});

test("unknown tool dispatch rejects", async () => {
  const { tools } = build();
  assert.equal(tools.has("bogus"), false);
  await assert.rejects(() => tools.dispatch("bogus", {}), /unknown tool/);
});
