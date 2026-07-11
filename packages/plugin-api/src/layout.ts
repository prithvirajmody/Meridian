/**
 * The `layout-provider` capability (ARCHITECTURE.md §5.1; roadmap Phase 4 §5,
 * §6). A provider turns a cut + its induced edges into world-space positions
 * (ADR-0015). The enum entry `layout-provider` already exists (ADR-0011);
 * Phase 4B lands the *contract shape* here — types only, no host wiring.
 *
 * **Structural twin (the same pattern as `LevelChainSpec` and
 * `AbstractionProvider`).** The engine that *implements* this — `@meridian/
 * layout` — is downstream of the dependency law (§20) and cannot be imported
 * here; and by ADR-0015 layout may not import plugin-api either. So the real
 * `LayoutProvider` contract and these declarations are **structural twins**,
 * bridged by the host. The twin is pinned by a compile-time assignability test
 * in `@meridian/layout`'s test suite (`layout-twin.test.ts`), which asserts the
 * real `gridProvider`/`treeProvider` are assignable to this `LayoutProvider`,
 * so the two shapes cannot silently drift.
 *
 * Everything here crosses the plugin boundary, so it is structured-clone-safe
 * (ADR-0009): plain records and `ReadonlyMap`s of finite numbers (ADR-0017
 * encodes them as transferable typed arrays over the worker boundary). Ids are
 * the core `NodeId` brand — the one graph-core type this contract already
 * re-exports (§6.1).
 */
import type { NodeId } from '@meridian/graph-core';

/** World-space point (y-down, float64; ADR-0015). Twin of `layout`'s `Point`. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** World-space extent, both dimensions `≥ 0` (ADR-0015). Twin of `Size`. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** World-space box by min-corner + extent (ADR-0015). Twin of `Rect`. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Presentation-neutral layout tuning (ROADMAP §7). Twin of `LayoutHints`. */
export interface LayoutHints {
  readonly direction?: 'down' | 'right';
  readonly spacing?: number;
  readonly seed?: number;
}

/** Provider self-description (ROADMAP §5). Twin of `LayoutCapabilities`. */
export interface LayoutCapabilities {
  readonly incremental: boolean;
  readonly compound: boolean;
  readonly deterministic: boolean;
}

/** The cut's visible member set — the structural slice of `abstraction`'s
 * `Cut` that layout consumes (its members are placed). The host passes the
 * real `Cut`, which structurally satisfies this. */
export interface LayoutCut {
  readonly members: readonly NodeId[];
}

/** One aggregated edge between two visible members — the structural slice of
 * `abstraction`'s `InducedEdge` layout consumes (endpoints + kind). */
export interface LayoutInducedEdge {
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly kind: string;
}

/** A provider's input (ROADMAP §5). Twin of `LayoutInput`. */
export interface LayoutInput {
  readonly cut: LayoutCut;
  readonly edges: readonly LayoutInducedEdge[];
  readonly sizes: ReadonlyMap<NodeId, Size>;
  readonly hints: LayoutHints;
}

/** A provider's output (ROADMAP §5; ADR-0015/0016). Twin of `LayoutResult`.
 * `edgeRoutes` is keyed by the induced edge's `"src→dst→kind"` identity
 * (ADR-0013); absent/empty ⇒ straight center-to-center lines. */
export interface LayoutResult {
  readonly positions: ReadonlyMap<NodeId, Rect>;
  readonly edgeRoutes?: ReadonlyMap<string, readonly Point[]>;
  readonly bounds: Rect;
  readonly stability: number;
}

/** The pluggable layout engine contract (ROADMAP §5). Twin of `LayoutProvider`.
 * `compute` is async because real engines run in a worker (ADR-0017);
 * `signal` carries cancellation (4C). */
export interface LayoutProvider {
  readonly id: string;
  readonly capabilities: LayoutCapabilities;
  compute(input: LayoutInput, prev?: LayoutResult, signal?: AbortSignal): Promise<LayoutResult>;
}
