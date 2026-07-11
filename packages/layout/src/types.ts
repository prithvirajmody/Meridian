/**
 * The Layout I/O contract (ROADMAP Phase 4 §5; ADR-0015/0016/0017). A
 * `LayoutProvider` is a pure-ish function `(cut, inducedEdges, sizes, hints) →
 * positions` — it turns the abstraction engine's visible antichain into
 * world-space geometry, testable via SVG snapshots with no GPU (§11).
 *
 * Dependency law (ADR-0015 ruling, binding): this module imports **only**
 * `Cut`/`InducedEdge` from `@meridian/abstraction`, `NodeId` from
 * `@meridian/graph-core`, and the geometry types from the sibling type module
 * `./coords.ts`. It contains **zero imports of layout logic** (providers,
 * exporter, scorer) so that, together with `coords.ts`, it lifts into
 * `@meridian/view-model` unchanged at subphase 5B, at which point layout's
 * dependency is repointed from `abstraction` to `view-model`. No DOM, no
 * domain words, no AI — this is a core-law package.
 */
import type { Cut, InducedEdge } from '@meridian/abstraction';
import type { NodeId } from '@meridian/graph-core';
import type { Point, Rect, Size } from './coords.js';

/** Preferred flow direction for hierarchical/layered providers. World space is
 * y-down, so `'down'` grows a tree toward increasing y. `'right'` is the
 * transpose. Providers that ignore direction (grid) may disregard it. */
export type LayoutDirection = 'down' | 'right';

/** Presentation-neutral tuning shared by all providers (ROADMAP §7). All
 * fields optional; providers apply defensible defaults. `seed` fixes force
 * determinism (ADR-0018/§9b) and is inert for the deterministic providers. */
export interface LayoutHints {
  /** Flow direction for layered/tree layouts. Default `'down'`. */
  readonly direction?: LayoutDirection;
  /** World-unit gap between adjacent boxes and between packed components
   * (ADR-0015 component packing; ADR-0016 `Λ` fallback). */
  readonly spacing?: number;
  /** PRNG seed for stochastic providers (force). Ignored by grid/tree. */
  readonly seed?: number;
}

/** A provider's self-description (ROADMAP §5). `deterministic` providers are
 * pure functions of their input (I6); `incremental` ones honor `prev` for
 * stability (ADR-0016); `compound` ones lay out nested graphs. */
export interface LayoutCapabilities {
  readonly incremental: boolean;
  readonly compound: boolean;
  readonly deterministic: boolean;
}

/** Everything a provider needs to place a cut (ROADMAP §5). `sizes` supplies
 * one `Size` per visible member — **providers place the box; they never invent
 * sizes** (ADR-0015). `edges` is the induced (aggregated) edge set over the
 * cut (ADR-0013). */
export interface LayoutInput {
  readonly cut: Cut;
  readonly edges: readonly InducedEdge[];
  readonly sizes: ReadonlyMap<NodeId, Size>;
  readonly hints: LayoutHints;
}

/** A provider's output (ROADMAP §5; ADR-0015). `positions` places exactly the
 * cut's members as world-space `Rect`s; `bounds` is the tight AABB enclosing
 * every position and every `edgeRoutes` point; `stability` is the pure
 * ADR-0016 score. `edgeRoutes` (keyed by the induced edge's `"src→dst→kind"`
 * identity, ADR-0013) is absent/empty when edges are straight center-to-center
 * lines (v1; §9c). */
export interface LayoutResult {
  readonly positions: ReadonlyMap<NodeId, Rect>;
  readonly edgeRoutes?: ReadonlyMap<string, readonly Point[]>;
  readonly bounds: Rect;
  readonly stability: number;
}

/** A pluggable layout engine (ROADMAP §5). `compute` is `async` because real
 * engines (elk/force, 4D/4E) run in a worker; the 4B deterministic providers
 * resolve synchronously. `signal` exists in the contract but 4B providers
 * ignore it (no cancellation infrastructure until 4C). */
export interface LayoutProvider {
  readonly id: string;
  readonly capabilities: LayoutCapabilities;
  compute(input: LayoutInput, prev?: LayoutResult, signal?: AbortSignal): Promise<LayoutResult>;
}
