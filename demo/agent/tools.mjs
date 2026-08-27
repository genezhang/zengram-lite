// Tool registry for the browser agent.
//
// makeTools() wires the agent's capabilities to concrete backends — memory
// (zengram-lite), files (OPFS), and the web. Dependencies are injected so this
// module unit-tests in Node with fakes. Every dispatch() returns a STRING: the
// agent loop appends it verbatim as a `role:"tool"` message, so the model reads
// exactly what we return here.

const FILE_PREFIX = "agentfile__"; // agent file-tool blobs are namespaced in OPFS
const MAX_TEXT = 8192; // cap tool text results to bound token cost
const MAX_ROWS = 50; // cap query() rows

/** Reject path traversal / nesting so a file name is a single flat OPFS key. */
function safeFileName(path) {
  const p = String(path || "").trim();
  if (!p) throw new Error("empty file path");
  if (/[/\\]/.test(p)) throw new Error("file path must not contain slashes");
  if (p.includes("..")) throw new Error("file path must not contain '..'");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) throw new Error("file path must not contain control characters");
  return p;
}

function truncate(text, max = MAX_TEXT) {
  const s = String(text);
  return s.length > max ? s.slice(0, max) + `\n…(truncated, ${s.length - max} more chars)` : s;
}

/**
 * @param {object} deps
 * @param {object} deps.mem     ZengramMemory instance (rememberWithVector/recallWithVector/confirm/contradict/query)
 * @param {string} deps.scope   memory scope string
 * @param {(text:string)=>Promise<Float32Array>} deps.embed  async embedder (HTTP)
 * @param {object} deps.opfs    { writeFileText, readFileText, listFiles, deleteFromOpfs }
 * @param {typeof fetch} deps.fetchImpl
 */
