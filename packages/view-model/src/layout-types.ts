/**
 * The shared Layout I/O contract (ADR-0015/0016/0017), moved from
 * `@meridian/layout` into the presentation waist by ADR-0022. Layout consumes
 * these types; view-model consumes its result; neither package depends on the
 * other for behavior.
 */
import type { Cut, InducedEdge } from '@meridian/abstraction';
import type { NodeId } from '@meridian/graph-core';
import type { Point, Rect, Size } from './coords.js';

export type LayoutDirection = 'down' | 'right';

export interface LayoutHints {
  readonly direction?: LayoutDirection;
  readonly spacing?: number;
  readonly seed?: number;
}

export interface LayoutCapabilities {
  readonly incremental: boolean;
  readonly compound: boolean;
  readonly deterministic: boolean;
}

/** Graph-container nesting used by compound-aware providers. */
export interface CompoundNesting {
  readonly groupOf: ReadonlyMap<NodeId, string>;
  readonly parentOf: ReadonlyMap<string, string>;
}

export interface LayoutInput {
  readonly cut: Cut;
  readonly edges: readonly InducedEdge[];
  readonly sizes: ReadonlyMap<NodeId, Size>;
  readonly hints: LayoutHints;
  readonly compound?: CompoundNesting;
}

export interface LayoutResult {
  readonly positions: ReadonlyMap<NodeId, Rect>;
  readonly edgeRoutes?: ReadonlyMap<string, readonly Point[]>;
  readonly bounds: Rect;
  readonly stability: number;
}

export interface LayoutProvider {
  readonly id: string;
  readonly capabilities: LayoutCapabilities;
  compute(input: LayoutInput, prev?: LayoutResult, signal?: AbortSignal): Promise<LayoutResult>;
}
