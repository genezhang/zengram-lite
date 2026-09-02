#!/usr/bin/env bash
# Fetch the published zengram-lite wasm artifact into demo/pkg-web/.
#
# The compiled bundle (zengram_wasm_bg.wasm + wasm-bindgen JS glue) is NOT
# committed to this repo. It is attached to a GitHub Release (primary channel);
# npm publication as `zengram-lite` is pending. This script pulls the web-target
# build so the demo can run locally without a Rust/wasm toolchain.
#
# Source resolution (first match wins):
#   1. ZENGRAM_LITE_PKG=/path/to/pkg-web   — copy from a local build
#   2. ZENGRAM_LITE_NPM=1                   — pull from npm (once published)
#   3. otherwise                            — download from the GitHub Release
#
# Usage:
#   ./scripts/fetch-artifact.sh               # latest GitHub Release
#   ./scripts/fetch-artifact.sh v0.1.0        # a specific release tag
#   ZENGRAM_LITE_NPM=1 ./scripts/fetch-artifact.sh v0.1.0   # from npm instead
#   ZENGRAM_LITE_PKG=/path/to/pkg-web ./scripts/fetch-artifact.sh   # local build
#
# Requires: `gh` (default GitHub-Release path) OR npm (ZENGRAM_LITE_NPM=1) OR a
# local pkg-web dir via ZENGRAM_LITE_PKG.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
dest="$root/demo/pkg-web"
mkdir -p "$dest"

# The web-target files the demo imports (demo/index.html loads
# ./pkg-web/zengram_wasm.js). Keep this list in sync with a wasm-bindgen
# --target web output set.
files=(zengram_wasm.js zengram_wasm_bg.wasm zengram_wasm.d.ts zengram_wasm_bg.wasm.d.ts)

# The third-party license notices legally travel WITH the .wasm. Copied
# best-effort (warn, don't fail) so an older artifact that predates the notices
# file doesn't break the fetch — but a current artifact always carries it.
notices_file="THIRD-PARTY-NOTICES.txt"

if [[ -n "${ZENGRAM_LITE_PKG:-}" ]]; then
  echo "==> copying artifact from local build: $ZENGRAM_LITE_PKG"
  for f in "${files[@]}"; do
    cp "$ZENGRAM_LITE_PKG/$f" "$dest/$f"
  done
  if [[ -f "$ZENGRAM_LITE_PKG/$notices_file" ]]; then
    cp "$ZENGRAM_LITE_PKG/$notices_file" "$dest/$notices_file"
  else
    echo "    (warning: $notices_file not found in build — should ship with the .wasm)" >&2
  fi
