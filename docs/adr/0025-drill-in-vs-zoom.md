# ADR-0025 — Drill-in vs zoom: zoom moves the cut and saturates; scope changes are always explicit, in both directions

- **Status:** Accepted
- **Date:** 2026-07-12
- **Phase:** 6 (roadmap)
- **Constitution:** ARCHITECTURE.md §5.4 (drill-in vs zoom), §5.6 (context stack, breadcrumbs, serializable navigation state), §10 (command taxonomy: navigation effects); ADR-A3
- **Roadmap:** ROADMAP.md Phase 6 §3, §5–§7, §8 (ADR-0025), §11, §12

## Context

The constitution separates the verbs: continuous zoom moves the *cut*
(communicates **scale**); explicit drill-in changes *context* — the focused
node's detail graph becomes the working root (communicates **scope**).
Conflating them is a named failure mode of zoomable UIs (§5.4). What the docs
leave open, and this record fixes, is the boundary behavior: what each input
gesture triggers, what happens when zoom saturates at the finest/coarsest
level, how camera scale couples to the zoom scalar, what drill-in does to
zoom and camera in the new context, and what the URL codec must carry so the
whole navigation state round-trips (§5.6: "where I am" is a value).

## Decision

**Verb → trigger table (exhaustive; anything not listed does nothing).**

| Verb | Triggers | Effect |
|---|---|---|
| Continuous zoom | wheel, pinch, `+`/`−` keys, zoom slider | camera scale; may move `z` and change the cut **within the current context** |
| Drill-in | double-click on a node; `Enter` with a node selected | push context: node's detail graph becomes working root |
| Drill-out | `Esc`; breadcrumb click; `Backspace` | pop context (breadcrumb click may pop several) |
| Expand/collapse in place | affordance click; `Space` on selection | ADR-0012 override — same context, mixed-depth cut |
| Fly-to | search result selection | camera flight within context; sets `focus`; never drills |

*(Amended during 6C: search runs over the P1 label-token index through an
injected `LabelTokenIndex` port — §20 forbids `navigation → graph-store`, so
Studio supplies the store's index and navigation owns only the pure search/
ranking; navigation's `tokenize` mirrors graph-store's `tokenizeLabel`
contract and must stay in lockstep. The `[s_min, s_max]` scale range is
likewise a pure hook (`deriveScaleRange`) — deriving it from real layout
world bounds is 6D wiring, and "typical leaf at readable size" is the named
tunable `READABLE_LEAF_PX` for the 6E panel.)*

