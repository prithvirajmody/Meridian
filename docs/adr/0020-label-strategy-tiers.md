# ADR-0020 — Labels: screen-space MSDF `BitmapText`, geometric tiers, and a bounded Unicode fallback

- **Status:** Accepted
- **Date:** 2026-07-11
- **Phase:** 5 (roadmap)
- **Constitution:** ARCHITECTURE.md §1.3 (Presentation), §5.1, §9.1, §9.3, §10.3, §20; ADR-A8
- **Roadmap:** ROADMAP.md Phase 5 §1, §3, §7–§9, §11–§12

## Context

Labels are the Phase-5 performance cliff: the renderer must remain within an
18ms p95 frame budget on a 10k-node cut, but labels must become more informative
as geometric zoom increases. The policy must remain domain-neutral, pure, stable
at exact thresholds, deterministic under ties, and independent of device-pixel
ratio. Meridian's Unicode fixture also contains CJK, Arabic, emoji, combining
marks, and a ZWJ sequence; a small pre-baked atlas alone cannot render that
fixture truthfully.

This record fixes (a) the label metadata in `RenderModel`, (b) the exact tier
function, (c) collision/cap behavior, (d) the Pixi text fast path, and (e) the
strictly bounded shaped-Unicode fallback.

## Decision

**Presentation-neutral label metadata.** `buildRenderModel` emits one normalized
NFC label string per node through `labelRefs` into a deduplicated `labelTable`,
plus a `Uint8Array labelClass`. Classes are derived without domain words:

| Value | Class | Pure derivation |
|---:|---|---|
| `0` | forced | the visible selection anchor (hover promotion happens in the renderer) |
| `1` | summary | `CutMember.coveredLeaves > 1` or the source node has detail |
| `2` | connected | not summary and total induced in+out degree is greater than zero |
| `3` | ordinary | every other visible node |

Other selected visible nodes are promoted to at most `summary`; selecting 10k
nodes must not imply 10k labels. A node's class, label reference, and deterministic
rank are all view-model data—Pixi never reads the graph, cut, or store to decide
importance.

**Pure tier function.** `labelTier(projectedNodeHeightCssPx)` returns the maximum
class eligible for a persistent label:

```text
projected height <  8 CSS px  → forced only       (max class 0)
projected height < 16 CSS px  → + summaries       (max class 1)
projected height < 28 CSS px  → + connected nodes (max class 2)
projected height ≥ 28 CSS px  → all classes       (max class 3)
```

The comparisons are lower-bound inclusive: exactly `8`, `16`, and `28` enters
the next tier. Projected height is `max(0, worldHeight) × camera.scale`; thresholds
are CSS pixels, never backing-store/device pixels, so a DPR change cannot change
which labels exist. A zero-height node has no persistent label unless forced.
The constants are named and tested; 5D/5F may tune their numeric values only by
amending this record and updating the scripted transition tests.

**Screen-space text.** Labels live in a screen-space overlay, positioned by the
pure world→screen transform but drawn at a constant 12 CSS px nominal size. They
do not inherit the world container's camera scale. This keeps text readable,
makes tier thresholds and collision boxes stable, and avoids rebuilding a font
for every zoom. Browser/device scale is handled once by the renderer resolution.

**Candidate order, collision, and cap.** Only quadtree-visible nodes whose class
is at or below their active tier become candidates. Hover and the selection
anchor are inserted first even below the first threshold. Remaining candidates
sort by `(class ascending, coveredLeaves descending, inducedDegree descending,
NodeId ascending)`. A deterministic 8-CSS-px occupancy grid greedily accepts
label AABBs with 2 CSS px padding; forced hover/anchor labels may overlap, normal
labels may not. At most **512** labels are live per scene, including forced
labels. Hover, then the selection anchor, evicts the last normal candidate if the
cap is full. This is a performance safety rail, not a semantic node budget: nodes
remain drawn and pickable when their labels are omitted.

Labels are truncated at 48 grapheme clusters with an ellipsis before measurement;
`Intl.Segmenter` is used when available, with a code-point fallback. The full
label always remains in `RenderModel` and the Studio side panel. `BitmapText`
objects are pooled by style; pan/zoom changes visibility/position but does not
rasterize strings again.

