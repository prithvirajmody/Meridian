/**
 * The `view-projection` capability (ROADMAP Phase 10 §3, §6; ADR-0037). The
 * dormant enum entry becomes authorable in 1.1.0: a plugin may export view
 * projections that render the same semantic cut through capability-scoped
 * media ports.
 *
 * **Structural twin (the `LayoutProvider` pattern).** The engine that consumes
 * this — `@meridian/projections` and the Studio host — is downstream of the
 * dependency law (§20) and cannot be imported here, nor may the projections
 * package import plugin-api. These declarations are therefore structural
 * twins of the internal contracts, pinned by a compile-time assignability
 * test in the Studio suite (`projection-twin.test.ts`): a projection authored
 * against these types is assignable to the internal `ViewProjection`, and the
 * internal `ProjectionHost` satisfies this facade.
 *
 * Everything here crosses the plugin boundary, so it is data-only and
 * structured-clone-safe (ADR-0009): no DOM node, GPU object, store, renderer
 * resource, or internal model type appears. The node-link (WebGL map) medium
 * is deliberately absent from the public facade — plugins author projections
 * over the virtual-list and 2D-canvas media; the map remains a built-in.
 */
import type { AttrBag, NodeId } from '@meridian/graph-core';
import type { TemporalPresentationHints } from './manifest.js';

/** Serializable projection-local state. Twin of `ProjectionViewState`. */
export type ProjectionViewState =
  | null
  | boolean
  | number
  | string
  | readonly ProjectionViewState[]
  | { readonly [key: string]: ProjectionViewState };

/** Canonical identity selection. Twin of the view-model `SelectionState`. */
export interface ProjectionSelection {
  readonly nodes: readonly NodeId[];
  /** Induced-edge identities, keyed `"src→dst→kind"` (ADR-0013). */
  readonly edges: readonly string[];
  readonly anchor?:
    | { readonly kind: 'node'; readonly id: NodeId }
    | { readonly kind: 'edge'; readonly key: string };
}

/** Navigation-owned focus identity. Twin of `FocusState`. */
export interface ProjectionFocus {
  readonly node: NodeId | null;
}

/** Normalized epoch-millisecond interval. Twin of `TemporalExtent`. */
export interface ProjectionTemporalExtent {
  readonly start: number;
  readonly end: number;
}

/** Presentation metadata for the current domain. Twin of `DomainMeta`. */
export interface ProjectionDomainMeta {
  readonly domain: string;
  readonly label: string;
  readonly temporal?: TemporalPresentationHints;
}

/** One visible cut member — the structural slice of the view-model's
 * `ProjectionNode` that plugin projections consume. */
export interface ProjectionModelNode {
  readonly id: NodeId;
  /** Stable semantic forest path; independent of cut filtering. */
  readonly orderPath: readonly number[];
  readonly label: string;
  readonly kind: string;
  readonly attrs: AttrBag;
  readonly parentId: NodeId | null;
  readonly depth: number | null;
  readonly cutReason: string | null;
  readonly coveredLeaves: number;
  readonly temporal: ProjectionTemporalExtent | null;
}

/** One aggregated edge between visible members. Slice of `InducedEdge`. */
export interface ProjectionModelEdge {
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly kind: string;
  readonly weight: number;
  readonly multiplicity: number;
}

/** A located temporal repair. Slice of `ProjectionModelDiagnostic`. */
export interface ProjectionModelIssue {
  readonly code: string;
  readonly nodeId: NodeId;
  readonly attribute: string;
  readonly message: string;
}

/** The semantic cut a projection renders — the structural slice of the
 * view-model's `ProjectionModel`. Data only; no layout or renderer value. */
export interface ProjectionModelView {
  readonly cutLevel: number;
  readonly nodes: readonly ProjectionModelNode[];
  readonly inducedEdges: readonly ProjectionModelEdge[];
  readonly selection: ProjectionSelection;
  readonly focus: ProjectionFocus;
  readonly domainMeta: ProjectionDomainMeta;
  readonly diagnostics: readonly ProjectionModelIssue[];
}

// ------------------------------------------------------------ media ports

/** Twin of the projections package's `VirtualListRow`. */
export interface ProjectionListRow {
  readonly key: string;
  readonly nodeId: NodeId;
  readonly parentId: NodeId | null;
  readonly label: string;
  readonly kind: string;
  readonly depth: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly coveredLeaves: number;
}

/** Twin of `VirtualListFrame`. */
export interface ProjectionListFrame {
  readonly revision: string;
  readonly rows: readonly ProjectionListRow[];
  readonly selection: ProjectionSelection;
  readonly focus: ProjectionFocus;
  readonly activeNodeId: NodeId | null;
  readonly emptyMessage: string | null;
}

export type ProjectionListKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'Enter'
  | ' ';

