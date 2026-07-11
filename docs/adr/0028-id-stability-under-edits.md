# ADR-0028 — ID stability under edits: (path, qualifiedName, overloadHash), rename = remove+add, alias table reserved

- **Status:** Accepted
- **Date:** 2026-07-11
- **Phase:** 7 (roadmap)
- **Constitution:** ARCHITECTURE.md §3.1 (Identity), §3.2 (U4), §7.4 (identity stability under no-op re-ingest); ADR-0002 (deterministic IDs — this is its reserved ADR-0028), ADR-0005 (one write path)
- **Roadmap:** ROADMAP.md Phase 7 §7, §8 (ADR-0028), §11

## Context

The dogfood promise — *whitespace-only edit → empty delta; single-function edit →
delta touching only that function's subtree* (§11) — requires IDs stable under
unrelated edits. ADR-0002 fixed the scheme (deterministic from
`(domain, source, semanticPath)`; renames = remove+add; an alias table *reserved*
and named as this ADR). The roadmap grounds code IDs in `(path, qualifiedName,
overloadHash)` (§7). This record maps that onto ADR-0002's coordinate tuple,
names the flagship invariant, specifies behavior for the hard cases, and reserves
the alias mechanism concretely enough that v1 does not foreclose it.

## Decision

**Coordinate mapping** (roadmap `(path, qualifiedName, overloadHash)` →
ADR-0002 `(domain, source, path[])`, consumed via `ctx.ids.nodeId/graphId/edgeId`):

