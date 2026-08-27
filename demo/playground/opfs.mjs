// OPFS persistence helpers for zengram-lite (shared zeta-wasm engine) (Phase 2.2).
//
// The WASM engine is in-memory; durability = snapshot the whole database to a
// byte blob (`db.exportSnapshot()`) and write it to the Origin Private File
// System, then read it back and rehydrate (`ZetaDb.openFromSnapshot(bytes)`) on
// the next load.
//
// Why this design (and why no worker / SharedArrayBuffer / COOP-COEP):
// synchronous OPFS access (`createSyncAccessHandle`) is only available inside a
// Web Worker and is what a *sync-every-write* storage engine would need. A
// snapshot-on-demand model doesn't: it writes one whole blob at a checkpoint,
// so it can use the plain async OPFS API (`getFileHandle` +
// `createWritable` / `getFile`) directly on the main thread. That avoids the
// cross-origin-isolation (COOP/COEP) headers `SharedArrayBuffer` requires — this
// module runs in any browser context with OPFS, no special headers.
//
// These helpers are browser-only: Node/bun have no `navigator.storage`. The
// snapshot *format* and the round-trip are covered by native Rust tests and the
// bun harness (which exercises export/openFromSnapshot on in-memory bytes); this
// file is the thin OPFS transport, verified manually in a browser (see
// `harness/opfs_demo.html`).

/**
 * Return the OPFS root directory handle, or throw a clear error if OPFS is not
 * available (e.g. running under Node/bun, or a browser without OPFS).
 */
async function opfsRoot() {
  if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.getDirectory) {
    throw new Error(
      "OPFS is not available in this environment (need a browser with " +
        "navigator.storage.getDirectory; Node/bun have no OPFS)",
    );
  }
  return navigator.storage.getDirectory();
}

/**
 * Write a snapshot blob to OPFS under `name`, overwriting any existing file.
 *
 * @param {string} name  file name within OPFS, e.g. "mydb.zeta"
 * @param {Uint8Array} bytes  the blob from `db.exportSnapshot()`
 */
export async function saveToOpfs(name, bytes) {
  const root = await opfsRoot();
  const fileHandle = await root.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    // createWritable truncates to empty on open; one write replaces the file.
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

/**
 * Read a snapshot blob back from OPFS.
 *
 * @param {string} name  file name within OPFS
 * @returns {Promise<Uint8Array | null>}  the bytes, or null if no such file
 */
export async function loadFromOpfs(name) {
  const root = await opfsRoot();
  let fileHandle;
  try {
    fileHandle = await root.getFileHandle(name, { create: false });
  } catch (e) {
    // NotFoundError → no snapshot yet (first run). Anything else is real.
    if (e && e.name === "NotFoundError") return null;
    throw e;
  }
  const file = await fileHandle.getFile();
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Delete a snapshot file from OPFS (idempotent — missing file is not an error).
 *
 * @param {string} name  file name within OPFS
 */
export async function deleteFromOpfs(name) {
  const root = await opfsRoot();
  try {
    await root.removeEntry(name);
  } catch (e) {
    if (e && e.name === "NotFoundError") return;
    throw e;
  }
}

/**
 * Open a database, restoring from an OPFS snapshot if one exists, else fresh.
 * Pair with `saveToOpfs(name, db.exportSnapshot())` at your checkpoints.
 *
 * @param {typeof import("../pkg-web/zengram_wasm.js").ZetaDb} ZetaDb  the wasm class
 * @param {string} name  OPFS file name
 * @returns {Promise<InstanceType<typeof ZetaDb>>}
 */
export async function openWithOpfs(ZetaDb, name) {
  const bytes = await loadFromOpfs(name);
  return bytes ? ZetaDb.openFromSnapshot(bytes) : ZetaDb.open();
}
