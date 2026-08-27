// OpenAI-compatible LLM adapter for the browser agent.
//
// One HTTP shape talks to every serious local engine AND the hosted APIs:
// llama.cpp `llama-server` (:8080/v1), LM Studio (:1234/v1), OpenAI
// (api.openai.com/v1), or any proxy. The agent's "brain" is just inference we
// call out to — where the matrix multiply happens is the host's business.
//
// Two operations: chat() (reasoning + tool-calling) and embed() (for memory
// vectors), both against the SAME endpoint. probeEmbedDim() reads the embedding
// dimension once at boot so memory opens at the model's dimension.

/** Strip a trailing slash so `${baseUrl}/chat/completions` never doubles up. */
function normBase(u) {
  return String(u || "").replace(/\/+$/, "");
}

function authHeaders(config) {
  const h = { "content-type": "application/json" };
  if (config.apiKey) h.authorization = "Bearer " + config.apiKey;
  return h;
}

/**
 * Turn a low-level fetch failure into an actionable message. A rejected fetch
 * (TypeError "Failed to fetch") from the browser almost always means the server
 * isn't running, the URL is wrong, or CORS headers are missing — the three
 * things worth checking, so we say so.
 */
function networkError(baseUrl, e) {
  const detail = e && e.message ? e.message : String(e);
  return new Error(
    `Could not reach ${baseUrl}. Check that (1) your LLM server is running, ` +
      `(2) the base URL is correct, and (3) the server sends CORS headers for ` +
      `this page's origin. llama-server: pass --host 0.0.0.0 and enable CORS ` +
      `(or front it with a CORS proxy); LM Studio: turn on CORS in the server ` +
      `settings. [${detail}]`,
  );
}

/** HTTP-level error with status + a body snippet so 401/404/model-not-found read clearly. */
async function httpError(res) {
  let body = "";
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  return new Error(`HTTP ${res.status} ${res.statusText}${body ? " — " + body : ""}`);
}

/**
 * Build an adapter from a config object. `fetchImpl` is injectable so this
 * module unit-tests in Node with a fake fetch (no network).
 *
 * @param {{baseUrl:string, model:string, embedModel:string, apiKey?:string}} config
 * @param {typeof fetch} [fetchImpl]
 */
export function makeLLM(config, fetchImpl = globalThis.fetch) {
  const base = normBase(config.baseUrl);

  async function chat(messages, tools) {
    let res;
    try {
      res = await fetchImpl(base + "/chat/completions", {
        method: "POST",
        headers: authHeaders(config),
        body: JSON.stringify({
          model: config.model,
          messages,
          tools,
          tool_choice: "auto",
        }),
      });
    } catch (e) {
      throw networkError(base, e);
    }
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error("malformed chat response: no choices[0].message");
    return msg;
  }

  async function embed(text) {
    let res;
    try {
      res = await fetchImpl(base + "/embeddings", {
        method: "POST",
        headers: authHeaders(config),
        body: JSON.stringify({ model: config.embedModel, input: text }),
      });
    } catch (e) {
      throw networkError(base, e);
    }
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    const vec = data && data.data && data.data[0] && data.data[0].embedding;
    if (!Array.isArray(vec)) throw new Error("malformed embeddings response: no data[0].embedding");
    return new Float32Array(vec);
  }

  /** Embed a probe string once to discover the model's vector dimension. */
  async function probeEmbedDim() {
    return (await embed("dimension probe")).length;
  }

  return { chat, embed, probeEmbedDim, config: { ...config, baseUrl: base } };
}

/** Presets for the common OpenAI-compatible servers. */
export const PRESETS = {
  "llama.cpp": "http://localhost:8080/v1",
  "LM Studio": "http://localhost:1234/v1",
  OpenAI: "https://api.openai.com/v1",
};

export const DEFAULT_CONFIG = {
  baseUrl: "http://localhost:8080/v1",
  model: "local-model",
  embedModel: "local-embed",
  apiKey: "",
};

// Exported for unit tests.
export const _internal = { normBase, networkError };
