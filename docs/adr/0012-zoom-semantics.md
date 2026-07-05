# ADR-0012 — Zoom semantics: continuous scalar → discrete level cut, with hysteresis and per-node overrides

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 3 (roadmap)
- **Constitution:** ARCHITECTURE.md §5.1, §5.4, §5.6, §3.1 (Abstraction), §3.2 (I5); ADR-A3
- **Roadmap:** ROADMAP.md Phase 3 §5, §7, §8 (ADR-0012)

## Context

The product thesis — "zoom changes abstraction" — is only testable if abstraction
state is a value and resolution is a pure function (§5.1, ADR-A3). The
constitution fixes the *shape*: a global zoom scalar mapped through a `LevelChain`
to a base level, plus per-node overrides, plus focus and node budget, resolved to
a **Cut** (an antichain covering every leaf exactly once, I5) with an explaining
**trace**. This record finalizes the exact scalar→level mapping, the hysteresis
mechanics, the override semantics and their precedence, and the trace vocabulary.
Node budget and salience are ADR-0014; induced-edge aggregation is ADR-0013.

## Decision

**Zoom scalar.** `z ∈ [0, 1]`, where **`z = 0` is the coarsest view (roots only)
and `z = 1` is the finest (leaves)** — increasing `z` reveals more detail, the
Maps convention. A `LevelChain` for a domain is an ordered list of `L` named
levels, index `0` (coarsest) … `L−1` (finest).

**Scalar → base level (`levelForZoom`).** `ZoomPolicy = { thresholds, hysteresis,
budget }`. `thresholds` is the `L−1` interior boundaries `p₁ … p_{L−1}` (ascending,
in `(0,1)`); band `i` is `[pᵢ, pᵢ₊₁)` with `p₀ = 0`, `p_L = 1`. The nominal level
is the band containing `z`. `hysteresis` is a width `h ≥ 0`:

- Resolution is **pure**, so the prior level is an explicit input: the resolver
  accepts an optional `prevLevel` (added to `LodRequest`; see Open questions).
- With `prevLevel` present and `|nominalLevel(z) − prevLevel| ≤ 1`: the level
  changes `prevLevel → prevLevel+1` only when `z ≥ p_{prevLevel} + h/2`, and
  `prevLevel → prevLevel−1` only when `z < p_{prevLevel−1} − h/2`; otherwise it
  stays `prevLevel`. Hovering at a boundary never flaps (§5.4).
- A jump of more than one band (`|nominal − prevLevel| > 1`) **snaps** to
  `nominalLevel` — a fast/teleport zoom is not sticky.
- With `prevLevel` absent (a fresh resolve), the level is `nominalLevel(z)`,
  hysteresis-free and deterministic.

**Default cut at base level `b`.** Walk each root's containment tree top-down. For
every root-to-leaf path emit the node at level index `b`; if a path bottoms out
before reaching `b` (ragged hierarchy), emit its leaf. This alone is a covering
antichain (I5).

**Per-node overrides** (`ReadonlyMap<NodeId, 'pin' | 'expand' | 'collapse'>`) locally
adjust the descent. During top-down descent each node is either **emitted** into
the cut or **descended through**, by this precedence (first match wins):

1. `pin(n)` → **emit `n`** and stop descending (n is held at its own granularity).
2. `expand(n)` → **descend** into `n`'s detail-graph children (one level finer).
3. `collapse(n)` → **emit `n`** and stop, *unless* `n`'s subtree contains a
   `pin`/`expand` override, in which case descent continues to reveal it.
4. A cold (unhydrated) detail graph, or a leaf → **emit `n`** (cannot descend);
   trace tag `cold` / `leaf`.
5. Otherwise (no override): **emit `n`** if `n`'s level ≤ `b` *and* `n`'s subtree
   holds no `pin`/`expand`; else **descend**.

**Precedence rule — deepest override wins.** A `pin`/`expand` on a *descendant*
pierces a `collapse`/level decision on an *ancestor*: the path to the pinned node
is opened while its siblings stay collapsed. This is precisely focus+context
(§5.6) — "collapse this module but keep this one function open" must be
expressible. A `pin` under a `pin` is unreachable; the inner one is ignored and
noted in the trace.

