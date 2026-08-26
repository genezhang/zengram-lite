# Security Policy

Zengram Lite is a WebAssembly build of the Zengram agentic-memory framework over
the Zeta database engine that runs entirely inside the browser (or a JS runtime)
— in the page's own sandbox, with no server and no network. Its security posture
is shaped around being a well-behaved client-side guest.

> Zengram Lite is free to use but not open source; the framework and engine
> source are not in this repo. Please report vulnerabilities privately (see
> below) rather than in public issues, so a fix can ship before details are
> public.

## Reporting a Vulnerability

Report security issues **privately** — do not open a public issue.

- Preferred: GitHub's **"Report a vulnerability"** button under this
  repository's **Security** tab (private security advisories).
- Or email genegzhang@gmail.com.

Please include the version/tag, browser or runtime, a minimal reproduction if
possible, and the impact you observed. We aim to acknowledge within a few
business days.

## Security Model

### Runs in the host sandbox

The bundle executes as WebAssembly inside the embedding page or runtime. It has
no ambient filesystem, network, or process access beyond what the host grants
through the JS API. Persistence is an explicit snapshot blob the host chooses to
store (e.g. in OPFS); it never writes anywhere on its own.

### Bring-your-own embedder

The embedding callback you register via `setEmbedFn` (or the vectors you pass to
`rememberWithVector`/`recallWithVector`) run under your control. If your embedder
calls a remote API, that request leaves the tab under your code's terms — the
bundle itself makes no network calls.

### Parameterized queries

When you use the SQL surface (`ZetaDb`), always pass query parameters as
positional binds (`$1`, `$2`, …) with a values array — never assemble SQL by
concatenating untrusted strings. Bound parameters are applied out-of-band, so
untrusted values cannot change a query's structure.

### Data isolation

A handle's data lives only in the wasm linear memory of the page that created
it. A snapshot blob is plaintext — if you persist it (OPFS, IndexedDB, download),
protect it the way you would any other client-side data; it carries the full
contents of the database, including remembered facts and their embeddings.

### Shared-engine mode

`ZengramMemory.overEngine(db, …)` shares one catalog between your app's SQL
tables and memory's tables. Treat this as a single trust domain: anything that
can run SQL on the shared `ZetaDb` can read memory's tables, and vice versa.
Use the isolated `ZengramMemory.open()` mode if you need them separated.

## Scope

This policy covers the demo glue and the behavior of the bundle as exposed
through the JS API in this repository. If unsure whether something is in scope,
report it privately and we will help triage.
