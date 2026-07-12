# @meridian/conformance-kit

## Unreleased — Phase 7G (incremental conformance)

Adds `describeIncrementalConformance`: the reusable, store-free harness for
`IncrementalAdapter` (ROADMAP §7). Given a session factory, a from-scratch
ingest oracle, and scripted edit scenarios, it pins per-edit **minimal deltas**
(whitespace ⇒ 0 ops; a one-declaration edit ⇒ an asserted op count), gate-valid
documents after every edit, **convergence** to a cold ingest (I6), and
determinism — imports stay plugin-api + graph-core only (§20). `vocabularyOf`
moves to its own module (no behaviour change) to keep the two suites
import-cycle-free.

## 0.1.0 — 2026-07-05 (Phase 2)

Initial kit: `describeParserConformance` (manifest/exports coherence, sniff
purity/range/claims, IR-gate validity with the plugin's declared vocabulary,
skeleton determinism ⇒ identity stability, AI-freeness, crash containment),
`loadCorpusDir` (`reject/` convention, caller-supplied media types),
`idFacade`, `vocabularyOf`.
