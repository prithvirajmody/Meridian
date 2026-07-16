# ADR-0038 — SQLite embedded store behind an injected `StorageBackend`; op log first, element tables as checkpoint

- **Status:** Proposed
- **Date:** 2026-07-16
- **Phase:** 11 (roadmap)
- **Constitution:** ARCHITECTURE.md §15.1–15.3, §4.7, §12.2, §16.2, §17.4, §19.5, §20; ADR-A10, ADR-A2
- **Roadmap:** ROADMAP.md Phase 11 §3–§8 (ADR-0038); SUBPHASES.md 11B/11D

## Context

Phases 0–10 persist nothing: projects are `.meridian.json` documents (ADR-0004)
re-ingested per session, version stamps are per-session (ADR-0007, which
explicitly assigns durable stamps to P11), and every committed transaction
already hands back a completed, invertible `GraphDelta` (ADR-0005/0008) with no
durable sink. The constitution fixes the stance (ADR-A10: one-file SQLite
project, op log as primary artifact, storage behind an injected backend;
§15.1–15.3); this record fixes the concrete backend contract, the schema, the
durability protocol, the two runtime bindings, and the failure policy. P12's
sync log rides on what is decided here.

## Decision

**1. SQLite is the embedded store; one file per project.** Canonical extension
`.meridian` (§15.1; CLI accepts any path). Bindings: **better-sqlite3** in Node
(synchronous, WAL); **`@sqlite.org/sqlite-wasm`** in the browser, running in a
dedicated worker over the **OPFS SyncAccessHandle pool VFS** (`opfs-sahpool`:
sync access handles, worker-only, no COOP/COEP requirement), fronted by an
async facade to the main thread — reusing the ADR-0017 worker-host pattern.
*Amended 11D:* the draft named wa-sqlite here (following §15.1's parenthetical);
at build time wa-sqlite 1.0's public API proved Promise-shaped even on its
synchronous build, which cannot implement the synchronous `SqlDriver` seam
below — and that seam is what lets Node and browser run the *identical*
`SqliteBackendCore` (open/append/checkpoint/replay written once, parity by
construction). The official WASM distribution's `oo1` API is fully synchronous
inside a worker, so it wins on the criterion that matters; the swap surface
remains one browser module either way, as this record always required.
Flagged for fold-back into §15.1's wording. Both bindings live **only** in
`@meridian/store-sqlite` (depcruise-gated; §20 already reserves the package:
deps `graph-store`, `graph-core`). The package ships three entrypoints:
`.` (isomorphic core: schema DDL, migrations, codec glue, replay, parity
scenarios), `./node`, `./browser`.

**2. `StorageBackend` is a `graph-store` seam, exactly the roadmap shape:**

```ts
interface StorageBackend {
  loadGraph(id: GraphId): Promise<SemanticGraph | null>;
  persist(change: ChangeSet): Promise<void>;   // post-commit, async
  appendOps(delta: GraphDelta): Promise<void>; // durable op log (P12 substrate)
  evictHint(ids: GraphId[]): void;             // advisory, fire-and-forget
}
```

`CreateStoreOptions` gains `backend?`, `initialVersion?` (seeding the ADR-0007
counter from persisted history — this is the durable-stamps arrival ADR-0007
scheduled for P11), and `onBackendError?` (the store does no I/O of its own and
cannot log; ADR-0008 precedent). **The `GraphStore` interface itself is
unchanged** — proven by an api-extractor report added to `graph-store` in the
same change. After each committed transaction the store notifies the backend
off the critical path (queued microtask, per-store FIFO so the backend sees
commits in order): `appendOps(delta)` then `persist(changes)`. Backend
rejections are contained and routed to `onBackendError`; they never poison the
store (same containment doctrine as listeners, ADR-0008).

**3. `OpOrigin` gains an optional `volatile?: boolean`** (the additive origin
growth ADR-0005 anticipated). A volatile commit is a real in-session commit —
the version advances, subscriptions fire, caches invalidate — but it is **not
history**: the store never forwards volatile ChangeSets to the backend, and the
wire form (`deltaToWire`) drops the flag. This is the vehicle ADR-0039 uses for
hydration/eviction ("eviction writes nothing — the log already has it", §4.7)
without opening a second write path.

**4. Schema v1** (storage-schema version axis, independent of the IR
`formatVersion` axis, per §15.3):

```sql
meta   (key TEXT PRIMARY KEY, value TEXT)            -- schema_version, format_version,
                                                     -- producer, checkpoint_seq, last_counter
graphs (id TEXT PRIMARY KEY, label TEXT, domain TEXT, provenance TEXT,
        node_count INTEGER, edge_count INTEGER)      -- counts maintained at checkpoint
nodes  (id TEXT PRIMARY KEY, graph_id TEXT REFERENCES graphs(id), kind TEXT,
        label TEXT, detail_graph TEXT, attrs TEXT, provenance TEXT)
edges  (id TEXT PRIMARY KEY, graph_id TEXT REFERENCES graphs(id), src TEXT,
        dst TEXT, kind TEXT, weight REAL, attrs TEXT, provenance TEXT)
oplog  (seq INTEGER PRIMARY KEY AUTOINCREMENT, counter INTEGER NOT NULL,
        site TEXT NOT NULL, actor TEXT NOT NULL, ops TEXT NOT NULL)
-- indices: nodes(graph_id), edges(graph_id), edges(src), edges(dst)
```

JSON columns (`attrs`, `provenance`, `ops`) store the **ADR-0004 wire shapes,
canonically rendered** — one codec, byte-stable round-trips, and `oplog.ops` is
exactly the `PortableDelta` op array (`deltaToWire`), so cross-session replay
gets ADR-0005's `prev`-assertion conflict detection for free. No wall-clock
timestamps in v1 (nothing needs them; determinism stays easy).

**5. Durability protocol — log first, elements as checkpoint (§15.2).**
- Every committed non-volatile delta is appended to `oplog` in its own SQLite
  transaction — this is continuous autosave (§15.3); there is no save prompt.
- Element tables are a **write-behind checkpoint**: `persist(change)` enqueues;
  every `checkpointEvery` deltas (default **64**) and on `close()`/`flush()`,
  one SQLite transaction applies the queued element mutations, updates
  `graphs.node_count/edge_count`, and sets `meta.checkpoint_seq` to the last
  materialized `oplog.seq`.
- **Open = load element tables + replay the oplog tail** (`seq >
  checkpoint_seq`) through the pure `applyDelta`, then checkpoint. A kill -9
  at any moment loses at most the current SQLite transaction (WAL atomicity);
  everything appended is recovered by tail replay. `initialVersion` seeds from
  `meta.last_counter`.
- Single-writer assumption (documented, per roadmap §8): one store instance
  per file; multi-writer is P12's server. WAL mode; a second opener's busy
  errors surface as typed `storage-busy` refusals, never corruption.

**6. Failure policy (§17.4).** On open: `PRAGMA quick_check` — failure is a
typed `storage-corrupt` refusal naming the salvage path;
`salvageProject(path)` best-effort-reads element tables into a
`GraphDocument` for export (it never writes the damaged file). Storage-schema
migrations are chained single-step (`ADR-0004` discipline on the second axis),
run on open **after a pre-migration backup copy** of the file; a failed
migration refuses read-write and offers the same export path. A db whose
`schema_version` is newer than supported refuses (no best-effort on unknown
schemas). Disk-full and I/O errors during background persistence are surfaced
via `onBackendError` with the op-log position; the in-memory session stays
valid (persistence is an enhancement — §9 risk posture, and the browser
fallback below).

**7. Browser fallback.** The browser factory probes OPFS (secure context,
worker `createSyncAccessHandle`); unavailable → typed `opfs-unavailable`
result so the host falls back to **in-memory + document export** — the
fully-supported degraded mode. Persistence is never a correctness
requirement.

## Alternatives considered

- **LMDB / LevelDB-family.** Rejected: no credible browser story, so Node and
  browser would diverge into two backends with two consistency models.
- **IndexedDB directly.** Rejected: no SQL, transactions with foot-guns,
  quota-eviction semantics hostile to "one file the user owns"; wa-sqlite's
  IDB VFS remains a conceivable fallback *inside* the same backend if OPFS
  regresses.
- **Custom append-only log + JSON snapshots.** Rejected: re-implements WAL,
  torn-write handling, and partial reads that SQLite has spent twenty years
  hardening; §15.1 already chose SQLite.
- **sql.js (in-memory WASM, no VFS).** Rejected: whole-file-in-memory defeats
  partial reads and lazy hydration.
- **wa-sqlite instead of the official `@sqlite.org/sqlite-wasm`.** The draft's
  original choice (the constitution names it, §15.1, and its VFS layer is more
  pluggable). Rejected at 11D: its public API is asynchronous even on the sync
  build, which would force an async driver seam and a second (async) core —
  two consistency implementations where the whole design wants one (see the
  §1 amendment).
- **Materialize element tables on every commit (checkpoint N=1).** Rejected as
  the default: doubles commit-path write amplification and makes the recovery
  path dead code that can silently rot; write-behind keeps the log the primary
  artifact and the recovery path continuously exercised. `checkpointEvery: 1`
  remains a valid configuration.
- **Deltas as the backend's only input (drop `persist`).** Rejected: the
  roadmap names both; `persist(change)` receives the completed `ChangeSet`
  (with `touched`), which is what lets the backend maintain counts and later
  do smarter partial materialization without re-deriving effects from ops.

## Tradeoffs & consequences

- Binary project files are not text-diffable; the op log supplies better
  diff/merge than text would (ADR-A10), and document export remains the
  interchange path.
- Write-behind checkpointing means element tables lag the log by up to
  `checkpointEvery` deltas — the price of a thin commit path; every reader of
  the *file* (not the session) must go through open-with-replay, which is the
  only supported read anyway.
- A native module (better-sqlite3) enters the dev toolchain (build scripts
  allowlisted in `pnpm-workspace.yaml`); the browser adds a WASM asset.
- Two runtime bindings must be held to parity by a shared scenario suite (11D)
  rather than by construction.

## Reasoning

The op log is already the system's one source of truth for change (ADR-A2);
making it the primary *durable* artifact is the smallest persistence design
consistent with that — element tables are then a cache of `applyDelta` over
the log, checkpointed for open-time, and every consistency question reduces to
"which log prefix." SQLite's WAL gives atomic transactions on both runtimes,
so the recovery invariant is simply: any prefix of appended transactions is a
valid project. The backend seam matches §12.2's injected-storage doctrine and
keeps the P9 in-memory mode first-class.

## Future implications

P12's sync server sequences exactly these `oplog` rows (`site` becomes real,
ADR-0007). Snapshot checkpoints, compaction (opt-in, §15.2), zstd page
compression, and a columnar codec are all internal to the backend. Views,
layers, annotations, and plugin-data tables (§15.1) are additive schema
migrations. `evictHint` grows into real page-cache control when ADR-0039's
eviction proves the need.

## Open questions for review

1. **`checkpointEvery` default 64.** Chosen so a crash replays ≤ 64 deltas
   (well under the 3 s cold-open budget); confirm or tune at 11G with data.
2. **`volatile` on `OpOrigin`** vs a reserved actor prefix. The flag is
   explicit and type-visible; the prefix needs no type change. The flag is
   recommended (magic strings acquire accidental semantics).
3. **wa-sqlite vs official sqlite-wasm** — confirm the constitution's naming
   stands; the swap surface is one module either way.