elif [[ -n "${ZENGRAM_LITE_NPM:-}" ]]; then
  ver="${1:-latest}"
  # npm dist-tags use bare versions; strip a leading v from a git-style tag.
  ver="${ver#v}"
  echo "==> fetching zengram-lite@$ver from npm"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  # Supply-chain integrity: this pulls a prebuilt engine binary, so verify what
  # npm delivered before we trust it. `npm pack --json` reports the tarball's
  # sha512 integrity as an SRI string. If ZENGRAM_LITE_SHA512 is set, pin it to
  # that FULL SRI value — the `sha512-<base64>` form printed below, NOT a hex
  # digest — and we fail closed on mismatch; otherwise we print the integrity so
  # a human / CI can record and compare it.
  pack_json="$(cd "$tmp" && npm pack "zengram-lite@$ver" --json 2>/dev/null)"
  tgz="$(printf '%s' "$pack_json" | sed -n 's/.*"filename": *"\([^"]*\)".*/\1/p' | head -1)"
  integrity="$(printf '%s' "$pack_json" | sed -n 's/.*"integrity": *"\([^"]*\)".*/\1/p' | head -1)"
  if [[ -z "$tgz" || ! -f "$tmp/$tgz" ]]; then
    # Fallback for older npm without a reliable --json filename field.
    tgz="$(cd "$tmp" && ls -1 zengram-lite-*.tgz 2>/dev/null | head -1)"
  fi
  [[ -n "$tgz" && -f "$tmp/$tgz" ]] || { echo "!! npm pack produced no tarball" >&2; exit 1; }
  echo "    integrity: ${integrity:-<unknown>}"
  if [[ -n "${ZENGRAM_LITE_SHA512:-}" ]]; then
    if [[ "$integrity" != "$ZENGRAM_LITE_SHA512" ]]; then
      echo "!! integrity mismatch — refusing to install." >&2
      echo "   expected: $ZENGRAM_LITE_SHA512" >&2
      echo "   got:      ${integrity:-<none>}" >&2
      exit 1
    fi
    echo "    integrity pin OK"
  else
    echo "    (set ZENGRAM_LITE_SHA512 to the release's published integrity to fail closed)"
  fi

  # Extract defensively: don't let a hostile tarball write outside $tmp via
  # absolute paths or ../ traversal. The real guard is `--no-absolute-names`
  # (strips leading '/') plus GNU tar's default refusal of `..` members. The
  # post-extraction realpath sweep below is belt-and-suspenders.
  tar --no-absolute-names --no-same-owner -xzf "$tmp/$tgz" -C "$tmp"
  while IFS= read -r -d '' p; do
    case "$(realpath -- "$p")" in
      "$tmp"/*) : ;;
      *) echo "!! tarball member escaped extraction dir: $p" >&2; exit 1 ;;
    esac
  done < <(find "$tmp" -mindepth 1 -path "$tmp/package" -prune -o -print0 2>/dev/null)

  # npm's bundler-target package ships zengram_wasm_bg.js; the web target the
  # demo wants ships zengram_wasm.js as a self-initializing module. Prefer a
  # pkg-web/ dir inside the tarball if present, else fall back to package/.
  srcdir="$tmp/package"
  [[ -d "$tmp/package/pkg-web" ]] && srcdir="$tmp/package/pkg-web"
  for f in "${files[@]}"; do
    if [[ -f "$srcdir/$f" ]]; then
      cp "$srcdir/$f" "$dest/$f"
    else
      echo "!! $f not found in published package — the npm package may ship the" >&2
      echo "   bundler target only. Build the web target from source instead" >&2
      echo "   (see scripts/build-from-source.sh) or attach pkg-web to the release." >&2
      exit 1
    fi
  done
  # The notices file ships at the tarball's package root (npm `files` list); it
  # may not be inside a pkg-web/ subdir. Copy best-effort from either location.
  if [[ -f "$srcdir/$notices_file" ]]; then
    cp "$srcdir/$notices_file" "$dest/$notices_file"
  elif [[ -f "$tmp/package/$notices_file" ]]; then
    cp "$tmp/package/$notices_file" "$dest/$notices_file"
  else
    echo "    (warning: $notices_file not found in package — should ship with the .wasm)" >&2
  fi
else
  # Default channel: download the web-target assets from the GitHub Release.
  # npm publication is pending; the Release is the primary distribution point.
  command -v gh >/dev/null || {
    echo "!! 'gh' (GitHub CLI) is required to fetch from the Release." >&2
    echo "   Install it (https://cli.github.com), or use a local build:" >&2
    echo "     ZENGRAM_LITE_PKG=/path/to/pkg-web $0" >&2
    echo "   or, once npm is published:  ZENGRAM_LITE_NPM=1 $0 vX.Y.Z" >&2
    exit 1
  }
  repo="${ZENGRAM_LITE_REPO:-genezhang/zengram-lite}"
  tag="${1:-}"
  if [[ -z "$tag" ]]; then
    tag="$(gh release view --repo "$repo" --json tagName -q .tagName 2>/dev/null)"
    [[ -n "$tag" ]] || { echo "!! no published release found on $repo" >&2; exit 1; }
    echo "==> latest GitHub Release on $repo: $tag"
  fi
  echo "==> downloading zengram-lite $tag assets from $repo (GitHub Release)"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  # Pull exactly the web-target files (+ notices) attached to the release.
  patterns=()
  for f in "${files[@]}" "$notices_file"; do patterns+=(--pattern "$f"); done
  gh release download "$tag" --repo "$repo" --dir "$tmp" "${patterns[@]}" \
    || { echo "!! failed to download release assets for $tag from $repo" >&2; exit 1; }

  # Supply-chain integrity: this is a prebuilt engine binary. If
  # ZENGRAM_LITE_WASM_SHA256 is set, pin the .wasm to that hex digest and fail
  # closed; otherwise print it so a human / CI can record and compare it.
  wasm_sha="$(sha256sum "$tmp/zengram_wasm_bg.wasm" | awk '{print $1}')"
  echo "    zengram_wasm_bg.wasm sha256: $wasm_sha"
  if [[ -n "${ZENGRAM_LITE_WASM_SHA256:-}" ]]; then
    if [[ "$wasm_sha" != "$ZENGRAM_LITE_WASM_SHA256" ]]; then
      echo "!! integrity mismatch — refusing to install." >&2
      echo "   expected: $ZENGRAM_LITE_WASM_SHA256" >&2
      echo "   got:      $wasm_sha" >&2
      exit 1
    fi
    echo "    integrity pin OK"
  else
    echo "    (set ZENGRAM_LITE_WASM_SHA256 to the release's published digest to fail closed)"
  fi

  for f in "${files[@]}"; do
    [[ -f "$tmp/$f" ]] || { echo "!! release asset missing: $f" >&2; exit 1; }
    cp "$tmp/$f" "$dest/$f"
  done
  if [[ -f "$tmp/$notices_file" ]]; then
    cp "$tmp/$notices_file" "$dest/$notices_file"
  else
    echo "    (warning: $notices_file not attached to the release — should ship with the .wasm)" >&2
  fi
fi

# Node module-type marker: the web target is an ES module. The repo root's
# package.json is type:module (E2E tooling), so this is belt-and-suspenders —
# but it also makes the bundle loadable from Node (e.g.
# playground_validate.mjs) under any root config, and it ships with the
# published artifact for the same reason.
printf '{\n  "type": "module"\n}\n' > "$dest/package.json"

echo "==> done. Artifact in $dest:"
ls -la "$dest"
echo
echo "Run the demo:"
echo "  python3 -m http.server -d demo 8080   # then open http://localhost:8080"