export function makeTools({ mem, scope, embed, opfs, fetchImpl = globalThis.fetch }) {
  // Each entry: { schema, run(args) -> Promise<string> }.
  const registry = {
    remember: {
      schema: {
        name: "remember",
        description:
          "Store a durable fact or user preference in long-term semantic memory. Use when the user states something worth recalling later.",
        parameters: {
          type: "object",
          properties: {
            subject: { type: "string", description: "A short label for the fact (e.g. 'editor prefs')." },
            content: { type: "string", description: "The fact itself, in a sentence." },
          },
          required: ["subject", "content"],
          additionalProperties: false,
        },
      },
      async run({ subject, content }) {
        const vec = await embed(subject + ": " + content);
        const id = mem.rememberWithVector(subject, content, scope, vec);
        return `Remembered (id=${id}).`;
      },
    },

    recall: {
      schema: {
        name: "recall",
        description:
          "Search long-term memory by meaning for facts relevant to a query. Prefer this before answering questions about the user.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for, in natural language." },
            limit: { type: "integer", description: "Max results (default 5).", minimum: 1, maximum: 20 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      async run({ query, limit }) {
        const vec = await embed(query);
        const hits = (mem.recallWithVector(query, scope, vec) || []).slice(0, limit || 5);
        if (!hits.length) return "No relevant memories.";
        return (
          `Found ${hits.length} ${hits.length === 1 ? "memory" : "memories"}:\n` +
          hits
            .map(
              (h, i) =>
                `${i + 1}. [id=${h.knowledgeId}, score=${Number(h.score).toFixed(2)}] ${h.content}`,
            )
            .join("\n")
        );
      },
    },

    confirm: {
      schema: {
        name: "confirm",
        description:
          "Reinforce a remembered fact the user validated (raises its confidence). Pass the id from a recall result.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "The knowledge id to confirm." } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      async run({ id }) {
        mem.confirm(id);
        return `Confirmed ${id}.`;
      },
    },

    contradict: {
      schema: {
        name: "contradict",
        description:
          "Weaken a remembered fact the user corrected (lowers its confidence). To store the correction, also call remember.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "The knowledge id to contradict." } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      async run({ id }) {
        mem.contradict(id);
        return `Contradicted ${id}.`;
      },
    },

    query: {
      schema: {
        name: "query",
        description:
          "Run a read-only SQL SELECT over the memory database. Tables include `knowledge` (id, subject, content, scope, confidence, importance, status, …). Use $1,$2 placeholders with the params array.",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string", description: "A single SELECT statement." },
            params: { type: "array", description: "Positional bind values for $1,$2,…", items: {} },
          },
          required: ["sql"],
          additionalProperties: false,
        },
      },
      async run({ sql, params }) {
        if (!/^\s*select\b/i.test(sql)) {
          throw new Error("query is read-only: only SELECT is allowed (use remember/confirm to write)");
        }
        // Defense-in-depth: reject stacked statements. The wasm engine already
        // rejects multi-statement input ("expected 1 statement"), but a stripped
        // trailing ";" keeps the model's intent clear and the error friendly.
        if (/;\s*\S/.test(sql)) {
          throw new Error("query must be a single SELECT statement (no ';')");
        }
        const r = mem.query(sql, params || []);
        const rows = (r.rows || []).slice(0, MAX_ROWS);
        const extra = (r.rows || []).length - rows.length;
        const payload = { columns: r.columns, rows };
        return JSON.stringify(payload) + (extra > 0 ? `\n…(${extra} more rows omitted)` : "");
      },
    },

    writeFile: {
      schema: {
        name: "writeFile",
        description: "Write (or overwrite) a text file in the agent's private browser-local file store.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "A flat file name (no slashes)." },
            content: { type: "string", description: "The file's text content." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      async run({ path, content }) {
        const name = safeFileName(path);
        await opfs.writeFileText(FILE_PREFIX + name, String(content));
        return `Wrote ${name} (${String(content).length} chars).`;
      },
    },

    readFile: {
      schema: {
        name: "readFile",
        description: "Read a text file from the agent's private file store.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "The file name to read." } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      async run({ path }) {
        const name = safeFileName(path);
        const text = await opfs.readFileText(FILE_PREFIX + name);
        return text === null ? `No such file: ${name}` : truncate(text);
      },
    },

    listFiles: {
      schema: {
        name: "listFiles",
        description: "List the files in the agent's private file store.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      async run() {
        const names = (await opfs.listFiles())
          .filter((n) => n.startsWith(FILE_PREFIX))
          .map((n) => n.slice(FILE_PREFIX.length));
        return names.length ? names.join("\n") : "(no files)";
      },
    },

    deleteFile: {
      schema: {
        name: "deleteFile",
        description: "Delete a file from the agent's private file store.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "The file name to delete." } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      async run({ path }) {
        const name = safeFileName(path);
        await opfs.deleteFromOpfs(FILE_PREFIX + name);
        return `Deleted ${name}.`;
      },
    },

    webFetch: {
      schema: {
        name: "webFetch",
        description:
          "Fetch a URL over HTTP(S) and return its text content. Subject to the target site's CORS policy.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "An http(s) URL." } },
          required: ["url"],
          additionalProperties: false,
        },
      },
      async run({ url }) {
        const u = new URL(url); // throws on a bad URL → caught by the loop
        if (!/^https?:$/.test(u.protocol)) throw new Error("only http/https URLs are allowed");
        const res = await fetchImpl(u.href);
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${u.href}`);
        return truncate(await res.text());
      },
    },
  };

  const schemas = Object.values(registry).map((t) => ({ type: "function", function: t.schema }));

  return {
    schemas,
    has(name) {
      return Object.prototype.hasOwnProperty.call(registry, name);
    },
    async dispatch(name, args) {
      if (!this.has(name)) throw new Error(`unknown tool "${name}"`);
      return registry[name].run(args || {});
    },
  };
}

export const _internal = { safeFileName, truncate, FILE_PREFIX };
