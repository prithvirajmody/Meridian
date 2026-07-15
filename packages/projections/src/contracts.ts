import type {
  FocusState,
  NodeId,
  ProjectionModel,
  RenderModel,
  SelectionState,
  ViewportSize,
} from '@meridian/view-model';

/** Serializable projection-local state. Resource handles never cross the host. */
export type ProjectionViewState =
  | null
  | boolean
  | number
  | string
  | readonly ProjectionViewState[]
  | { readonly [key: string]: ProjectionViewState };

export type ProjectionLifecyclePhase =
  | 'mount'
  | 'render'
  | 'selection'
  | 'focus'
  | 'view-state'
  | 'destroy';

export interface ProjectionDiagnostic {
  readonly projectionId: string;
  readonly code: string;
  readonly phase: ProjectionLifecyclePhase;
  readonly message: string;
}

/**
 * Consumer-owned node-link resource. Camera and concrete renderer state stay
 * behind this port; only the established renderer value crosses it.
 */
export interface NodeLinkSurface {
  render(model: RenderModel): void;
  captureViewState(): ProjectionViewState;
  restoreViewState(state: ProjectionViewState): void;
  revealNode(nodeId: NodeId | null): void;
  destroy(): void;
}

export interface NodeLinkMedium {
  mount(): Promise<NodeLinkSurface>;
}

export interface VirtualListRow {
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

export interface VirtualListFrame {
  readonly revision: string;
  readonly rows: readonly VirtualListRow[];
  readonly selection: SelectionState;
  readonly focus: FocusState;
  readonly activeNodeId: NodeId | null;
  readonly emptyMessage: string | null;
}

export type VirtualListKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'Enter'
  | ' ';

export type VirtualListInput =
  | {
      readonly type: 'activate';
      readonly nodeId: NodeId;
      readonly source: 'pointer' | 'keyboard';
    }
  | { readonly type: 'toggle'; readonly nodeId: NodeId }
  | { readonly type: 'key'; readonly key: VirtualListKey };

export interface VirtualListSurface {
  render(frame: VirtualListFrame): void;
  captureViewState(): ProjectionViewState;
  restoreViewState(state: ProjectionViewState): void;
  revealNode(nodeId: NodeId): void;
  destroy(): void;
}

export interface VirtualListMedium {
  mount(onInput: (input: VirtualListInput) => void): Promise<VirtualListSurface>;
}

/** One filled rectangle in a retained 2D-canvas frame. Logical (CSS) pixels. */
export interface Canvas2dRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: string;
}

export interface Canvas2dLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly color: string;
  readonly width: number;
}

export interface Canvas2dLabel {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly color: string;
  readonly size: number;
  readonly align: 'left' | 'center' | 'right';
}

/**
 * Data-only retained draw list. The concrete canvas element, context, and
 * rasterization cadence live behind the medium, never in a projection.
 */
export interface Canvas2dFrame {
  readonly revision: string;
  readonly background: string;
  readonly rects: readonly Canvas2dRect[];
  readonly lines: readonly Canvas2dLine[];
  readonly labels: readonly Canvas2dLabel[];
  readonly message: string | null;
}

export type Canvas2dPointerAction = 'down' | 'move' | 'up' | 'leave';

/** Plain input data emitted by the medium; coordinates are logical pixels. */
export type Canvas2dInput =
  | {
      readonly type: 'pointer';
      readonly action: Canvas2dPointerAction;
      readonly x: number;
      readonly y: number;
      readonly primary: boolean;
    }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly deltaY: number }
  | { readonly type: 'resize'; readonly width: number; readonly height: number };

export interface Canvas2dSurface {
  render(frame: Canvas2dFrame): void;
  destroy(): void;
}

export interface Canvas2dMedium {
  mount(onInput: (input: Canvas2dInput) => void): Promise<Canvas2dSurface>;
}

export type ProjectionNavigationIntent =
  | {
      readonly kind: 'focus' | 'expand' | 'collapse' | 'drill-in';
      readonly nodeId: NodeId;
    }
  | { readonly kind: 'drill-out' };

export interface ProjectionViewport extends ViewportSize {
  readonly devicePixelRatio: number;
}

/** Capability-scoped composition port; contains no DOM/renderer/store handle. */
export interface ProjectionHost {
  readonly nodeLink: NodeLinkMedium;
  readonly virtualList: VirtualListMedium;
  readonly canvas2d: Canvas2dMedium;
  viewport(): ProjectionViewport;
  now(): number;
  selectNode(nodeId: NodeId, mode: 'replace' | 'toggle'): void;
  /** Replace the edge selection; `anchorKey` must be one of `keys` when set. */
  selectEdges(keys: readonly string[], anchorKey?: string): void;
  focusNode(nodeId: NodeId | null): void;
  navigate(intent: ProjectionNavigationIntent): void;
  reportDiagnostic(diagnostic: ProjectionDiagnostic): void;
  showDegraded(message: string): void;
}

export interface ProjectionInstance {
  render(model: ProjectionModel): void;
  applySelection(selection: SelectionState): void;
  applyFocus(focus: FocusState): void;
  revealFocus(): void;
  captureViewState(): ProjectionViewState;
  restoreViewState(state: ProjectionViewState): void;
  /** Idempotent. Every other method is invalid after this call. */
  destroy(): void;
}

export interface ViewProjection {
  readonly id: string;
  readonly label: string;
  suitability(model: ProjectionModel): number;
  mount(host: ProjectionHost): Promise<ProjectionInstance>;
}
