// Presentation helpers for the zengram-lite playground.
//
// Pure JS, no DOM: these turn engine values and RunResults (from router.mjs) into
// plain strings / data structures. The page (playground.html) creates the actual
// <table>/<td> elements from what these return, so this stays unit-testable and
// framework-free. Value mapping matches zeta-wasm's convert.rs (value_to_json):
// numbers stay numbers, DateTime/Decimal/Uuid arrive as strings, JSONB as a
// nested object/array, BYTEA/VECTOR as a number array.

/** The glyph shown for a SQL NULL (distinct from an empty string). */
export const NULL_GLYPH = "∅";

/**
 * Render one cell value to a display string. Objects/arrays become compact JSON;
 * null/undefined become the NULL glyph; everything else is String()-ified.
 * @param {*} v
 * @returns {string}
 */
export function valueText(v) {
  if (v === null || v === undefined) return NULL_GLYPH;
  if (typeof v === "object") {
    // JSONB objects/arrays, VECTOR/BYTEA number arrays.
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * A cell descriptor for the page to render: the display text, whether it is a
 * NULL (for dimmed styling), whether it is numeric (for right-align + tabular
 * figures), and a full-value title for hover when truncated.
 * @typedef {Object} Cell
 * @property {string} text
 * @property {boolean} isNull
 * @property {boolean} isNumber
 * @property {string} title
 */

/**
 * Build a {@link Cell} descriptor for a raw value.
 * @param {*} v
 * @returns {Cell}
 */
export function valueCell(v) {
  const isNull = v === null || v === undefined;
  const isNumber = typeof v === "number";
  const text = valueText(v);
  return { text, isNull, isNumber, title: isNull ? "NULL" : text };
}

/**
 * Turn a query RunResult into a grid: column names plus a matrix of Cells in
 * column order (row objects don't guarantee key order, so we index by the
 * result's `columns`). Non-query results yield an empty grid.
 * @param {import("./router.mjs").RunResult} result
 * @returns {{columns: string[], rows: Cell[][]}}
 */
export function resultToGrid(result) {
  const columns = result.columns ?? [];
  const rows = (result.rows ?? []).map((row) =>
    columns.map((c) => valueCell(row[c])),
  );
  return { columns, rows };
}

/**
 * Serialize one field to a CSV value (RFC 4180): a field containing a comma,
 * double-quote, or newline is wrapped in double-quotes with embedded quotes
 * doubled. NULL becomes an empty (unquoted) field. Objects/arrays serialize as
 * their compact JSON (then quoted as needed).
 * @param {*} v  raw cell value (not the display glyph)
 * @returns {string}
 */
export function csvField(v) {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Serialize a query RunResult to a CSV string: a header row of column names
 * followed by one row per result row, using raw values (not the display glyph),
 * CRLF line endings per RFC 4180. Returns "" for a non-query / column-less result.
 * @param {import("./router.mjs").RunResult} result
 * @returns {string}
 */
export function resultToCsv(result) {
  const columns = result.columns ?? [];
  if (columns.length === 0) return "";
  const lines = [columns.map(csvField).join(",")];
  for (const row of result.rows ?? []) {
    lines.push(columns.map((c) => csvField(row[c])).join(","));
  }
  return lines.join("\r\n");
}

/**
 * Format a duration in ms for the status line: sub-millisecond as microseconds,
 * otherwise millisecond precision.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

/**
 * The command-tag / status string for a RunResult, mirroring psql's tags:
 * `SELECT 3 · 0.4 ms`, `INSERT 2 · 0.1 ms`, `CREATE TABLE · 0.2 ms`, or an
 * `ERROR: …` line. Uses the leading SQL keyword for the DDL/mut verb.
 * @param {import("./router.mjs").RunResult} result
 * @returns {string}
 */
export function statusLine(result) {
  const dur = formatDuration(result.ms);
  if (result.error) return `ERROR: ${result.error}`;
  switch (result.kind) {
    case "query": {
      const n = result.rows ? result.rows.length : 0;
      return `${n} ${n === 1 ? "row" : "rows"} · ${dur}`;
    }
    case "mut": {
      const verb = leadingVerb(result.sql);
      return `${verb} ${result.affected ?? 0} · ${dur}`;
    }
    case "ddl": {
      return `${commandTag(result.sql)} · ${dur}`;
    }
    default:
      return dur;
  }
}

/**
 * The uppercased leading keyword of a statement (e.g. "INSERT", "UPDATE").
 * @param {string} sql
 * @returns {string}
 */
function leadingVerb(sql) {
  const m = /^\s*([a-zA-Z]+)/.exec(sql);
  return m ? m[1].toUpperCase() : "OK";
}

/**
 * A two-word command tag for common DDL (CREATE TABLE, DROP INDEX, ALTER TABLE),
 * else just the leading verb.
 * @param {string} sql
 * @returns {string}
 */
function commandTag(sql) {
  const m = /^\s*([a-zA-Z]+)\s+([a-zA-Z]+)/.exec(sql);
  if (m) {
    const verb = m[1].toUpperCase();
    if (verb === "CREATE" || verb === "DROP" || verb === "ALTER" || verb === "TRUNCATE") {
      return `${verb} ${m[2].toUpperCase()}`;
    }
  }
  return leadingVerb(sql);
}