**Fast path: checked-in MSDF atlas.** The normal path is Pixi v8 `BitmapText`
using one locally bundled, license-recorded MSDF font loaded through `Assets`.
No font or glyph is fetched from the network. Its build manifest includes ASCII,
Latin-1, General Punctuation, and the pinned-corpus code points for which the
chosen font has ordinary glyphs; the pure coverage table routes missing glyphs
and shaping-required strings to the fallback below. Font source, generator
version/command, atlas descriptor, and texture are reproducible assets; generated
files change only through the documented font-regen command.

**Shaped-Unicode fallback.** A label requiring shaping or a glyph absent from the
MSDF atlas (Arabic, CJK outside the manifest, emoji/ZWJ, etc.) uses Pixi `Text`,
which delegates shaping/rasterization to the browser canvas. This exception is
classified by a pure `labelRenderKind(text, atlasCoverage)` function and occurs
*after* tiering, culling, collision, and the global cap. At most **64** fallback
`Text` labels may be live; hover and selection anchor have priority, and excess
fallback candidates are omitted with a deduplicated renderer diagnostic. Fallback
objects are pooled and rerasterize only when their string/style changes, never on
camera movement. `HTMLText` is not used.

The fallback is not a license to render all labels through canvas text: architecture
tests restrict `Text` imports to the Unicode fallback module and stats expose
`bitmapLabelCount`, `fallbackLabelCount`, and `omittedLabelCount`. The Unicode
corpus screenshot and interaction test must exercise CJK, right-to-left Arabic,
emoji/ZWJ, and NFC-normalized text through this path.

## Alternatives considered

- **Show every label at every zoom.** Rejected: it creates unreadable overlap and
  makes label work proportional to the whole 10k cut at overview scale.
- **Tier on raw camera scale.** Rejected: world units are arbitrary; projected
  node height in CSS pixels is the invariant that expresses visible room.
- **Use only Pixi `Text`.** Rejected: per-string canvas rasterization and textures
  make the common thousands-of-label case the known performance cliff.
- **Use only a fixed MSDF atlas and render missing glyphs as tofu.** Rejected: it
  makes the existing Unicode corpus factually unreadable and would silently
  corrupt user-visible labels.
- **Generate an unbounded atlas from each file.** Rejected: arbitrary CJK/emoji
  sets can exceed texture limits and delay first render unpredictably.
- **DOM labels.** Rejected for the node-link renderer: DOM reconciliation and
  positioning would cross the React/canvas boundary and complicate screenshot
  determinism. A future DOM projection remains separate.

## Tradeoffs & consequences

- Buys: a pure threshold function with exact tests, deterministic density control,
  constant-size readable text, a fast MSDF common path, and truthful Unicode on
  the pinned hostile fixture.
- Costs: two text paths, a reproducible font-asset toolchain, and a documented
  64-label shaped-text ceiling. Some dense views omit labels even when tier-
  eligible; hover always reveals the target within the same cap.
- Label availability is presentation, never abstraction. The 512 cap cannot feed
  back into the cut, mutate selection, or change picking.

## Reasoning

Projected footprint is the only zoom measure meaningful across arbitrary layout
units, and CSS pixels are the only way to keep behavior identical at DPR 1 and 2.
Domain-neutral summary/degree classes spend the limited label budget on nodes
that explain structure without teaching presentation any domain vocabulary.
MSDF `BitmapText` handles the hot path; the bounded canvas-text escape hatch is
required because font atlases and complex-script shaping are different problems,
and the repository already contains an acceptance fixture that proves it.

## Future implications

P6 semantic zoom changes which nodes enter the `RenderModel`, but the geometric
label tier remains unchanged. P10 projections may supply their own label classes
while reusing this tier/collision engine. Full unbounded internationalized label
rendering would require a shaped glyph-atlas service and can replace the bounded
fallback behind `labelRenderKind` without changing the scene seam.

## Open questions for review

1. **Fallback ceiling.** Accept 64 simultaneously live shaped-Unicode `Text`
   labels as the v1 safety rail, or require a lower/higher measured cap in 5D.
   Regardless of the number, the existing Unicode fixture remains a required
   no-tofu screenshot and interaction case.
   **Ruling (5A review, 2026-07-11): accepted as recommended** — the v1 ceiling
   is 64; 5D measures it but does not silently retune it.
