# Releasing zengram-lite

How a maintainer cuts a public release. zengram-lite is a **distribution repo**:
the compiled `.wasm` is built in the monorepo (`crates/zengram-wasm`) and
attached to a **GitHub Release** here (npm is a later channel). This checklist
keeps the tag, the release, the fetch script, and the docs in agreement.

> Mirrors the zeta-lite v0.1.0 flow: **GitHub Release first (git tag + attached
> web-target bundle), npm publication as a follow-up.**

## 0. Preconditions

- [ ] The monorepo build is green and the web-target bundle exists
      (`ZETA_REPO=/path/to/zeta ./scripts/build-from-source.sh`, or a CI build
      artifact). Confirm it carries `THIRD-PARTY-NOTICES.txt`.
- [ ] Working tree clean, on `main`, up to date with `origin/main`.
- [ ] Version decided (e.g. `0.1.0`). Below, `X.Y.Z` = the version,
      `vX.Y.Z` = the git tag.

## 1. Verify the artifact end to end

Fetch/point the demo at the exact bundle you intend to ship, then run every
harness against it — these need the wasm and do **not** run in the repo's CI.

```bash
# Point at the build you're about to release:
ZENGRAM_LITE_PKG=/path/to/pkg-web ./scripts/fetch-artifact.sh

node demo/smoke.mjs          # memory core + re-exported engine — 19 checks
node demo/smoke_agent.mjs    # full agent loop — 27 checks
node demo/smoke_model.mjs    # real all-MiniLM recall (downloads model once)
npm run e2e                  # headless-Chromium DOM
npm run e2e:agent

# Size claim in README/paper (~2.9 MB gz):
gzip -c demo/pkg-web/zengram_wasm_bg.wasm | wc -c
```

- [ ] All harnesses pass against the **release** bundle.
- [ ] Measured gzip size matches the figure quoted in `README.md` and the paper.

## 2. Sync versions and docs

- [ ] `CHANGELOG.md`: move items under a dated `## [X.Y.Z]` heading; update the
      link reference at the bottom.
- [ ] `README.md`: confirm the "Status" note and any `vX.Y.Z` references are
      correct for this version.
- [ ] Source-availability wording is consistent across `README.md`, `LICENSE`,
      `CLAUDE.md`, and `docs/paper/` (framework: Apache-2.0, publication pending;
      engine: closed; `.wasm`: prebuilt binary).
- [ ] `package.json` `version` set to `X.Y.Z` if/when publishing to npm
      (currently `private`; see step 5).

## 3. Tag and push

```bash
git tag -a vX.Y.Z -m "zengram-lite vX.Y.Z"
git push origin vX.Y.Z
```

- [ ] Tag is on the intended `main` commit.

### Pin the build provenance (three source repos)

The shipped `.wasm` is **not** built from this repo — it is compiled from
`crates/zengram-wasm` in the Zeta monorepo, which links three private source
trees via path deps (`crates/zengram-wasm/Cargo.toml`). The artifact is
reproducible only from that **triple**, so tag the exact build commit in each
with a product-scoped tag and record the SHAs.

| Repo | Supplies | Tag |
|---|---|---|
| `genezhang/zengram` | `zengram-mem`, `zengram-common` (the memory tier) | `zengram-lite-vX.Y.Z` |
| `genezhang/zeta` | `zeta-wasm`, `zeta-embedded` (the engine) | `zengram-lite-vX.Y.Z` |
| `genezhang/zeta-embedded` | `zeta-embedded-api` (shared types) | `zengram-lite-vX.Y.Z` |

```bash
# From each checkout, tag the commit the release artifact was built from
# (annotated tags point at the committed HEAD; uncommitted build outputs such
#  as regenerated static libs are not captured — a clean tree is not required,
#  but confirm nothing the build consumes is uncommitted):
for repo in /path/to/zengram /path/to/zeta /path/to/zeta-embedded; do
  git -C "$repo" tag -a zengram-lite-vX.Y.Z -m "zengram-lite vX.Y.Z source" <build-commit>
  git -C "$repo" push origin zengram-lite-vX.Y.Z
done

# Capture the triple for the release notes:
for repo in /path/to/zengram /path/to/zeta /path/to/zeta-embedded; do
  printf '%s %s\n' "$(basename "$repo")" "$(git -C "$repo" rev-parse HEAD)"
done
```

- [ ] `zengram-lite-vX.Y.Z` pushed on all three source repos (on `genezhang/zeta`
      it sits alongside that release's `zeta-wasm` tag on the same commit — a
      product-scoped pointer, not a rebuild).
- [ ] The three source SHAs recorded for the release notes (§4).

## 4. Cut the GitHub Release (primary channel)

Attach the **web-target** files so `scripts/fetch-artifact.sh` and the demos
work without a toolchain:

- `zengram_wasm_bg.wasm`
- `zengram_wasm.js`
- `zengram_wasm.d.ts`
- `zengram_wasm_bg.wasm.d.ts`
- `THIRD-PARTY-NOTICES.txt`

```bash
gh release create vX.Y.Z \
  --title "zengram-lite vX.Y.Z" \
  --notes-file <(sed -n '/## \[X.Y.Z\]/,/## \[/p' CHANGELOG.md | sed '$d') \
  /path/to/pkg-web/zengram_wasm_bg.wasm \
  /path/to/pkg-web/zengram_wasm.js \
  /path/to/pkg-web/zengram_wasm.d.ts \
  /path/to/pkg-web/zengram_wasm_bg.wasm.d.ts \
  /path/to/pkg-web/THIRD-PARTY-NOTICES.txt
```

- [ ] Release published with all five assets attached.
- [ ] Release notes include a **Build provenance** block with the three source
      SHAs from §3 (which monorepo commits this artifact was compiled from), e.g.:

      ```
      Build provenance (source the .wasm was compiled from):
        genezhang/zengram        <sha>   (zengram-mem, zengram-common)
        genezhang/zeta           <sha>   (zeta-wasm, zeta-embedded)
        genezhang/zeta-embedded  <sha>   (zeta-embedded-api)
      all tagged zengram-lite-vX.Y.Z
      ```
- [ ] Record the artifact's integrity for the pin step below
      (`fetch-artifact.sh` prints the SRI when it pulls from npm; for a release
      asset, note the `.wasm` sha256 in the release notes).

## 5. npm publication (follow-up channel — optional at v0.1.0)

Not required for the initial release (zeta-lite v0.1.0 shipped git-only). When
you do publish:

- [ ] `package.json`: remove `"private": true`, set `version`, add the `files`
      allowlist for the bundle + notices, set `main`/`types`/`exports`.
- [ ] `npm publish --access public` (dry-run first: `npm publish --dry-run`).
- [ ] `npm view zengram-lite version` matches `X.Y.Z`.
- [ ] Re-run `./scripts/fetch-artifact.sh X.Y.Z` (npm path) and record the
      published `integrity` (`sha512-…`) so downstreams can pin
      `ZENGRAM_LITE_SHA512`.

## 6. Post-release

- [ ] `./scripts/fetch-artifact.sh vX.Y.Z` (release path) produces a runnable
      `demo/pkg-web/` on a clean checkout.
- [ ] Skim the three demos against the released bundle.
- [ ] Open the next `## [Unreleased]` section in `CHANGELOG.md` if continuing.
