// CodeMirror editor adapter for the zengram-lite playground.
//
// Wraps a CodeMirror 6 EditorView behind a small textarea-like surface, so the
// page (playground.html) keeps talking to `.value` / `.selectionStart` /
// `.focus()` and doesn't sprinkle CodeMirror internals everywhere. One seam.
//
// The lean CodeMirror pieces come from ../vendor/codemirror.mjs (built by
// editor/build.sh). This module adds: PostgreSQL syntax highlighting, a
// theme-aware highlight/base style (swapped via a Compartment on theme change),
// bracket matching, undo/redo, Tab-inserts-two-spaces, and app keybindings
// (run / run-all / command-history ↑↓) driven by callbacks the page supplies.

import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  placeholder,
  EditorState,
  Compartment,
  sql,
  PostgreSQL,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  tags as t,
  defaultKeymap,
  history,
  historyKeymap,
} from "../vendor/codemirror.mjs";

// Light and dark highlight styles, expressed through CodeMirror's tag system so a
// single Compartment swap recolors syntax on theme change. Colors are picked to
// match the playground's amber-on-slate palette (kept in sync by eye, not tokens,
// since CodeMirror can't read CSS custom properties for its highlight style).
function highlightStyleFor(dark) {
  const c = dark
    ? { kw: "#f0b354", str: "#7fd69a", num: "#e0a4ff", com: "#6c7a90", fn: "#82b8ff", op: "#c8d2e0", type: "#5fd3c0" }
    : { kw: "#b5730f", str: "#2f7d4f", num: "#7a3fb0", com: "#8b96a6", fn: "#2c5aa0", op: "#5a6675", type: "#0f766e" };
  return HighlightStyle.define([
    { tag: t.keyword, color: c.kw, fontWeight: "600" },
    { tag: [t.string, t.special(t.string)], color: c.str },
    { tag: [t.number, t.bool, t.null], color: c.num },
    { tag: [t.lineComment, t.blockComment, t.comment], color: c.com, fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.fn },
    { tag: [t.operator, t.punctuation, t.separator], color: c.op },
    { tag: [t.typeName, t.className, t.namespace], color: c.type },
  ]);
}

// Base editor chrome (fonts, sizing, focus ring) as a CodeMirror theme so it sits
// inside the shadow-free light-DOM and matches the page. Height/scroll is handled
// here; the outer .editor-wrap frames it.
function baseTheme(dark) {
  return EditorView.theme(
    {
      "&": {
        fontSize: "13px",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius)",
        backgroundColor: "var(--surface)",
        color: "var(--text)",
      },
      "&.cm-focused": { outline: "2px solid var(--accent)", outlineOffset: "1px" },
      ".cm-content": {
        fontFamily: "var(--mono)",
        padding: "12px 0",
        caretColor: "var(--text)",
      },
      ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
      ".cm-gutters": { display: "none" },
      ".cm-activeLine": { backgroundColor: dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)" },
      ".cm-cursor": { borderLeftColor: "var(--text)" },
      "&.cm-editor .cm-selectionBackground, & .cm-selectionBackground": {
        backgroundColor: dark ? "rgba(240,179,84,0.22)" : "rgba(181,115,15,0.18)",
      },
      ".cm-matchingBracket": {
        backgroundColor: dark ? "rgba(240,179,84,0.25)" : "rgba(181,115,15,0.20)",
        outline: "1px solid var(--accent)",
      },
    },
    { dark },
  );
}

/**
 * Mount a CodeMirror editor into `parent` and return a textarea-like adapter.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.parent   element to mount into
 * @param {string} [opts.doc]         initial text
 * @param {boolean} [opts.dark]       start in dark theme
 * @param {() => void} [opts.onRun]        Cmd/Ctrl+Enter (run statement at cursor)
 * @param {() => void} [opts.onRunAll]     Shift+Cmd/Ctrl+Enter (run whole buffer)
 * @param {(dir: -1|1) => boolean} [opts.onHistory]  ↑(-1)/↓(1) at edge line; return
 *        true if the adapter handled it (recalled history), false to let the arrow
 *        move the cursor normally.
 * @returns {Editor}
 */
export function mountEditor(opts) {
  const themeC = new Compartment();
  const hlC = new Compartment();

  // App keybindings, highest precedence so they beat CodeMirror defaults.
  const appKeys = keymap.of([
    {
      key: "Mod-Enter",
      run: () => { opts.onRun?.(); return true; },
      shift: () => { opts.onRunAll?.(); return true; },
    },
    {
      key: "Tab",
      run: (view) => {
        view.dispatch(view.state.replaceSelection("  "));
        return true;
      },
    },
    {
      key: "ArrowUp",
      run: (view) => (atFirstLine(view) ? !!opts.onHistory?.(-1) : false),
    },
    {
      key: "ArrowDown",
      run: (view) => (atLastLine(view) ? !!opts.onHistory?.(1) : false),
    },
  ]);

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc ?? "",
      extensions: [
        appKeys,
        history(),
        keymap.of([...historyKeymap, ...defaultKeymap]),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        sql({ dialect: PostgreSQL }),
        hlC.of(syntaxHighlighting(highlightStyleFor(!!opts.dark))),
        themeC.of(baseTheme(!!opts.dark)),
        placeholder(opts.placeholder ?? ""),
        EditorView.lineWrapping,
      ],
    }),
  });

  return new Editor(view, themeC, hlC);
}

function atFirstLine(view) {
  const head = view.state.selection.main.head;
  return view.state.doc.lineAt(head).number === 1;
}
function atLastLine(view) {
  const head = view.state.selection.main.head;
  return view.state.doc.lineAt(head).number === view.state.doc.lines;
}

/** Textarea-like facade over a CodeMirror EditorView. */
class Editor {
  constructor(view, themeC, hlC) {
    this._view = view;
    this._themeC = themeC;
    this._hlC = hlC;
  }

  /** Full text. */
  get value() {
    return this._view.state.doc.toString();
  }
  set value(text) {
    this._view.dispatch({
      changes: { from: 0, to: this._view.state.doc.length, insert: text },
    });
  }

  /** Selection anchor as a character offset (textarea-compatible). */
  get selectionStart() {
    return this._view.state.selection.main.from;
  }
  set selectionStart(pos) {
    this._setSelection(pos, this._view.state.selection.main.to);
  }
  get selectionEnd() {
    return this._view.state.selection.main.to;
  }
  set selectionEnd(pos) {
    this._setSelection(this._view.state.selection.main.from, pos);
  }

  _setSelection(from, to) {
    const max = this._view.state.doc.length;
    const a = Math.max(0, Math.min(from ?? 0, max));
    const b = Math.max(0, Math.min(to ?? a, max));
    this._view.dispatch({ selection: { anchor: a, head: b } });
  }

  focus() {
    this._view.focus();
  }

  /** Swap light/dark syntax + base theme in place. */
  setDark(dark) {
    this._view.dispatch({
      effects: [
        this._themeC.reconfigure(baseTheme(dark)),
        this._hlC.reconfigure(syntaxHighlighting(highlightStyleFor(dark))),
      ],
    });
  }
}
