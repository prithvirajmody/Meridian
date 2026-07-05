# Driving Claude Opus 4.8 through the Meridian implementation

A short operator's guide for implementing Meridian with Claude Opus 4.8 in
Claude Code, one roadmap phase at a time. The two governing documents are:

- [ARCHITECTURE.md](ARCHITECTURE.md) — the constitution (*what* and *why*; wins all conflicts)
- [ROADMAP.md](ROADMAP.md) — the phased plan (*when*; per-phase specs, tests, DoD)

The model implements; the documents govern; you gate.

---

## 1. Repo setup (once, before Phase 0)

Create the new `meridian/` repo and copy both documents into `docs/`. Then
put this in the repo's `CLAUDE.md` so every session starts constitutionally
bound:

```markdown
# Meridian — standing instructions

Governing docs: docs/ARCHITECTURE.md (constitution — wins all conflicts) and
docs/ROADMAP.md (current phase spec). Read the current phase's section of the
roadmap before writing any code.

Hard rules (violations are bugs, not style):
- All mutation goes through op-based deltas. Never add a second write path.
- graph-core/graph-store/abstraction contain no domain words, no DOM, no AI
  imports. Check the dependency law in ARCHITECTURE.md §20 before adding any
  package import.
- Every element gets provenance. AI output enters only as tagged proposals.
- Semantic computations are pure functions. Push I/O to the edges.
- A finalized decision = a merged ADR in docs/adr/. If you hit a decision the
  docs leave open, write the ADR draft first and stop for approval.
- Golden files change only via the documented regen command, never by hand.
- The phase is not done until every row of its verification table passes and
  its Definition of Done checklist is literally checked.

Working style:
- For minor choices (naming, file layout, which of two equivalent approaches),
  pick a reasonable option and note it rather than asking. For scope changes,
  ADR-level decisions, or destructive actions, ask first.
- Don't add features, refactor, or introduce abstractions beyond what the
  current phase requires. The roadmap's "Intentionally deferred" list is
  binding — do not build deferred items early, even partially.
- Default to silence between tool calls; report when you find something
  load-bearing, change direction, or hit a blocker.
- Before reporting progress, audit each claim against a tool result from this
  session. If tests fail, say so with the output. Never claim a gate passes
  without having run it.
- When a task fans out across independent items (writing test suites for many
  ops, porting many fixtures), delegate to subagents; for single-file
  sequential work, work directly.
```

Settings: model `claude-opus-4-8`, effort `xhigh` for implementation
sessions (`high` is fine for docs/test-writing sessions). Keep sessions
scoped to one phase-step; long-horizon work goes better with the full step
spec in the first message than with drip-fed instructions.

## 2. The per-phase loop

Each roadmap phase runs the same five-beat loop. For Phases 3–12 the build
beat (step 2) is pre-sliced into single-session subphases in
[SUBPHASES.md](SUBPHASES.md) — run one subphase per session, in order,
committing after each.

1. **ADR beat.** Prompt: *"Read ROADMAP.md Phase N §8 ('Technical decisions
   that must be finalized'). Draft each listed ADR into docs/adr/, following
   the constraints ARCHITECTURE.md already fixes. Stop after drafting — do
   not implement."* You review/approve the ADRs. Nothing else starts first.
2. **Build beat.** One session per deliverable cluster. Kickoff prompt shape:

   > We are in Phase N of docs/ROADMAP.md. Implement <deliverable(s)> per
   > that phase's sections 3–7, honoring ADR-XXXX..YYYY. Constraints:
   > ARCHITECTURE.md §<relevant sections>. Write the tests from the phase's
   > verification table for this deliverable as you go, not after. When done,
   > run the full suite and report actual results.

   Give the whole step up front — spec, constraints, done-criteria — and let
   it run. Don't interleave design debates mid-build; if it surfaces a real
   design gap, that's a new ADR beat.
3. **Verification beat.** Prompt it to walk the phase's verification table
   row by row, running each harness and pasting real output. For the review
   pass, run `/code-review` with a coverage-first instruction ("report every
   issue including low-severity/uncertain ones with confidence + severity;
   filtering happens downstream") — Opus 4.8 follows conservative-reporting
   instructions literally, which silently lowers recall.
4. **Demo beat.** Have it execute the phase's demo (§3 of the roadmap's
   executive table) via the documented command and write/refresh
   `docs/demos/<phase>.md`. You personally run the demo too — especially
   Phases 5–6, where "feel" is a human gate the model cannot self-certify.
5. **Gate beat.** Prompt: *"Check Phase N's Definition of Done literally.
   For each item, cite the evidence (test run, ADR link, artifact)."* Only
   you close the gate. Then commit, tag `phase-N`, and open the next phase.

## 3. Prompts for known Opus 4.8 tendencies

Paste these when the behavior appears (or preemptively in the phase kickoff):

- **Over-asking / stopping early:** "You are operating autonomously within
  this phase's spec. For reversible actions that follow from the spec,
  proceed without asking. End your turn only when the step is complete or
  blocked on an ADR-level decision."
- **Unrequested tidying at high effort:** "Only make changes the current
  phase requires. A failing test doesn't need surrounding cleanup. Don't
  design for hypothetical future phases — the roadmap already sequences
  them."
- **Under-using the harness:** be explicit about *when* — "Run the property
  suites after every change to graph-core; run the benchmark suite before
  claiming any performance criterion."
- **Verbose wrap-ups:** "Final summary: outcome first, then only the detail
  that changes what I do next."

## 4. What stays human

- Approving ADRs and any constitution amendment (ARCHITECTURE.md's
  amendment procedure).
- Golden-file regeneration review (diffs of goldens are design decisions).
- The manual-exploratory checklists and all "feel" judgments (zoom
  transitions, layout readability, AI summary quality ratings).
- API keys, AI budget settings, and the egress-consent defaults.
- Closing every phase gate. The model proposes done; you declare done.

## 5. First prompt of the project

> Read docs/ARCHITECTURE.md fully, then docs/ROADMAP.md Phase 0. Begin the
> ADR beat: draft ADR-0001 through ADR-0004 into docs/adr/ and stop for my
> review. Do not scaffold the monorepo yet.

From there, the loop in §2 carries the project phase by phase to M4.
