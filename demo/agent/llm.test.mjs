// Unit tests for the OpenAI-compatible LLM adapter — URL routing, request
// shape, response parsing, error surfacing. Fake fetch, no network, no wasm.
// Run: node --test demo/agent/llm.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { makeLLM, DEFAULT_CONFIG, PRESETS } from "./llm.mjs";

// A fake fetch that records every call and replies from a per-path script.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    for (const [needle, reply] of routes) {
      if (url.includes(needle)) return reply(url, opts);
    }
    throw new Error("no route for " + url);
  };
  impl.calls = calls;
  return impl;
}

const okJson = (obj) => ({ ok: true, status: 200, statusText: "OK", json: async () => obj });
const embedReply = (dim) => okJson({ data: [{ embedding: Array.from({ length: dim }, (_, i) => i / dim) }] });
const chatReply = (msg) => okJson({ choices: [{ message: msg }] });

test("chat POSTs to <base>/chat/completions with model + tools + tool_choice", async () => {
  const f = fakeFetch([["/chat/completions", () => chatReply({ role: "assistant", content: "hi" })]]);
  const llm = makeLLM({ baseUrl: "http://localhost:8080/v1/", model: "m", embedModel: "e" }, f);
  const msg = await llm.chat([{ role: "user", content: "yo" }], [{ type: "function" }]);

  assert.equal(msg.content, "hi");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://localhost:8080/v1/chat/completions"); // trailing slash normalized
  assert.equal(f.calls[0].body.model, "m");
  assert.equal(f.calls[0].body.tool_choice, "auto");
  assert.ok(Array.isArray(f.calls[0].body.tools));
});

test("embed defaults to the chat base URL when embedBaseUrl is blank", async () => {
  const f = fakeFetch([["/embeddings", () => embedReply(8)]]);
  const llm = makeLLM({ baseUrl: "http://localhost:1234/v1", model: "m", embedModel: "e" }, f);
  const vec = await llm.embed("hello");

  assert.ok(vec instanceof Float32Array);
  assert.equal(vec.length, 8);
  assert.equal(f.calls[0].url, "http://localhost:1234/v1/embeddings");
  assert.equal(f.calls[0].body.model, "e");
  assert.equal(f.calls[0].body.input, "hello");
});

test("embed routes to a SEPARATE server when embedBaseUrl is set (llama.cpp two-process)", async () => {
  const f = fakeFetch([
    ["8080/v1/chat/completions", () => chatReply({ role: "assistant", content: "reasoned" })],
    ["8081/v1/embeddings", () => embedReply(384)],
  ]);
  const llm = makeLLM(
    {
      baseUrl: "http://localhost:8080/v1",
      embedBaseUrl: "http://localhost:8081/v1/", // trailing slash normalized too
      model: "chat-model",
      embedModel: "embed-model",
    },
    f,
  );

  await llm.chat([{ role: "user", content: "q" }]);
  const vec = await llm.embed("t");

  assert.equal(vec.length, 384);
  assert.equal(f.calls[0].url, "http://localhost:8080/v1/chat/completions");
  assert.equal(f.calls[1].url, "http://localhost:8081/v1/embeddings", "embed hits the second server");
  // config surfaces both normalized bases for the UI/status line.
  assert.equal(llm.config.baseUrl, "http://localhost:8080/v1");
  assert.equal(llm.config.embedBaseUrl, "http://localhost:8081/v1");
});

test("probeEmbedDim returns the embedding length from the embed endpoint", async () => {
  const f = fakeFetch([["/embeddings", () => embedReply(768)]]);
  const llm = makeLLM({ baseUrl: "http://x/v1", model: "m", embedModel: "e" }, f);
  assert.equal(await llm.probeEmbedDim(), 768);
});

test("apiKey becomes a Bearer authorization header; blank key sends none", async () => {
  const withKey = fakeFetch([["/embeddings", () => embedReply(4)]]);
  await makeLLM({ baseUrl: "http://x/v1", model: "m", embedModel: "e", apiKey: "sk-abc" }, withKey).embed("t");
  assert.equal(withKey.calls[0].opts.headers.authorization, "Bearer sk-abc");

  const noKey = fakeFetch([["/embeddings", () => embedReply(4)]]);
  await makeLLM({ baseUrl: "http://x/v1", model: "m", embedModel: "e" }, noKey).embed("t");
  assert.equal(noKey.calls[0].opts.headers.authorization, undefined);
});

test("a fetch TypeError becomes a helpful network error naming the embed base", async () => {
  const f = async () => {
    throw new TypeError("Failed to fetch");
  };
  const llm = makeLLM(
    { baseUrl: "http://localhost:8080/v1", embedBaseUrl: "http://localhost:8081/v1", model: "m", embedModel: "e" },
    f,
  );
  await assert.rejects(() => llm.embed("t"), (e) => {
    assert.match(e.message, /Could not reach http:\/\/localhost:8081\/v1/); // the failing (embed) server, not the chat one
    assert.match(e.message, /CORS/);
    return true;
  });
});

test("an HTTP error surfaces status + a body snippet", async () => {
  const f = fakeFetch([
    ["/chat/completions", () => ({ ok: false, status: 404, statusText: "Not Found", text: async () => "model 'foo' not found" })],
  ]);
  const llm = makeLLM({ baseUrl: "http://x/v1", model: "foo", embedModel: "e" }, f);
  await assert.rejects(() => llm.chat([]), /HTTP 404 Not Found — model 'foo' not found/);
});

test("malformed responses are rejected, not silently mis-parsed", async () => {
  const badChat = fakeFetch([["/chat/completions", () => okJson({ choices: [] })]]);
  await assert.rejects(
    () => makeLLM({ baseUrl: "http://x/v1", model: "m", embedModel: "e" }, badChat).chat([]),
    /no choices\[0\]\.message/,
  );
  const badEmbed = fakeFetch([["/embeddings", () => okJson({ data: [{}] })]]);
  await assert.rejects(
    () => makeLLM({ baseUrl: "http://x/v1", model: "m", embedModel: "e" }, badEmbed).embed("t"),
    /no data\[0\]\.embedding/,
  );
});

test("DEFAULT_CONFIG carries a blank embedBaseUrl and PRESETS name the common servers", () => {
  assert.equal(DEFAULT_CONFIG.embedBaseUrl, "");
  assert.ok(PRESETS["llama.cpp"].includes(":8080"));
  assert.ok(PRESETS["LM Studio"].includes(":1234"));
  assert.ok(PRESETS.OpenAI.includes("api.openai.com"));
});