**Scale↔z coupling.** The controller owns a log-linear map from camera scale
to the zoom scalar: per context, `z = clamp((log s − log s_min) / (log s_max −
log s_min), 0, 1)`, with `[s_min, s_max]` derived from the context's world
bounds and viewport ("fit all" ↔ "typical leaf at readable size"; constants
tunable in 6E). Wheel/pinch drive **scale** (through ADR-0024's anchor); `z`
is derived, then fed to the resolver with `prevLevel` for hysteresis
(ADR-0012). `zoomTo(z, anchor)` inverts the same map. One mapping, two
directions — the scalar is never a second, independently-drifting state.

*(Amended during 6D: the controller's public surface grew the wiring verbs
this record implies but did not name — `panBy`, `setCamera` (camera write-back
from the anchored zoom solve and restores), `drillOutTo(depth)` (breadcrumb
multi-pop), `updateScaleRange(range, preserveZ)`, and `currentSpace()`.
Per-context `[s_min, s_max]` ranges derive from each context's **first**
layout and are memoized per graph; the first drill momentarily uses the root
range, and the z-preserving range update prevents cut flaps when the real
range arrives. The 6C search port is realized as a Map rebuilt with
graph-store's own `tokenizeLabel` on every committed delta — the store does
not export its internal token index.)*

**Saturation — zoom never changes scope.** At `z = 1` (finest level in this
context) further zoom-in is *geometric only*: the camera may continue to
`OVERZOOM_MAX = 4×` past `s_max` (crispness per ADR-0020 MSDF labels), the
cut stops changing, and no drill-in fires — Studio surfaces the affordance
instead (cursor hint / "Enter to open X"). Symmetrically at `z = 0`: zoom-out
saturates at fit-all (with the same geometric slack) and **does not pop the
context**. Scope changes are always explicit, in both directions. This is the
debate the roadmap asks this ADR to end; the symmetric rule is the decision.

*(Amended during 6E: because per-context scale ranges are memoized per graph
(6D amendment above), the tunables that feed range derivation —
`READABLE_LEAF_PX` and `FRAME_MARGIN` — take effect on the next **context**
derivation, not the next transition; all other tunables apply from the next
transition. The tuning panel states this next to those two controls.)*

**Drill-in.** Precondition: the node has a detail graph (`frontier.expandable`
per ADR-0012), hydrating a cold one through `DetailResolver` (ADR-0027) with
a progress affordance. Effect, in order: push `{graphId, z, camera, focus,
overrides}` — the *complete* current abstraction+view state (§5.6) — onto
`NavContext`; the detail graph becomes the working root; the camera frames
the detail graph's bounds (fit + `FRAME_MARGIN = 10%`), which by the coupling
above means entering at `z = 0` of the *detail chain* — coarse first, then
zoom in; `focus` = the drilled node. Drill-in on a node with **no** detail is
a located no-op: the affordance is disabled, `Enter` emits a "no detail"
notice, nothing throws (roadmap §12 failure case). Drill-out pops the stack
and restores the saved state *exactly* — overrides included — so out is a
true inverse of in. The transition for both is ADR-0023 choreography between
the two frames (typically crossfade-classed, since cross-context refinement
has no shared containment); no cursor anchoring (ADR-0024 exempts context
changes).

**Breadcrumbs** are derived, never stored (§5.6): the containment path of the
current working root through the context stack, plus the current `focus`.
The 6C property test (context stack ≡ replay of nav events) holds because the
stack is written only by drill verbs.

**URL codec.** The fragment serializes the complete navigation state:

```
#g=<rootGraphId>&ctx=<nodeId,nodeId,…>&z=<0..1>&cam=<cx,cy,s>&focus=<nodeId>&ov=<id:p|e|c,…>
```

`ctx` is the drill path (node IDs, in order — graph IDs are recoverable from
the nodes' detail refs); `ov` is the ADR-0012 override map, run-length-
compact, values `p`in/`e`xpand/`c`ollapse. *(Amended during 6C: node IDs are
percent-encoded per component — `encodeURIComponent` — with the `&,:=`
delimiters literal, since code-domain IDs contain all four; and signed zero in
`cam` normalizes to `+0` on round-trip, the same coordinate.)* Restoring
parses, replays the
drill path (hydrating as needed), applies overrides, sets camera, and
resolves — "URL round-trip restores the exact view" (roadmap §11) is the
gate, so everything the cut depends on is in the fragment. `prevLevel` /
hysteresis residue is deliberately **not** serialized: a restored view
resolves fresh (ADR-0012's deterministic no-`prevLevel` path). If the
fragment would exceed `URL_MAX = 2000` chars (pathological override maps),
`ov` is truncated with a visible warning — the URL stays shareable, the
warning keeps it honest. Selection and hover are excluded: hover is
transient by ADR-0022; selection is session state, not place.

**Navigation history** (browser-like back/forward over *places*, §5.6) is a
stack of these same serialized states — one representation for URL,
bookmarks, history entries, and (P12) presence.

## Alternatives considered

- **Auto-drill at max zoom** (zoom past `z = 1` enters the node under the
  cursor — Prezi-style). Rejected: the scope change is irreversible-feeling,
  fires on overshoot, picks a node the user may not have meant, and makes
  wheel input change the breadcrumb trail. The named failure mode (§5.4).
- **Auto-pop at min zoom** (zoom-out from `z = 0` exits the context).
  Rejected for symmetry and testability: an accidental two-notch overshoot
  should not silently discard the drill context (and the restored parent
  state) the user built.
- **Zoom scalar as primary state, camera scale derived.** Rejected: the input
  devices produce scale deltas about a point; deriving z keeps one source of
  truth and lets ADR-0024's math own the camera entirely.
- **Drill-in preserves the current zoom level in the new context.** Rejected:
  a mid-chain `z` in an unfamiliar graph shows an arbitrary slice; entering
  coarse-first matches "communicates scope" and gives the choreographer a
  stable establishing frame.
- **Camera/overrides excluded from the URL** (shorter links). Rejected: the
  roadmap's gate is *exact* view restoration; a link that restores "roughly
  where I was" fails it, and P12 presence needs the complete value anyway.
- **Storing breadcrumbs as state.** Rejected by §5.6: derived breadcrumbs are
  always truthful; stored ones can lie.

## Tradeoffs & consequences

- Buys: an exhaustive, testable gesture→verb table (the 6C/6D suites test
  against it literally); zoom that can never surprise the user with a scope
  change; a single serialized navigation value shared by URL, history,
  bookmarks, and P12.
- Costs: users coming from Prezi-like tools must learn the explicit drill
  gesture — mitigated by the saturation affordance hint; the URL carries more
  than `#g&z&focus` (the roadmap's sketch), which is the price of "exact."
- Restoring a deep drill path into a cold graph is a hydration chain —
  restore latency is bounded by ADR-0027's lazy-resolve budget per hop.

## Reasoning

Scale and scope are different questions ("how big" vs "inside what"), and the
constitution says conflating them is how zoomable UIs die (§5.4). Once that
is accepted, every decision falls out: gestures that express magnitude map to
scale, gestures that express intent map to scope, saturation is where the two
must *not* leak into each other, and symmetric explicitness is the only rule
with no surprising branch. The URL codec is §5.6 taken literally: if "where I
am" is a value, the fragment is that value's wire form, and anything the cut
depends on must be inside it.

## Future implications

`NavContext` + the serialized state is exactly what P12 presence broadcasts
and what bookmarks persist; the gesture table is the contract P10 projections
must re-implement in their own media (outline drill = same verbs, different
input). The overzoom slack interacts with ADR-0020 label tiers — 6D should
verify tier selection at `OVERZOOM_MAX`. Constants (`OVERZOOM_MAX`,
`FRAME_MARGIN`, `s_min/s_max` derivation) go to the 6E tuning panel and are
frozen there.

## Open questions for review

1. **Symmetric no-auto-pop.** The one genuinely contestable call. Maps-like
   tools *do* let you zoom out "past" a place; here that would silently drop
   saved context state. Recommended as specified (explicit both ways);
   confirm, or choose auto-pop-at-saturation and we make drill-out
   state-restoring on re-entry instead.
   **Ruling (6A review, 2026-07-12): accepted as specified** — symmetric
   explicitness; zoom never changes scope in either direction.
2. **Enter-at-coarse (`z = 0`) on drill-in.** Confirm, or prefer entering at
   a level chosen by the detail chain's declared default (adapter hint) when
   present.
   **Ruling (6A review, 2026-07-12): accepted as specified** — enter at
   `z = 0`; adapter default-level hints deferred.
3. **URL override truncation at 2000 chars.** Confirm the pragmatic cap +
   warning, or require full fidelity (accepting multi-KB fragments).
   **Ruling (6A review, 2026-07-12): accepted as specified** — cap at
   `URL_MAX = 2000` with the visible warning.