- `domain = 'code'`.
- `source =` the repository-relative **POSIX file path** (roadmap's `path`),
  normalized: forward slashes, NFC, no leading `./`. The stable source key.
- `path[] =` the **qualifiedName scope chain** from module root to the declaration
  — *syntactic scope names, never line/column* — e.g. `['ClassName','method']`,
  `['outer','inner']`, `['ns','Type','member']`; module-level = `['name']`. The
  **overloadHash** is appended as a final segment `#<hash>` **only when a name is
  not unique in its scope** (see hard cases).

*Amended 7C — directory nodes.* Project and package nodes (directories, not
declarations) take `source =` the directory's coordinate: the project uses the
ingest-root basename with `path = [projectName]` (so its detail-graph id cannot
collide with the root graph id); a package uses its repo-relative POSIX
directory path with `path = []`. Known residual: a descendant file path equal
to the project basename could collide pathologically; accepted for v1.
Namespaces are first-class scope segments (this record's own `['ns','Type',
'member']` example), so the eager kind set includes `code:namespace` — fold
into ROADMAP §7's kind list at the phase gate.

**Flagship invariant — whitespace-only edit ⇒ empty delta.** Every node/edge ID
derives from `(filePath, qualifiedName[, overloadHash])`; **none of these depends
on body text, formatting, comments, or byte offsets.** Reformatting a file changes
no ID. Provenance spans *do* shift, but the incremental differ's node-equality
**excludes the span**: a node whose id, kind, label, attrs-excluding-span, and
`detail` ref are unchanged emits **no op** even though its span moved. So the
guarantee holds literally at the op level. Consequence: after a pure-whitespace
edit, stored spans may lag; they are refreshed opportunistically on the next
*substantive* touch of that node or on a full re-ingest (spans are "current after
any substantive edit or full ingest"). This trades exact span freshness for the
delta-minimality the roadmap makes flagship — flagged below.

**Rename = remove + add (v1); rename detection deferred.** Renaming a declaration
changes its `qualifiedName` → new coordinates → new ID; the old node is removed,
the new added, incident edges removed and (if still referenced) re-added.
Recognizing a remove+add as a *move* — to carry annotations/history across it — is
**explicitly deferred**; it needs the alias table.

**Alias-table reservation (concrete, unbuilt).** IDs never change — that is
ADR-0002's whole point — so continuity is added as *additive metadata over stable
IDs*, not by mutating identity:

- Reserve the edge kind **`core:alias-of`** (old identity → new identity), living
  in an annotation/alias layer, populated by a *future* rename/move detector.
- It enters through the **one write path** as ordinary tagged proposals (derived
  opinion, like AI/analytics — ADR-0005/§14.1), carrying
  `{ confidence, evidence, provenance }`. A consumer wanting rename continuity
  (annotation survival, history, diff) follows the `core:alias-of` chain; the
  graph's structural identity is untouched.

This forecloses nothing (a detector is additive) and adds nothing to v1 (the kind
is reserved, unused).

**Hard cases.**

1. **Anonymous / default exports.** `export default …` → segment `default` (at
   most one per module — unique, stable). An anonymous function bound to a name
   (`const f = …`) takes the binding name `f` (identity is the binding). Truly
   unbound anonymous functions (callback literals) are *body-internal* (lazy,
   ADR-0027) and get **structural positional** segments in their function's body
   subgraph (`arg-0`, `cb-<ordinal>`) — stable under whitespace because ordinals
   are the nth callback of the nth call, not textual.
2. **Overloads** (TS overload signatures / declaration merging; Python `@overload`
   stubs). Disambiguated by an `#<signatureHash>` segment: a short stable hash of
   the **signature shape** (param arity + param type annotations as-written +
   `static`/`async`/generic markers), *text-normalized* so reformatting the
   signature does not change it, but changing a parameter type does (a genuinely
   different overload). Two overloads = two IDs; adding a third perturbs neither
   existing one. ADR-0026 resolves a call to an overloaded name as *unresolved*
   (it does not pick an overload).
3. **Nested functions.** `path = ['outer','inner']`; `inner` is a child in
   `outer`'s **body detail graph** (lazy, ADR-0027). Stable under whitespace
   (scope names). Renaming `outer` cascades new coordinates to `inner`
   (remove+add) — correct: its qualified identity did change.
4. **Duplicate names in one scope, not overloads.** Block-scoped duplicates sit at
   different scope paths (differing enclosing-block segments) and don't collide.
   A genuine same-scope, same-signature duplicate (illegal but tree-sitter parses
   error-tolerantly) gets a positional discriminator `~<declIndex>` (source-order
   ordinal among same-name same-scope declarations) as the last segment, and the
   node is flagged `code:duplicate: true` (honest). Keeps IDs unique (U1),
   deterministic, no throw.
5. **File moves / renames.** Moving a file changes `source` → all its declarations'
   coordinates change → whole-file remove+add. **Deliberate v1 behavior** (a file
   move is a file-level rename; the reserved alias table covers it uniformly — a
   future detector can emit `core:alias-of` over the moved subtree). In-repo
   `code:imports` to the moved file re-resolve to the new path. Documented cost:
   file moves lose identity continuity until the alias table lands.
6. **Re-exports / multiple import paths.** Identity is the **declaration site**,
   not any import site; re-exports create `code:imports` edges, never new
   declaration nodes. A symbol has exactly one identity regardless of how many
   modules re-export it.

**Determinism & uniqueness.** Every discriminator (`#hash`, `~n`, body ordinals)
is a pure function of the parse tree in source order; ties never depend on hashing
order; U1 is enforced by the store gate. Conformance (7C/7D) tests identity
stability under no-op re-ingest and the discriminator rules per construct (§7.4).

## Alternatives considered

- **Line/offset-based IDs.** Rejected (ADR-0002): any edit above a symbol changes
  its ID; whitespace edit → whole-file delta — fatal to the flagship test.
- **Content-hash IDs (hash the body).** Rejected: editing a body would change
  identity — defeats "same function across versions."
- **Rename detection in v1** (similarity-match old/new trees). Rejected: needs a
  nondeterministic-feeling matching heuristic and the alias layer to record
  results; deferred with the mechanism reserved.
- **Overload disambiguation by declaration order (`~n`) as the primary scheme.**
  Rejected: reordering overloads (a near-whitespace edit) would renumber and churn
  IDs; the signature hash is reorder-stable. `~n` is kept only for illegal
  duplicates where no signature distinguishes them.
- **Spans in ID or in delta-equality.** Rejected: breaks the empty-delta invariant.

## Tradeoffs & consequences

Buys the empty-delta and minimal-delta guarantees and durable annotations across
unrelated edits. Costs: identity loss on rename/move until the alias table
(accepted, reserved); a signature-hash computation for overloaded names; span
drift after pure-whitespace edits (accepted for delta minimality, flagged).

## Reasoning

Identity must track an element's *position/role in the scope tree*, not its text
or offsets — the only function under which "unrelated edit → small delta" holds.
`(filePath, qualifiedName, overloadHash)` is exactly that role. The alias table is
reserved, not built, because rename continuity is a real future need but adds a
matching heuristic and a layer v1 does not require and the roadmap defers.

## Future implications

The reserved `core:alias-of` edge + alias layer let a future rename/move detector
restore continuity **additively**, via proposals, with no ID-scheme change
(ADR-0002's promise). P8 AI can propose aliases (derived opinion). P11 annotations
and P12 sync ride on these stable IDs. ADR-0005's anticipated cheap `node:move`
op could later turn a pure rename into a `node:move` rather than remove+add once
the alias table exists — reserved, not built.

## Open questions for review

1. **overloadHash inputs.** ~~Open~~ **Resolved 7C:** param arity + param types
   as-written (colon-stripped, whitespace-normalized) + `async`/`static`/
   generator/`abstract` markers + **return type** (so return-type-only TS
   overloads get distinct IDs); param *names* excluded. Python's `@overload`
   rule to be confirmed against this in 7D.
2. **Span drift.** Confirm that provenance spans are "current after any
   substantive edit or full ingest," not after a pure-whitespace edit — this is a
   real tension with "provenance is exact" and should be folded back as a note on
   ADR-0002 / §7.4 if accepted. (Still open; lands with the 7G differ.)
3. **`default`-export identity.** ~~Open~~ **Resolved 7C:** segment `default`
   only for a truly anonymous `export default`; a *named* default export keeps
   its binding name (it is a real local binding).
