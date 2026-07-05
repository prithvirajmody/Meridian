# Phase 1 — manual exploratory checklist

ROADMAP Phase 1 §12, manual-exploratory row: *"Script a 20-step editing
session via CLI; undo it all via inverted deltas."* Performed 2026-07-05.
(The same session is automated in `apps/cli/test/session.test.ts` so this
check cannot rot.)

- [x] **20-step session authored by hand** — `fixtures/scripts/session.json`:
      20 ops spanning 8 of 9 op types (graph:add, graph:meta, node:add,
      node:remove, node:attr, node:detail, edge:add, edge:remove) against
      the `deep-nest` fixture; `graph:remove` exercised via
      `fixtures/scripts/watch-3-teardown.json`.
- [x] **Session applies atomically** — `meridian mutate --script` reports
      v0 → v1, per-op lines, touched sets; resulting document valid
      (`meridian validate` OK, 8 graphs / 15 nodes / 8 edges / depth 5).
- [x] **Undo via inverted delta** — `--emit-delta` → `meridian invert` →
      `mutate` restores the original **byte-for-byte** (modulo producer
      stamp, canonically identical either way).
- [x] **Redo** — inverting the inverse and applying to the original
      reproduces the mutated document byte-for-byte.
- [x] **Failure feel** — bad node id, stale baseVersion, and malformed
      script each rejected with a typed, located message and an explicit
      "nothing applied" line; the input file is never touched.
- [x] **Watch output reviewed (UI-verification substitute)** — replay mode
      output reads cleanly (one block per commit, op lines, rejection
      inline); live mode turns editor saves into semantic diffs and calls
      out no-op saves; Ctrl-C exits quietly. Long-delta output caps at 20
      op lines with an explicit "… n more ops" tail.
- [x] **Doc-driven authoring check** — the session script was written from
      ADR-0005's op table + `fixtures/README.md` alone; the one friction
      found (a delta file needs an `origin` and there was no example) is
      addressed by the fixtures README listing and the demo doc examples.
