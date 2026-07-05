# Phase 2 — manual exploratory checklist

ROADMAP Phase 2 §12, manual-exploratory row: *"Write a toy 'TODO-list'
adapter in <1 hour using only plugin-api docs — friction found = docs/contract
fixes."* Performed 2026-07-05. (The toy adapter is kept alive as
`packages/conformance-kit/test/toy-todo.test.ts`, run through the conformance
kit in CI, so this check cannot rot.)

- [x] **Toy TODO-list parser authored against the contract alone** — domain
      `todo`, `Project:`/`- [ ]` line format; manifest with vocabulary
      (`todo:project`, `todo:task`; `todo:tasks`/`todo:done`/`todo:index`
      attr schemas); recursion via project → task detail graphs; provenance
      with line spans; typed throws on orphan tasks and binary input. Well
      under the hour.
- [x] **It passes the conformance kit unmodified** — including determinism,
      gate validity against its own declared vocabulary, and crash
      containment on the `reject/` entries.
- [x] **Friction 1 → contract fix:** emissions could not be *typed* using
      plugin-api alone (`GraphDocument` lived only in graph-core). Fixed:
      plugin-api re-exports the wire types (`GraphDocument`,
      `SemanticCoords`, `AttrValueType`).
- [x] **Friction 2 → kit fix:** `loadCorpusDir` shipped a built-in media-type
      table (contract package knowing domain file types — also caught by the
      new grep gate). Fixed: media types are caller-supplied; the kit ships
      none.
- [x] **Friction 3 → documented limitation:** `emitDelta` is loosely typed in
      0.1 by design (op vocabulary belongs to graph-store; P7 is the declared
      checkpoint for streaming parsers). Recorded in the plugin-author guide
      and ADR-0010's checkpoint list.
- [x] **Write-up became the guide** — `docs/guides/plugin-authors.md`
      (Definition-of-Done item: first draft of the plugin-author guide).
- [x] **Failure feel reviewed at the CLI** — unclaimed binary source, forced
      unknown adapter, and (in host tests) a mid-stream parser crash each
      produce a typed, single-cause message; nothing partial is ever kept.
- [x] **`meridian ingest` output reviewed by hand** — the links corpus:
      section nesting reads correctly at every level, portal-rule edges land
      in the expected lowest common graphs with correct weights, spans point
      at the right lines.