/** Twin of `VirtualListInput`. */
export type ProjectionListInput =
  | {
      readonly type: 'activate';
      readonly nodeId: NodeId;
      readonly source: 'pointer' | 'keyboard';
    }
  | { readonly type: 'toggle'; readonly nodeId: NodeId }
  | { readonly type: 'key'; readonly key: ProjectionListKey };

/** Twin of `VirtualListSurface`; the concrete DOM stays behind the host. */
export interface ProjectionListSurface {
  render(frame: ProjectionListFrame): void;
  captureViewState(): ProjectionViewState;
  restoreViewState(state: ProjectionViewState): void;
  revealNode(nodeId: NodeId): void;
  destroy(): void;
}

export interface ProjectionListMedium {
  mount(onInput: (input: ProjectionListInput) => void): Promise<ProjectionListSurface>;
}

/** Twin of `Canvas2dRect`. Logical (CSS) pixels. */
export interface ProjectionCanvasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: string;
}

/** Twin of `Canvas2dLine`. */
export interface ProjectionCanvasLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly color: string;
  readonly width: number;
}

/** Twin of `Canvas2dLabel`. */
export interface ProjectionCanvasLabel {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly color: string;
  readonly size: number;
  readonly align: 'left' | 'center' | 'right';
}

/** Twin of `Canvas2dFrame` — a retained, data-only draw list. */
export interface ProjectionCanvasFrame {
  readonly revision: string;
  readonly background: string;
  readonly rects: readonly ProjectionCanvasRect[];
  readonly lines: readonly ProjectionCanvasLine[];
  readonly labels: readonly ProjectionCanvasLabel[];
  readonly message: string | null;
}

export type ProjectionCanvasPointerAction = 'down' | 'move' | 'up' | 'leave';

/** Twin of `Canvas2dInput`. */
export type ProjectionCanvasInput =
  | {
      readonly type: 'pointer';
      readonly action: ProjectionCanvasPointerAction;
      readonly x: number;
      readonly y: number;
      readonly primary: boolean;
    }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly deltaY: number }
  | { readonly type: 'resize'; readonly width: number; readonly height: number };

/** Twin of `Canvas2dSurface`; the canvas element stays behind the host. */
export interface ProjectionCanvasSurface {
  render(frame: ProjectionCanvasFrame): void;
  destroy(): void;
}

export interface ProjectionCanvasMedium {
  mount(onInput: (input: ProjectionCanvasInput) => void): Promise<ProjectionCanvasSurface>;
}

// ------------------------------------------------------------- host facade

export type ProjectionLifecyclePhase =
  | 'mount'
  | 'render'
  | 'selection'
  | 'focus'
  | 'view-state'
  | 'destroy';

/** Twin of `ProjectionDiagnostic`. */
export interface ViewProjectionDiagnostic {
  readonly projectionId: string;
  readonly code: string;
  readonly phase: ProjectionLifecyclePhase;
  readonly message: string;
}

export type ProjectionNavigationIntent =
  | {
      readonly kind: 'focus' | 'expand' | 'collapse' | 'drill-in';
      readonly nodeId: NodeId;
    }
  | { readonly kind: 'drill-out' };

export interface ProjectionViewport {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

/** The capability-scoped host facade a plugin projection receives — the
 * structural slice of the internal `ProjectionHost`. No DOM element, store,
 * renderer object, or node-link (WebGL) medium crosses this boundary. */
export interface ViewProjectionHost {
  readonly virtualList: ProjectionListMedium;
  readonly canvas2d: ProjectionCanvasMedium;
  viewport(): ProjectionViewport;
  now(): number;
  selectNode(nodeId: NodeId, mode: 'replace' | 'toggle'): void;
  /** Replace the edge selection; `anchorKey` must be one of `keys` when set. */
  selectEdges(keys: readonly string[], anchorKey?: string): void;
  focusNode(nodeId: NodeId | null): void;
  navigate(intent: ProjectionNavigationIntent): void;
  reportDiagnostic(diagnostic: ViewProjectionDiagnostic): void;
  showDegraded(message: string): void;
}

/** Twin of `ProjectionInstance` (ADR-0036 lifecycle). */
export interface ViewProjectionInstance {
  render(model: ProjectionModelView): void;
  applySelection(selection: ProjectionSelection): void;
  applyFocus(focus: ProjectionFocus): void;
  revealFocus(): void;
  captureViewState(): ProjectionViewState;
  restoreViewState(state: ProjectionViewState): void;
  /** Idempotent. Every other method is invalid after this call. */
  destroy(): void;
}

/** The authorable projection contract. Twin of `ViewProjection`; `mount` is
 * async and mount failure is contained by the host (map fallback, ADR-0036). */
export interface ViewProjectionExport {
  readonly id: string;
  readonly label: string;
  /** Finite, clamped to 0..1 by the host; orders the mode menu (ADR-0036). */
  suitability(model: ProjectionModelView): number;
  mount(host: ViewProjectionHost): Promise<ViewProjectionInstance>;
}
