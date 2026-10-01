# AutoBuild organization contract v1

This directory vendors AutoBuild's organization contract boundary for Meridian
consumers. The normative machine files are the three JSON Schemas in
`schemas/`. The `fixtures/org/` and `fixtures/org-run-events/` trees carry the
shared positive and negative corpora, and their own `SHA256SUMS` files pin every
fixture byte.

## Provenance

- Source repository: AutoBuild (`https://github.com/prithvirajmody/AutoBuild.git`)
- Source commit: `032e4a141a9ee4a2d0047adb2f3e79b169853025`
- Vendoring date: 2026-07-29
- Source schemas: `src/autobuild/org/schemas/`
- Source fixtures: `tests/fixtures/org/` and `tests/fixtures/org_run_events/`

## Update policy

Schemas and fixtures are copied verbatim from AutoBuild and are never edited in
Meridian. To update this corpus, change and review it in AutoBuild first, copy
the accepted bytes here, update this provenance and the root manifest, and
advance the hardcoded manifest anchor in the Meridian contract test.

AutoBuild's compatibility policies are reproduced verbatim below.

### `org-definition-v1`

Version 1 is additive-only. New optional vocabulary may be added only when old
v1 documents retain identical meaning and digest verification remains
unchanged. A required field change, a field removal, a changed invariant, or a
changed digest formula requires a new major schema version and an explicit
migration plan. Loaders reject unsupported major versions; they do not guess.

### `org-run-events-v1` and `org-bundle-v1`

Version 1 is additive-only while existing fields retain identical meaning.
Fields, enum values, ordering rules, digest formulas, or invariants cannot be
removed or reinterpreted within v1. A breaking change requires a new schema
version and explicit adapter support. Loaders reject unsupported versions and
never guess or migrate in place.
