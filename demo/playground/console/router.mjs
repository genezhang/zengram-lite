// Statement router for the zengram-lite playground.
//
// The zeta-wasm JS API (src/bindings.rs) is SPLIT by statement kind — there is no
// single `exec(sql)`: SELECTs go through `db.query`, INSERT/UPDATE/DELETE through
// `db.execMut`, and CREATE/DROP/ALTER through `db.execDdl`. An interactive console
// takes one SQL string and must send it to the right method. This module is that
// glue, kept pure (no DOM, no wasm import) so it can be unit-tested under Node —
// see router.test.mjs. The page (playground.html) owns the DOM; format.mjs owns
// presentation.
//
// Autocommit model: each top-level statement runs independently, exactly like
// psql's default. Interactive multi-statement transactions (BEGIN … COMMIT typed
// into the editor) are intentionally NOT modelled here — the concurrency demo in
// the page drives real `db.begin()` handles instead. See harness/README.md.

/**
 * Leading-keyword → dispatch kind. The engine ultimately decides validity; this
 * only routes to the correct ZetaDb method. Anything not listed defaults to
 * `query`, so SHOW / EXPLAIN / VALUES / TABLE / bare function calls / pragma-like
 * statements all take the read path (which returns rows) rather than erroring on
 * the DDL path (which returns nothing).
 */
const KEYWORD_KIND = {
  // read path → db.query → { columns, rows }
  select: "query",
  with: "query",
  explain: "query",
  show: "query",
  values: "query",
  table: "query",
  // mutation path → db.execMut → affected-row count
  insert: "mut",
  update: "mut",
  delete: "mut",
  // DDL path → db.execDdl → no result set
  create: "ddl",
  drop: "ddl",
  alter: "ddl",
  truncate: "ddl",
  comment: "ddl",
  reindex: "ddl",
  // transaction-control keywords: recognized so the page can warn instead of
  // silently misrouting them (autocommit runs each statement on its own txn).
  begin: "txn",
  start: "txn",
  commit: "txn",
  rollback: "txn",
  savepoint: "txn",
  release: "txn",
  end: "txn",
};

/**
 * Strip leading whitespace and leading SQL comments (`-- line` and block
 * `/* … *\/`) so the first *real* token can be read. Only leads are stripped;
 * comments later in the statement are left for the engine.
 * @param {string} sql
 * @returns {string}
 */
function stripLeading(sql) {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2);
    }
    if (s === before) return s;
  }
}

/**
 * Blank out every string literal, quoted identifier, dollar-quoted body, and
 * comment in a statement, replacing their contents with spaces (length is not
 * preserved; only "is this a top-level keyword" matters to callers). Used to
 * detect a *top-level* keyword (e.g. RETURNING) without matching one that sits
 * inside a string or comment. Shares the same scanner shape as
 * {@link splitStatements}.
 * @param {string} sql
 * @returns {string}
 */