**Focus.** In v1 focus is **inert for the scalar→cut mapping** — no focus-relative
zoom, no fisheye (deferred, §5.4/P6). Focus is recorded in the trace and consumed
only as (a) the drill-in context anchor (the *verb* drill-in lands with the P6
navigation controller; P3 fixes only that it is distinct from continuous zoom) and
(b) a salience input protecting the focused path from budget collapse (ADR-0014).

**Cut trace (`CutTrace`).** For every emitted node the trace records exactly one
inclusion reason: `level` | `leaf` | `pin` | `collapse` | `expand-parent`
(emitted because an ancestor was expanded down to it) | `cold` | `budget`
(ADR-0014). It also records, per node, the containment subtree it summarizes (the
dependency set ADR-0013's cache and §5.5 invalidation key on). "Why is this node
visible/hidden?" always has a located answer (§5.1).

**Frontier.** `frontier.expandable` = emitted non-leaf, non-cold nodes with a
descendable detail graph; `frontier.collapsible` = emitted nodes whose parent has
no other reason to stay open. Cold nodes appear in `expandable` flagged
needs-hydration (hydration itself is P11).

**Invariants held mechanically.** Descent partitions each tree into a frontier
antichain, so I5 (cover every leaf exactly once) holds for any override map. The
resolver is a pure deterministic function of `(space, chain, policy, z, focus,
overrides, prevLevel, budget)`; ties in any ordering break by `NodeId` ascending
(I6). Overrides referencing removed nodes are ignored and reported in the trace,
never throw.

## Alternatives considered

- **Renderer-driven LOD (hide by screen size).** Rejected (ADR-A3): abstraction
  becomes a UI mood, untestable and inconsistent across domains.
- **Zoom scalar reversed (`0` = finest).** Rejected: increasing-detail-with-zoom
  matches every map tool and every user's intuition.
- **Ancestor override wins over descendant.** Rejected: makes focus+context
  ("collapse all but this") inexpressible — the whole point of per-node overrides.
- **Stateful hysteresis inside the resolver.** Rejected: breaks purity/I6. The
  prior level is passed in; the navigation controller (P6) owns the state.
- **Focus-relative (fisheye) zoom in v1.** Rejected: §5.4 names fisheye a
  deferred technique; v1 keeps focus inert for the mapping.

## Tradeoffs & consequences

- Passing `prevLevel` in threads a scrap of navigation state through an otherwise
  stateless call; in exchange the resolver stays pure and testable, and hysteresis
  is verifiable headless (oscillating-input → zero cut-flaps, roadmap 6C).
- Deepest-wins precedence makes the descent a single recursive pass but requires a
  "subtree contains a pin/expand" predicate — precomputed once per resolve.
- Ragged hierarchies are handled by "emit the leaf if the path is short," which
  means a level-`b` cut can contain nodes shallower than `b`; consumers must not
  assume uniform depth. This is deliberate (§5.6 mixed depth is native).

## Reasoning

The scalar is what a wheel/pinch produces; discrete levels are what "abstraction"
means; hysteresis is what keeps a boundary from flapping; overrides are what make
focus+context a first-class operation rather than a separate fisheye subsystem.
Purity plus an explicit `prevLevel` reconciles the continuous gesture with a
deterministic, cacheable function. The trace exists because an LOD bug with no
"why" is undiagnosable (§5.1).

## Future implications

P6 wires the hysteresis state machine and the drill-in verb around this pure core
and adds anchor preservation (the world point under the cursor maps through the
refinement). The trace's per-node dependency set is exactly what ADR-0013's cache
and §5.5's exact invalidation consume. AI/generated levels (P8) enter as ordinary
`LevelChain` levels with no change to this resolver. Constants (`h`, thresholds)
are frozen as *mechanism* here and re-tuned in P6 with the real camera attached
(roadmap Phase 3 §9c).

## Open questions for review

1. **Zoom direction.** `z = 0` coarsest, `z = 1` finest (Maps convention).
   Confirm, or prefer the inverse.
2. **`prevLevel` on `LodRequest`.** The roadmap's §5 `LodRequest` sketch omits any
   hysteresis carrier, but a pure resolver needs the prior level to apply offset
   triggers. Proposed: add an optional `prevLevel?: number` (additive, ignored
   when absent). Confirm, or prefer the controller resolving the level and passing
   a discrete level in place of `z`.
3. **Override precedence.** Deepest override wins (descendant `pin`/`expand`
   pierces ancestor `collapse`). Recommended as specified; flagging because it is
   the one override interaction the docs leave genuinely open and it shapes the
   focus+context feel.
