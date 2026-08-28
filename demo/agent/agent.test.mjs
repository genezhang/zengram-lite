// Unit tests for the agent loop — pure control-flow, no wasm, no network.
// Run: node --test demo/agent/agent.test.mjs   (CI collects it via demo/**/*.test.mjs)

import test from "node:test";
import assert from "node:assert/strict";
import { runAgent, newHistory, SYSTEM_PROMPT } from "./agent.mjs";

// A scripted llm.chat: returns queued messages in order.
function scriptedLLM(messages) {
  let i = 0;
  return {
    calls: [],
    chat(history) {
      this.calls.push(history.length);
      return Promise.resolve(messages[i++]);
    },
  };
}

// A tool registry whose dispatch is recorded.
function fakeTools(impl = {}) {
  const names = new Set(Object.keys(impl));
  const dispatched = [];
  return {
    dispatched,
    schemas: [...names].map((n) => ({ type: "function", function: { name: n } })),
    has: (n) => names.has(n),
    async dispatch(n, a) {
      dispatched.push({ name: n, args: a });
      return impl[n](a);
    },
  };
}

test("newHistory seeds the system prompt at index 0", () => {
  const h = newHistory();
  assert.equal(h.length, 1);
  assert.equal(h[0].role, "system");
  assert.equal(h[0].content, SYSTEM_PROMPT);
});

test("terminates immediately when the model returns no tool_calls", async () => {
  const llm = scriptedLLM([{ role: "assistant", content: "hello there" }]);
  const tools = fakeTools();
  const history = newHistory();
  const events = [];
  const { finalText } = await runAgent("hi", { llm, tools, history, onEvent: (e) => events.push(e) });

  assert.equal(finalText, "hello there");
  assert.equal(llm.calls.length, 1);
  // history: system, user, assistant
  assert.deepEqual(history.map((m) => m.role), ["system", "user", "assistant"]);
  assert.ok(events.some((e) => e.type === "assistant-text" && e.text === "hello there"));
});

test("dispatches a tool call, appends role:tool with the matching id, then finishes", async () => {
  const llm = scriptedLLM([
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", function: { name: "remember", arguments: '{"subject":"x","content":"y"}' } }],
    },
    { role: "assistant", content: "done" },
  ]);
  const tools = fakeTools({ remember: async () => "Remembered (id=abc)." });
  const history = newHistory();
  const { finalText } = await runAgent("remember x", { llm, tools, history });

  assert.equal(finalText, "done");
  assert.equal(tools.dispatched.length, 1);
  assert.deepEqual(tools.dispatched[0], { name: "remember", args: { subject: "x", content: "y" } });

  // A role:tool message must carry the matching tool_call_id.
  const toolMsg = history.find((m) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "call_1");
  assert.equal(toolMsg.content, "Remembered (id=abc).");
});

test("a failed tool becomes an ERROR tool message, not a thrown exception", async () => {
  const llm = scriptedLLM([
    {
      role: "assistant",
      tool_calls: [{ id: "c1", function: { name: "boom", arguments: "{}" } }],
    },
    { role: "assistant", content: "recovered" },
  ]);
  const tools = fakeTools({
    boom: async () => {
      throw new Error("kaboom");
    },
  });
  const history = newHistory();
  const { finalText } = await runAgent("go", { llm, tools, history });

  assert.equal(finalText, "recovered");
  const toolMsg = history.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /ERROR: boom failed: kaboom/);
});

test("unparseable tool arguments yield an ERROR tool message", async () => {
  const llm = scriptedLLM([
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "remember", arguments: "{not json" } }] },
    { role: "assistant", content: "ok" },
  ]);
  const tools = fakeTools({ remember: async () => "should not run" });
  const history = newHistory();
  await runAgent("go", { llm, tools, history });

  assert.equal(tools.dispatched.length, 0, "dispatch must not run on unparseable args");
  const toolMsg = history.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /ERROR: could not parse arguments/);
});

test("an unknown tool name yields an ERROR tool message", async () => {
  const llm = scriptedLLM([
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "nope", arguments: "{}" } }] },
    { role: "assistant", content: "ok" },
  ]);
  const tools = fakeTools({ remember: async () => "x" });
  const history = newHistory();
  await runAgent("go", { llm, tools, history });
  const toolMsg = history.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /ERROR: unknown tool "nope"/);
});

test("a fatal LLM error ends the turn cleanly with a helpful message", async () => {
  const llm = {
    chat: async () => {
      throw new Error("Could not reach http://x/v1");
    },
  };
  const tools = fakeTools();
  const history = newHistory();
  const events = [];
  const { finalText } = await runAgent("hi", { llm, tools, history, onEvent: (e) => events.push(e) });

  assert.match(finalText, /LLM call failed: Could not reach/);
  assert.ok(events.some((e) => e.type === "error" && e.scope === "llm"));
});

test("respects maxIterations when the model keeps calling tools", async () => {
  // A model that always asks for the same tool, never finishing.
  const loopingLLM = {
    calls: 0,
    chat() {
      this.calls++;
      return Promise.resolve({
        role: "assistant",
        tool_calls: [{ id: "c" + this.calls, function: { name: "spin", arguments: "{}" } }],
      });
    },
  };
  const tools = fakeTools({ spin: async () => "spun" });
  const history = newHistory();
  const { finalText } = await runAgent("go", { llm: loopingLLM, tools, history, maxIterations: 3 });

  assert.equal(loopingLLM.calls, 3);
  assert.match(finalText, /Stopped after 3 reasoning steps/);
});

test("synthesizes a tool_call_id when the model omits one", async () => {
  const llm = scriptedLLM([
    // tool_call with NO id field
    { role: "assistant", tool_calls: [{ function: { name: "remember", arguments: "{}" } }] },
    { role: "assistant", content: "ok" },
  ]);
  const tools = fakeTools({ remember: async () => "done" });
  const history = newHistory();
  await runAgent("go", { llm, tools, history });

  const toolMsg = history.find((m) => m.role === "tool");
  assert.ok(toolMsg.tool_call_id, "tool_call_id must not be undefined/empty");
  assert.notEqual(toolMsg.tool_call_id, undefined);
});
