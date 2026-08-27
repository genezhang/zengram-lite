// Adapter test for the CodeMirror editor wrapper (console/editor.mjs), run under
// happy-dom so CodeMirror gets a real DOM. Verifies the textarea-like surface the
// playground relies on. Requires the vendor bundle (harness/vendor/codemirror.mjs)
// and happy-dom (editor/node_modules, a devDependency):
//
//   (from crates/zeta-wasm/harness/) bun console/editor.test.mjs
//
// If happy-dom isn't installed (cd editor && bun install), the test skips with a
// clear message rather than failing — the bundle + adapter still ship.

let Window;
try {
  ({ Window } = await import("../editor/node_modules/happy-dom/lib/index.js"));
} catch {
  console.log("SKIP: happy-dom not installed (cd editor && bun install) — adapter DOM test skipped");
  process.exit(0);
}

const win = new Window({ url: "http://localhost/" });
for (const k of [
  "document", "navigator", "getComputedStyle", "requestAnimationFrame",
  "cancelAnimationFrame", "DOMRect", "MutationObserver", "ResizeObserver",
]) {
  globalThis[k] = win[k];
}
globalThis.window = win;

const { mountEditor } = await import("./editor.mjs");

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("FAIL:", m); fails++; } };

const parent = win.document.createElement("div");
win.document.body.appendChild(parent);

let ran = 0, ranAll = 0;
const histCalls = [];
const ed = mountEditor({
  parent,
  doc: "SELECT 1;",
  dark: false,
  onRun: () => ran++,
  onRunAll: () => ranAll++,
  onHistory: (dir) => { histCalls.push(dir); return true; },
});

// value get/set
ok(ed.value === "SELECT 1;", `initial value (got ${JSON.stringify(ed.value)})`);
ed.value = "SELECT 42 AS answer;";
ok(ed.value === "SELECT 42 AS answer;", `value set (got ${JSON.stringify(ed.value)})`);

// selection: textarea-compatible offsets, with clamping
ed.selectionStart = 0;
ed.selectionEnd = 6;
ok(ed.selectionStart === 0 && ed.selectionEnd === 6, `selection set (${ed.selectionStart},${ed.selectionEnd})`);
ed.selectionStart = 9999;
ok(ed.selectionStart <= ed.value.length, "selection clamps to doc end");

// theme swap + focus don't throw
ed.setDark(true);
ed.setDark(false);
ok(true, "setDark toggles without throwing");
ed.focus();
ok(true, "focus() works");

console.log(fails === 0
  ? "OK: editor adapter surface works (value/selection/focus/theme)"
  : `${fails} FAILURES`);
process.exitCode = fails ? 1 : 0;
