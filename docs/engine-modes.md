# Engine modes

Agent memory stores into a Zeta database engine. zengram-lite lets the app
developer choose whether memory gets its **own** engine or **shares** one with
the app's SQL. You provide the choice; both are first-class.

## Own engine (isolated)

```js
import { ZengramMemory } from "zengram-lite";

const mem = ZengramMemory.open(384);   // fresh, isolated in-memory database
```

Memory opens its own Zeta engine with a private catalog. Nothing else touches it.

**Use when:** the page only needs memory, or you want memory's storage isolated
from any SQL your app runs (separate trust domains, no chance of table-name
collisions).

## Shared engine (one database)

```js
import { ZetaDb, ZengramMemory } from "zengram-lite";

const db = ZetaDb.open();                         // the app's SQL database
db.execDdl("CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)");

const mem = ZengramMemory.overEngine(db, 384);    // memory over the SAME engine
```

`overEngine` builds memory over the existing `ZetaDb`'s engine — **one wasm heap,
one database**. The app's SQL tables and memory's tables live in the same
catalog. A single `.wasm` instance backs both surfaces.

**Use when:** the page already runs SQL via `ZetaDb` and you want a single
database with no double-load, or you want to query memory's tables directly with
SQL alongside your own.

### Reserved table names (the shared-mode caveat)

In shared mode, memory's tables share the catalog namespace with yours. Memory
reserves the following names — **avoid creating app tables that collide with
them:**

```
event_log      embedding      session        knowledge      turn
tool_call      provenance     reminder       permission     episodic
```

plus the migration bookkeeping table `_zengram_migrations`.

Memory's schema migrations are **idempotent** (tracked in `_zengram_migrations`),
so opening memory over an already-initialized engine is safe and cheap — the
migrations run once and are skipped thereafter. Opening memory twice over the
same engine is fine.

If you cannot guarantee your app avoids these names, use the isolated
`ZengramMemory.open()` mode instead.

## Persistence works the same in both modes

```js
const blob = mem.exportSnapshot();                     // Uint8Array
const mem2 = ZengramMemory.openFromSnapshot(blob, 384);
```

The snapshot captures the whole database — in shared mode that includes both the
app's SQL tables and memory's tables, since they are one database.
