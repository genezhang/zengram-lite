// The agent loop.
//
// An agent is a loop, not a model: ask the LLM what to do, run the tools it
// asks for, feed the results back, repeat until it answers. This whole file is
// that loop — dependency-injected (llm, tools, history, onEvent) so it runs the
// same in the browser and in a Node unit test with mocks.

export const SYSTEM_PROMPT = `You are a local browser agent. You run entirely in the user's browser tab, with persistent semantic memory and a private file store. Use your tools:
- Call recall before answering questions about the user; call remember when the user states a durable fact or preference.
- Call confirm or contradict when the user validates or corrects a remembered fact (use the id from a recall result).
- Use the file tools for notes and documents the user wants kept in browser-local storage.
- Use query for read-only SQL over your memory; use webFetch only when asked for content from a specific URL.
Think step by step: call one or more tools, read their results, then reply. When you have enough to answer, reply with a final message and no tool call.`;

/** Seed a fresh conversation history with the system prompt. */
export function newHistory() {
  return [{ role: "system", content: SYSTEM_PROMPT }];
}

/**
 * Run one user turn to completion (possibly many tool round-trips).
 *
 * @param {string} userText
 * @param {object} ctx
 * @param {{chat:(messages:any[],tools:any[])=>Promise<any>}} ctx.llm
 * @param {{schemas:any[], has:(n:string)=>boolean, dispatch:(n:string,a:any)=>Promise<string>}} ctx.tools
 * @param {any[]} ctx.history           persistent across turns; system prompt at index 0
 * @param {(evt:object)=>void} [ctx.onEvent]  UI hook
 * @param {number} [ctx.maxIterations]
 * @returns {Promise<{finalText:string, history:any[]}>}
 */
export async function runAgent(userText, ctx) {
  const { llm, tools, history, onEvent = () => {}, maxIterations = 8 } = ctx;
  history.push({ role: "user", content: userText });

  for (let i = 0; i < maxIterations; i++) {
    onEvent({ type: "iteration", i });

    let msg;
    try {
      msg = await llm.chat(history, tools.schemas);
    } catch (e) {
      // A fatal LLM failure (network/CORS/HTTP) ends the turn cleanly — there's
      // no point looping when we can't reach the brain.
      const message = e && e.message ? e.message : String(e);
      onEvent({ type: "error", scope: "llm", message });
      const finalText = "LLM call failed: " + message;
      history.push({ role: "assistant", content: finalText });
      return { finalText, history };
    }

    // Append the assistant turn verbatim: the tool replies below must follow a
    // message carrying the matching tool_calls[].id, per the OpenAI contract.
    history.push(msg);

    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      const finalText = msg.content == null ? "" : String(msg.content);
      onEvent({ type: "assistant-text", text: finalText });
      return { finalText, history }; // termination: no tools requested
    }

    // Some models narrate alongside a tool call.
    if (msg.content) onEvent({ type: "assistant-text", text: String(msg.content) });

    // Sequential: memory and OPFS mutate shared state, so avoid interleaving.
    for (let ci = 0; ci < calls.length; ci++) {
      const call = calls[ci];
      // A well-behaved server always sends an id; synthesize one if not, so the
      // role:"tool" reply never carries tool_call_id: undefined (which a strict
      // server would reject on the next turn).
      const callId = call.id != null ? call.id : `call_${i}_${ci}`;
      const name = call.function ? call.function.name : undefined;
      const rawArgs = call.function ? call.function.arguments : undefined;

      let args = null;
      try {
        args = JSON.parse(rawArgs || "{}");
      } catch {
        args = null;
      }

      onEvent({ type: "tool-call", id: callId, name, args, raw: rawArgs });

      let resultText;
      if (args === null) {
        resultText = `ERROR: could not parse arguments as JSON: ${rawArgs}`;
      } else if (!name || !tools.has(name)) {
        resultText = `ERROR: unknown tool "${name}"`;
      } else {
        try {
          resultText = await tools.dispatch(name, args);
        } catch (e) {
          // A failed tool is not fatal — feed the error back so the model can
          // recover, apologize, or try something else.
          resultText = `ERROR: ${name} failed: ${e && e.message ? e.message : String(e)}`;
        }
      }

      onEvent({ type: "tool-result", id: callId, name, text: resultText });
      history.push({ role: "tool", tool_call_id: callId, content: resultText });
    }
    // Loop: the model sees the tool results on the next round.
  }

  const finalText = `Stopped after ${maxIterations} reasoning steps without a final answer.`;
  onEvent({ type: "error", scope: "loop", message: finalText });
  history.push({ role: "assistant", content: finalText });
  return { finalText, history };
}