function stripQuotesAndComments(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      i += 1;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const close = sql.indexOf(marker, i + marker.length);
        i = close === -1 ? n : close + marker.length;
        out += " ";
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * True if a mutation statement has a top-level `RETURNING` clause (so it returns
 * a row set and must take the read path to render it). Matches `RETURNING`
 * outside any string/identifier/dollar-quote/comment.
 * @param {string} sql
 * @returns {boolean}
 */
function hasReturning(sql) {
  return /\breturning\b/i.test(stripQuotesAndComments(sql));
}

/**
 * Parse the value of a `SET <var> = <value>` / `TO <value>` session command
 * into a normalized target, shared by {@link parseBranchCommand} and
 * {@link parseDatabaseCommand}. Accepts exactly one of:
 *   - a single-quoted or double-quoted string (doubled quote = escaped): the
 *     WHOLE remainder must be that one quoted token — trailing junk after the
 *     closing quote (`'a' WHERE`, `'a' 'b'`, `'a' -- c`) is REJECTED, matching
 *     the server parser which requires exactly one string value.
 *   - a bare single-token identifier (`SET database = tenant_a`) — more lenient
 *     than the server, but convenient in a console.
 *   - `DEFAULT` (case-insensitive) → `{ value: null }` (return to default).
 * An empty quoted value `''` → `{ value: null }`.
 *
 * @param {string} raw the text after `=`/`TO`, already trimmed.
 * @returns {{value: string|null}|null} the parsed value, or null if malformed
 *   (caller then leaves the statement to normal SQL routing).
 */
function parseSessionValue(raw) {
  const v = raw.trim();
  if (/^default$/i.test(v)) return { value: null };
  const q = v[0];
  if (q === "'" || q === '"') {
    // Walk to the matching close, treating a doubled quote as an escape. The
    // close must be the LAST character — otherwise there is trailing junk.
    let i = 1;
    let out = "";
    for (; i < v.length; i++) {
      if (v[i] === q) {
        if (v[i + 1] === q) { out += q; i++; continue; } // escaped quote
        break; // closing quote
      }
      out += v[i];
    }
    if (i !== v.length - 1) return null; // unterminated, or junk after close
    return { value: out === "" ? null : out };
  }
  // Bare identifier: a single token, no whitespace/quotes.
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(v)) return { value: v };
  return null;
}

/**
 * Recognize a session-branch control statement and extract its target, so the
 * console can honor `SET zeta_branch` the way the pgwire handler does at the
 * session layer. The embedded engine rejects `SET zeta_branch` on the SQL path
 * ("requires a client session; embedded callers use execute_sql_on_branch"), so
 * without this intercept the console could never *select* a branch — and the
 * branch indicator would be permanently unreachable.
 *
 * Matches (case-insensitive, optional trailing `;`):
 *   SET zeta_branch = 'name'   |  SET zeta_branch TO 'name'   → select "name"
 *   SET zeta_branch = "name"   |  SET zeta_branch = name      → select "name"
 *   RESET zeta_branch          |  SET zeta_branch = DEFAULT   → back to main (null)
 * Trailing junk after a quoted value is rejected (see {@link parseSessionValue}).
 *
 * @param {string} sql a single statement (already comment/space-stripped is fine)
 * @returns {{branch: string|null}|null} the target (null = main), or null if not
 *   a zeta_branch control statement.
 */
export function parseBranchCommand(sql) {
  const s = stripLeading(sql).replace(/;\s*$/, "").trim();
  if (/^reset\s+zeta_branch$/i.test(s)) return { branch: null };
  const m = /^set\s+zeta_branch\s*(?:=|\bto\b)\s*(.+)$/is.exec(s);
  if (!m) return null;
  const parsed = parseSessionValue(m[1]);
  return parsed ? { branch: parsed.value } : null;
}

/**
 * Recognize a connected-database control statement and extract the target, so
 * the console can switch the current database. Mirrors {@link parseBranchCommand}
 * and the pgwire handler's `configure_database`. The embedded SQL path has no
 * `USE`/`SET database`, so this intercept is the only way to switch.
 *
 * Matches (case-insensitive, optional trailing `;`):
 *   USE <db>                    |  USE 'db'                    → select "db"
 *   SET database = 'db'         |  SET database TO 'db'        → select "db"
 *   SET database = db           |  (bare identifier)           → select "db"
 *   RESET database              |  SET database = DEFAULT      → default (null)
 * `"zeta"` (the system-default) is normalized to null by the engine's
 * `set_database`. Trailing junk after a quoted value is rejected.
 *
 * @param {string} sql a single statement.
 * @returns {{database: string|null}|null} the target (null = default), or null
 *   if not a database control statement.
 */
