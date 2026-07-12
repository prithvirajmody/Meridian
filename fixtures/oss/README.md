# OSS scale fixture (Phase 7H)

The Phase 7 gate requires a **pinned real OSS repository (~100k LOC)** to prove
cold-ingest scale and byte-determinism (ROADMAP Phase 7 §11–12). We do **not**
vendor 100k LOC into this monorepo — the clone lives outside the committed tree
and only a compact **summary golden** is checked in.

## The pin

| | |
|---|---|
| Repo | [`vuejs/core`](https://github.com/vuejs/core) |
| Commit | `c0606e91798c8dca4f33d101e1dd836d672592c1` |
| Language | TypeScript |
| Size | 489 `.ts`/`.tsx` files, ~153k LOC (excluding `.d.ts` count; `.d.ts` are ingested) |
| Measured cold ingest | **~2.8 s** on the gate hardware (budget < 30 s) |

`vuejs/core` was chosen because it is a large, pure-TypeScript, actively
maintained codebase that comfortably exceeds the ~100k-LOC target while
ingesting well under the 30 s budget — the eager graph is only ~1.9k nodes
(project → package → module → class/function **signatures**), which is exactly
the ADR-0027 laziness win: node count is O(declarations), not O(LOC).

## Fetch (reproducible, outside the tree)

```sh
fixtures/oss/fetch.sh
```

Shallow-fetches exactly the pinned commit into `fixtures/oss/clones/vue-core`
(gitignored). Network access required. Idempotent: re-running is a no-op when
already at the pin.

## The committed golden

`fixtures/goldens/oss/vue-core.summary.json` — a **compact summary**, not a
megabyte document dump: per-kind node/edge counts, totals, the ADR-0026 call
`resolutionRate`, and a **SHA-256 digest of the canonical ingested document**
(the byte-determinism anchor). It is pinned to the commit above.

## Regenerate the golden

Following the repo's `UPDATE_GOLDENS` convention (never edit goldens by hand):

```sh
fixtures/oss/fetch.sh
UPDATE_GOLDENS=1 pnpm --filter @meridian/cli test oss-scale
```

## CI behavior

`apps/cli/test/oss-scale.test.ts` **skips** when the clone is absent (normal CI
never fetches), and otherwise asserts: cold ingest < 30 s, byte-identical
document across two runs, and an exact match against the summary golden. Point
it at a different clone with `MERIDIAN_OSS_REPO=/path/to/clone`.
