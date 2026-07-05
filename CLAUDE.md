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