export function parseDatabaseCommand(sql) {
  const s = stripLeading(sql).replace(/;\s*$/, "").trim();
  if (/^reset\s+database$/i.test(s)) return { database: null };
  // USE <db>
  const useM = /^use\s+(.+)$/is.exec(s);
  if (useM) {
    const parsed = parseSessionValue(useM[1]);
    return parsed ? { database: parsed.value } : null;
  }
  // SET database = <value> / TO <value>
  const setM = /^set\s+database\s*(?:=|\bto\b)\s*(.+)$/is.exec(s);
  if (setM) {
    const parsed = parseSessionValue(setM[1]);
    return parsed ? { database: parsed.value } : null;
  }
  return null;
}

/**
 * Classify a single SQL statement by its leading keyword.
 * @param {string} sql
 * @returns {"query"|"mut"|"ddl"|"txn"|"empty"}
 */
export function classify(sql) {
  const s = stripLeading(sql);
  if (s === "") return "empty";
  // First alphabetic token (letters only — enough to key the table).
  const m = /^[a-zA-Z]+/.exec(s);
  if (!m) return "query"; // starts with `(`, a number, etc. — read path.
  const kind = KEYWORD_KIND[m[0].toLowerCase()] ?? "query";
  // INSERT/UPDATE/DELETE … RETURNING returns a row set, so it must go through the
  // read path (db.query) — the engine runs the mutation AND returns the rows.
  // Routed to execMut it would run correctly but the returned rows would be
  // discarded into an affected-count, silently dropping what the user asked to
  // see. RETURNING is only meaningful on those DML statements.
  if (kind === "mut" && hasReturning(s)) return "query";
  return kind;
}

/**
 * Split a multi-statement buffer into individual statements on top-level `;`,
 * honoring string/identifier quoting, dollar-quoting, and comments so a `;`
 * inside any of them does not split. Trailing text with no final `;` is returned
 * as a statement. Empty/blank fragments are dropped.
 *
 * @param {string} buffer
 * @returns {string[]}
 */
export function splitStatements(buffer) {
  return splitStatementSpans(buffer).map((s) => s.text);
}

/**
 * Like {@link splitStatements}, but returns each statement with the byte range
 * it occupies in the original buffer: `{ text, start, end, contentStart }` where
 * `[start,end)` spans the fragment INCLUDING its terminating `;`, and
 * `contentStart` is the absolute offset where the fragment's first executable
 * character begins (i.e. after any leading whitespace/comments). Used by the
 * editor's run-at-cursor mapping so a cursor sitting in a trailing comment maps
 * to the statement that comment follows — not the next one: the cursor is
 * attributed to the last statement whose `contentStart` is at or before it, so
 * the comment gap between one statement's `;` and the next statement's keyword
 * belongs to the statement above it.
 *
 * Empty/blank fragments (a run of whitespace/comments with no statement) are
 * dropped, exactly as `splitStatements` does, so the spans returned are only the
 * executable statements. The gap a dropped fragment leaves is attributed to the
 * PRECEDING statement's trailing region by the cursor-mapping logic.
 *
 * @param {string} buffer
 * @returns {{text: string, start: number, end: number, contentStart: number}[]}
 */
