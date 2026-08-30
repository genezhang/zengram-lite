#!/usr/bin/env bash
# Build the zengram-lite bundle FROM SOURCE into demo/.
#
# The browser bundle (zengram_wasm_bg.wasm + wasm-bindgen JS glue) links the
# Zeta engine + the Zengram memory tier, whose Rust source lives in the closed
# monorepo (github.com/genezhang/zeta) — NOT in this repository. This script is
# for maintainers / NDA holders with engine-source access; ordinary users get the
# published bundle via `scripts/fetch-artifact.sh` (see README).
#
# The glue crate `zengram-wasm` lives in the monorepo at crates/zengram-wasm
# (it must, because it links the full engine); this script drives its release
# build and drops the web + nodejs bundles into demo/.
#
# Usage:
#   ZETA_REPO=/path/to/zeta ./scripts/build-from-source.sh
#
# Requires: the monorepo checkout, rustup wasm32-unknown-unknown target, and a
# wasm-bindgen CLI whose version matches the monorepo's Cargo.lock (0.2.x).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$(cd "$here/.." && pwd)/demo"

repo="${ZETA_REPO:-}"
if [[ -z "$repo" || ! -d "$repo/crates/zengram-wasm" ]]; then
  echo "!! Set ZETA_REPO to a checkout of the closed Zeta monorepo." >&2
  echo "   e.g. ZETA_REPO=/home/you/zeta $0" >&2
  exit 1
fi

crate="$repo/crates/zengram-wasm"
echo "==> building zengram-wasm (release, wasm surface) from $crate"
( cd "$crate" && \
  RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
    cargo build --release --no-default-features --features wasm \
    --target wasm32-unknown-unknown )

# zengram-wasm declares its own `[workspace]` (isolated, like zeta-embedded), so
# cargo writes to the CRATE-local target/, not the monorepo root's — UNLESS a
# machine-global CARGO_TARGET_DIR (or ~/.cargo/config target-dir) redirects it.
# Honor an explicit CARGO_TARGET_DIR first, then the crate-local dir, then the
# repo root — covering every layout instead of assuming one.
rel="wasm32-unknown-unknown/release/zengram_wasm.wasm"
wasm=""
for cand in "${CARGO_TARGET_DIR:+$CARGO_TARGET_DIR/$rel}" \
            "$crate/target/$rel" \
            "$repo/target/$rel"; do
  [[ -n "$cand" && -f "$cand" ]] && { wasm="$cand"; break; }
done
if [[ -z "$wasm" ]]; then
  echo "!! built wasm not found. Looked in:" >&2
  [[ -n "${CARGO_TARGET_DIR:-}" ]] && echo "   \$CARGO_TARGET_DIR/$rel" >&2
  echo "   $crate/target/$rel" >&2
  echo "   $repo/target/$rel" >&2
  echo "   (zengram-wasm is an isolated workspace — its build lands in the" >&2
  echo "    crate-local target/ unless CARGO_TARGET_DIR redirects it.)" >&2
  exit 1
fi
echo "==> found wasm: $wasm"

echo "==> wasm-bindgen --target web    -> $dest/pkg-web/ (browser demo)"
rm -rf "$dest/pkg-web"; wasm-bindgen --target web    --out-dir "$dest/pkg-web" "$wasm"

echo "==> wasm-bindgen --target nodejs -> $dest/pkg/ (smoke tests)"
rm -rf "$dest/pkg"; wasm-bindgen --target nodejs --out-dir "$dest/pkg" "$wasm"

# Node module-type markers for the generated bundles: the nodejs target is
# CommonJS, the web target is an ES module. The repo root's package.json is
# type:module, so without these the CJS nodejs bundle (demo/pkg/) would be
# misread as ESM by Node and the smoke tests' named imports would fail.
printf '{\n  "type": "commonjs"\n}\n' > "$dest/pkg/package.json"
printf '{\n  "type": "module"\n}\n' > "$dest/pkg-web/package.json"

echo "==> done. Serve demo over HTTP (python3 -m http.server -d demo 8080), or:"
echo "    node demo/smoke.mjs"
