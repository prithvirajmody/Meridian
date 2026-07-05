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
- `goldens/cli/` — byte-exact expected CLI output per fixture/command,
  asserted by `apps/cli/test/golden.test.ts`.

Notes: goldens are generated under the CI Node major (24); the
`validate.malformed` golden embeds V8's JSON error text, which can vary
across Node majors.
