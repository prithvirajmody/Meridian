# Fixture corpus & goldens

The regression floor (ROADMAP §5.2): hand-written graph documents plus
pinned CLI output. **Golden files change only via the documented
regeneration command, never by hand** (CLAUDE.md hard rule):

```
pnpm goldens:update
```

Review the resulting diff like a design decision — a changed golden is a
changed contract.

## Layout

- `corpora/markdown/` — the Phase 2 adapter corpus: `basic`, CommonMark edge
  cases (setext, skipped depths, fences/indented code, nested lists, quotes,
  html blocks, unicode, duplicate headings), `links` (portal-rule anchors,
  multiplicity, broken anchors), `pathological-nesting`, `no-headings`,
  `empty`, and `reject/binary.bin` (must fail ingest, never the host).
  Consumed by the conformance kit and the `ingest.*` CLI goldens.


- `valid/` — documents that must decode, validate, and round-trip (I3):
  - `deep-nest` — 6 graphs, 5 containment levels, weights, an `ai`-origin
    element, a namespaced attr (exercises the Phase 0
    `unregistered-namespace` warning).
  - `flat-simple` — the smallest valid space; zero warnings.
  - `unicode-labels` — CJK, emoji + ZWJ, RTL, and a *decomposed* `café`
    (stored as `café`; decode must NFC-normalize it).
  - `portal-links` — a cross-boundary link in its legal recorded form
    (edge at the lowest common graph, deep endpoints as `portal:*` attrs —
    ADR-0001 §4.3).
- `invalid/` — adversarial documents, each rejected with a precise, located,
  typed error (see `packages/graph-core/test/codec.failure.test.ts` for the
  expected code per file).
- `scripts/` — op-delta scripts for `meridian mutate|watch --apply`
  (Phase 1, ADR-0005 wire form):
  - `session.json` — the 20-op demo editing session against `deep-nest`
    (every op type except `graph:remove`; see `docs/demos/phase-01.md`).
  - `bad-node.json` / `stale.json` / `invalid-shape.json` — rejection cases
    (atomic rollback, stale baseVersion, script-gate aggregation).
  - `watch-1.json` / `watch-2-stale.json` / `watch-3-teardown.json` — the
    `watch --apply` stream (teardown exercises detail-release +
    `graph:remove`).
  - `m1-errata.json` — the M1 demo mutation (Phase 3, `docs/demos/m1.md`):
    adds an "Errata" section + detail graph + `doc:links-to` edge to the
    ingested `links.md` document (stable IDs make the checked-in script
    valid against any re-ingest of the same file).
- `deltas/` — completed (invertible) deltas for `meridian invert`:
  - `small-undoable.delta.json` — hand-written, prev payloads included.
- `goldens/cli/` — byte-exact expected CLI output per fixture/command,
  asserted by `apps/cli/test/golden.test.ts` and (Phase 3, the `cut.*`
  files) `apps/cli/test/cut-golden.test.ts`: `meridian cut` across the
  markdown corpus **at every level**, the `valid/` documents at every
  level, and `--json` / `--focus` / `--zoom` forms.
- `.cut-inputs/` (gitignored) — the cut goldens' input documents, produced
  by the real `meridian ingest` over `corpora/markdown/` by the golden test
  itself on every run. Ingest is byte-deterministic (I6/U4), so these need
  no pinning; only the cut *outputs* are goldens.

Notes: goldens are generated under the CI Node major (24); the
`validate.malformed` golden embeds V8's JSON error text, which can vary
across Node majors.
