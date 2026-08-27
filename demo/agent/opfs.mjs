// OPFS helpers for the browser agent — the agent's private file store plus the
// memory-snapshot transport. Copied from demo/playground/opfs.mjs (kept separate
// so the two demos stay self-contained) and extended with directory listing and
// text convenience wrappers the file tools need.
//
// Async, main-thread OPFS (getFileHandle + createWritable/getFile) — no worker,
// no SharedArrayBuffer, no COOP/COEP headers. Browser-only: Node/bun have no
// navigator.storage. See the playground copy for the full rationale.

async function opfsRoot() {
  if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.getDirectory) {
    throw new Error(
      "OPFS is not available in this environment (need a browser with " +
        "navigator.storage.getDirectory; Node/bun have no OPFS)",
    );
  }
  return navigator.storage.getDirectory();
}

/** Write a blob to OPFS under `name`, overwriting any existing file. */
export async function saveToOpfs(name, bytes) {
  const root = await opfsRoot();
  const fileHandle = await root.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(bytes); // createWritable truncates on open; one write replaces the file
  } finally {
    await writable.close();
  }
}

/** Read a blob back from OPFS, or null if there is no such file. */
export async function loadFromOpfs(name) {
  const root = await opfsRoot();
  let fileHandle;
  try {
    fileHandle = await root.getFileHandle(name, { create: false });
  } catch (e) {
    if (e && e.name === "NotFoundError") return null;
    throw e;
  }
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** Delete a file from OPFS (idempotent — missing file is not an error). */
export async function deleteFromOpfs(name) {
  const root = await opfsRoot();
  try {
    await root.removeEntry(name);
  } catch (e) {
    if (e && e.name === "NotFoundError") return;
    throw e;
  }
}

/** List the names of all files (not subdirectories) in the OPFS root. */
export async function listFiles() {
  const root = await opfsRoot();
  const names = [];
  // getDirectoryHandle exposes async iteration over [name, handle] entries.
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "file") names.push(name);
  }
  return names;
}

/** Write UTF-8 text to an OPFS file. */
export async function writeFileText(name, text) {
  await saveToOpfs(name, new TextEncoder().encode(String(text)));
}

/** Read an OPFS file as UTF-8 text, or null if it does not exist. */
export async function readFileText(name) {
  const bytes = await loadFromOpfs(name);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