export function splitStatementSpans(buffer) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = buffer.length;

  // `contentEnd` excludes the terminating `;` (so `text` matches the historical
  // `splitStatements` contract — no trailing `;`), while `spanEnd` includes it
  // (so the byte range `[start, spanEnd)` covers the whole fragment for cursor
  // mapping). A fragment that is only whitespace/comments — or only a bare `;`
  // — classifies as "empty" and is dropped.
  const push = (from, contentEnd, spanEnd) => {
    const text = buffer.slice(from, contentEnd);
    if (classify(text) === "empty") return;
    // Offset of the first executable char: length of leading whitespace/comments.
    const contentStart = from + (text.length - stripLeading(text).length);
    out.push({ text, start: from, end: spanEnd, contentStart });
  };

  while (i < n) {
    const c = buffer[i];

    // Line comment: skip to end of line.
    if (c === "-" && buffer[i + 1] === "-") {
      const nl = buffer.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // Block comment: skip to closing */ (not nested — matches Postgres' lexer
    // closely enough for splitting; real nesting is rare in a console buffer).
    if (c === "/" && buffer[i + 1] === "*") {
      const end = buffer.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // Single- or double-quoted string/identifier: skip to the matching close,
    // treating a doubled quote ('' or "") as an escaped literal quote.
    if (c === "'" || c === '"') {
      i += 1;
      while (i < n) {
        if (buffer[i] === c) {
          if (buffer[i + 1] === c) {
            i += 2; // escaped quote inside the literal
            continue;
          }
          i += 1; // closing quote
          break;
        }
        i += 1;
      }
      continue;
    }
    // Dollar-quoted string: $tag$ … $tag$ (tag may be empty: $$ … $$).
    if (c === "$") {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(buffer.slice(i));
      if (tag) {
        const marker = tag[0];
        const close = buffer.indexOf(marker, i + marker.length);
        i = close === -1 ? n : close + marker.length;
        continue;
      }
    }
    // Statement terminator at top level. `text` ends before the `;` (matching
    // the historical contract); the span's `end` includes the `;` so a same-line
    // trailing comment after the `;` belongs to the NEXT fragment's leading
    // region — correct, since it trails nothing executable on this side.
    if (c === ";") {
      push(start, i, i + 1);
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  // Trailing statement with no closing semicolon.
  if (start < n) push(start, n, n);

  return out;
}

/**
 * Map a cursor offset in `buffer` to the statement the cursor is "in", for the
 * editor's run-at-cursor (⌘/Ctrl+Enter). Returns the trimmed statement text, or
 * `""` if the buffer has no executable statement.
 *
 * The rule that fixes the trailing-comment trap: the cursor is attributed to the
 * LAST statement whose executable content begins at or before `pos`. So a cursor
 * anywhere on the line `SET x = 1;   -- note` — including inside the `-- note`
 * comment, which lexically belongs to the following statement's fragment — maps
 * to `SET x = 1`, never to the statement below. A cursor before the first
 * statement's keyword (leading comment/blank lines) maps to the first statement.
 *
 * @param {string} buffer
 * @param {number} pos  cursor offset (e.g. textarea.selectionStart)
 * @returns {string}
 */
export function statementAtCursor(buffer, pos) {
  const spans = splitStatementSpans(buffer);
  if (spans.length === 0) return "";
  // Last statement whose content starts at or before the cursor (the first
  // statement if the cursor precedes them all). Single-statement buffers fall
  // through this to the same result.
  let chosen = spans[0];
  for (const s of spans) {
    if (s.contentStart <= pos) chosen = s;
    else break;
  }
  // Return from the executable content, dropping any leading comment/whitespace
  // that lexically belongs to this fragment but visually trails the statement
  // above — so the run label shows just the statement.
  return buffer.slice(chosen.contentStart, chosen.end).trim();
}

/**
 * A normalized result from running one statement.
 * @typedef {Object} RunResult
 * @property {"query"|"mut"|"ddl"|"txn"} kind
 * @property {string} sql            the statement that was run (trimmed)
 * @property {string[]} [columns]    present for kind "query"
 * @property {Object[]} [rows]       present for kind "query"
 * @property {number} [affected]     present for kind "mut"
 * @property {number} ms             wall-clock duration
 * @property {string} [error]        engine error message, if the statement failed
 */

/**
 * Read a monotonic millisecond clock if available, else fall back to Date.now.
 * (Node and browsers both have performance.now; the fallback keeps this module
 * runnable in any minimal JS host for testing.)
 */
function nowMs() {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

/**
 * Run one SQL statement against a ZetaDb-like handle, dispatching by kind and
 * normalizing the outcome. `db` must expose `query(sql, params?)`,
 * `execMut(sql, params?)`, and `execDdl(sql)` (the shipped ZetaDb surface, or a
 * ZetaTxn — same method names). Never throws: an engine error is captured into
 * `result.error` so the caller can render it and keep going.
 *
 * `txn`-classified statements are reported as an error rather than executed —
 * the console is autocommit and cannot honor an interactive BEGIN/COMMIT; the
 * page surfaces this as guidance toward the concurrency demo.
 *
 * @param {{query:Function, execMut:Function, execDdl:Function}} db
 * @param {string} sql
 * @returns {RunResult}
 */
export function run(db, sql) {
  const trimmed = sql.trim();
  const t0 = nowMs();

  // Session-branch control (`SET zeta_branch = '…'` / `RESET zeta_branch`) is
  // intercepted here and routed to db.setBranch, mirroring the pgwire handler's
  // session-layer handling. The embedded SQL path rejects these, so this is the
  // only way the console can switch branches. Reported as a "ddl"-shaped result
  // (no rows) so the page renders a plain confirmation line.
  if (typeof db.setBranch === "function") {
    const bc = parseBranchCommand(trimmed);
    if (bc) {
      try {
        db.setBranch(bc.branch);
        return { kind: "ddl", sql: trimmed, ms: nowMs() - t0 };
      } catch (e) {
        return {
          kind: "ddl",
          sql: trimmed,
          ms: nowMs() - t0,
          error: e && e.message ? e.message : String(e),
        };
      }
    }
  }

  // Connected-database control (`USE <db>` / `SET database = '…'` /
  // `RESET database`) is intercepted and routed to db.setDatabase — the
  // embedded SQL path has no such statement, so this is the only way to switch
  // the current database. Same "ddl"-shaped confirmation as the branch case.
  if (typeof db.setDatabase === "function") {
    const dc = parseDatabaseCommand(trimmed);
    if (dc) {
      try {
        db.setDatabase(dc.database);
        return { kind: "ddl", sql: trimmed, ms: nowMs() - t0 };
      } catch (e) {
        return {
          kind: "ddl",
          sql: trimmed,
          ms: nowMs() - t0,
          error: e && e.message ? e.message : String(e),
        };
      }
    }
  }

  const kind = classify(trimmed);
  try {
    switch (kind) {
      case "query": {
        const r = db.query(trimmed);
        return {
          kind,
          sql: trimmed,
          columns: r.columns ?? [],
          rows: r.rows ?? [],
          ms: nowMs() - t0,
        };
      }
      case "mut": {
        const affected = db.execMut(trimmed);
        return { kind, sql: trimmed, affected: Number(affected ?? 0), ms: nowMs() - t0 };
      }
      case "ddl": {
        db.execDdl(trimmed);
        return { kind, sql: trimmed, ms: nowMs() - t0 };
      }
      default: {
        // "txn" (or "empty", which the caller filters out before calling).
        return {
          kind: "txn",
          sql: trimmed,
          ms: nowMs() - t0,
          error:
            "Interactive BEGIN/COMMIT isn't supported in the console — it runs " +
            "each statement in its own transaction (autocommit). Use the " +
            "Concurrent-transaction demo to see overlapping snapshot-isolated " +
            "transactions.",
        };
      }
    }
  } catch (e) {
    return {
      kind: kind === "empty" ? "query" : kind,
      sql: trimmed,
      ms: nowMs() - t0,
      error: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * Run every statement in a buffer in order, returning one RunResult each. Stops
 * early only if a statement errors AND `stopOnError` is true (default false — the
 * console shows every result, like psql without ON_ERROR_STOP).
 *
 * @param {{query:Function, execMut:Function, execDdl:Function}} db
 * @param {string} buffer
 * @param {{stopOnError?: boolean}} [opts]
 * @returns {RunResult[]}
 */
export function runAll(db, buffer, opts = {}) {
  const results = [];
  for (const stmt of splitStatements(buffer)) {
    const r = run(db, stmt);
    results.push(r);
    if (opts.stopOnError && r.error) break;
  }
  return results;
}
