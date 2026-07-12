import type { PickResult, RendererFault, RendererStats } from '@meridian/renderer';
import { NAV_TUNABLE_DEFAULTS, type NavTunables } from '@meridian/navigation';
import {
  createCameraState,
  EMPTY_SELECTION,
  type AttrBag,
  type CameraState,
  type RenderDiagnostic,
  type RenderModel,
  type SelectionState,
  type SourceRef,
} from '@meridian/view-model';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { sanitizeTunable } from './tunable-specs.js';

export type StudioPhase =
  | 'idle'
  | 'reading'
  | 'ingesting'
  | 'resolving'
  | 'layout'
  | 'ready'
  | 'error';

export interface OpenSourceState {
  readonly generation: number;
  readonly name: string;
  readonly bytes: number;
}

export interface AdapterState {
  readonly domain: string;
  readonly plugin: string;
  readonly score: number;
}

export interface StudioDiagnostic {
  readonly source: 'pipeline' | 'view-model' | 'renderer';
  readonly code: string;
  readonly message: string;
  readonly elementId?: string;
}

export type SelectedElementPanel =
  | {
      readonly kind: 'node';
      readonly id: string;
      readonly label: string;
      readonly semanticKind: string;
      readonly attrs: AttrBag;
      readonly provenance: SourceRef;
    }
  | {
      readonly kind: 'edge';
      readonly id: string;
      readonly label: string;
      readonly semanticKind: string;
      readonly attrs: AttrBag;
      readonly provenance: SourceRef;
    };

export interface StudioHover {
  readonly sceneGeneration: number;
  readonly element: PickResult;
  readonly receivedAtMs: number;
}

/** One breadcrumb as shown in the bar (derived upstream, ADR-0025). */
export interface StudioBreadcrumb {
  readonly graphId: string;
  readonly node: string | null;
  readonly label: string | null;
}

/**
 * The navigation slice (6D): serializable values only, derived from the
 * `NavigationController` after every verb/settle. The navigator instance
 * itself lives in `StudioSession` (ADR-0022 — no service in Zustand).
 */
export interface StudioNavState {
  readonly depth: number;
  readonly zoom: number;
  readonly level: number;
  readonly breadcrumbs: readonly StudioBreadcrumb[];
  readonly focus: string | null;
  readonly cutSize: number;
  readonly notice: { readonly code: string; readonly message: string } | null;
  readonly urlFragment: string;
  readonly transition: {
    readonly active: boolean;
    readonly count: number;
    readonly lastMode: 'choreographed' | 'crossfade' | 'camera-only' | null;
  };
  /** ADR-0025 saturation affordance: `z = 1`, further zoom is geometric only. */
  readonly saturated: boolean;
}

export interface StudioMetrics {
  readonly layoutReadyAtMs: number | null;
  readonly firstRenderMs: number | null;
  readonly interactionLatencyMs: number | null;
  readonly heapBytes: number | null;
}

/**
 * Serializable application/session values only (ADR-0022). No SceneAdapter,
 * store engine, plugin host, Worker, DOM node, WebGL object, or Pixi value is
 * permitted in this shape; those services live in StudioRuntime/StudioSession.
 */
export interface StudioState {
  readonly phase: StudioPhase;
  readonly message: string;
  readonly source: OpenSourceState | null;
  readonly adapter: AdapterState | null;
  readonly graphVersion: string | null;
  readonly renderModel: RenderModel | null;
  readonly camera: CameraState;
  readonly selection: SelectionState;
  readonly selectionStartedAtMs: number | null;
  readonly panel: SelectedElementPanel | null;
  readonly hover: StudioHover | null;
  readonly diagnostics: readonly StudioDiagnostic[];
  readonly rendererStats: RendererStats | null;
  readonly metrics: StudioMetrics;
  readonly debugEnabled: boolean;
  /**
   * The 6E session copy of the tunable navigation constants. Initialized from
   * (and reset to) the canonical frozen `NAV_TUNABLE_DEFAULTS` — the shipped
   * ADR values. The debug panel edits this copy; the navigator reads it at
   * each verb/plan, so an edit takes effect on the next transition without
   * reload and nothing ever mutates the defaults module.
   */
  readonly tunables: NavTunables;
  readonly nav: StudioNavState | null;
  /** Canvas viewport in CSS px (published by the bridge; minimap consumes). */
  readonly viewport: { readonly width: number; readonly height: number } | null;
}

export type StudioStore = StoreApi<StudioState>;

const EMPTY_METRICS: StudioMetrics = {
  layoutReadyAtMs: null,
  firstRenderMs: null,
  interactionLatencyMs: null,
  heapBytes: null,
};

export function initialStudioState(debugEnabled = false): StudioState {
  return {
    phase: 'idle',
    message: 'Open a corpus file to begin.',
    source: null,
    adapter: null,
    graphVersion: null,
    renderModel: null,
    camera: createCameraState(),
    selection: EMPTY_SELECTION,
    selectionStartedAtMs: null,
    panel: null,
    hover: null,
    diagnostics: [],
    rendererStats: null,
    metrics: EMPTY_METRICS,
    debugEnabled,
    tunables: NAV_TUNABLE_DEFAULTS,
    nav: null,
    viewport: null,
  };
}

export function createStudioStore(debugEnabled = false): StudioStore {
  return createStore<StudioState>(() => initialStudioState(debugEnabled));
}

function diagnosticFromRender(item: RenderDiagnostic): StudioDiagnostic {
  return {
    source: 'view-model',
    code: item.code,
    message: `${item.field} repaired from ${item.received}`,
    elementId: item.id,
  };
}

function diagnosticsFromFault(fault: RendererFault): StudioDiagnostic {
  return { source: 'renderer', code: fault.code, message: fault.message };
}

function boundedDiagnostics(
  current: readonly StudioDiagnostic[],
  additions: readonly StudioDiagnostic[],
): readonly StudioDiagnostic[] {
  return [...current, ...additions].slice(-100);
}

/** Imperative commands kept outside the Zustand value shape (ADR-0022). */
export class StudioStoreCommands {
  constructor(readonly store: StudioStore) {}

  beginOpen(source: OpenSourceState): void {
    this.store.setState({
      phase: 'reading',
      message: `Reading ${source.name}…`,
      source,
      adapter: null,
      graphVersion: null,
      renderModel: null,
      camera: createCameraState(),
      selection: EMPTY_SELECTION,
      selectionStartedAtMs: null,
      panel: null,
      hover: null,
      diagnostics: [],
      rendererStats: null,
      metrics: EMPTY_METRICS,
      nav: null,
    });
  }

  stage(phase: Exclude<StudioPhase, 'idle' | 'ready' | 'error'>, message: string): void {
    this.store.setState({ phase, message });
  }

  adapterResolved(adapter: AdapterState): void {
    this.store.setState({ adapter });
  }

  publishModel(
    model: RenderModel,
    graphVersion: string,
    layoutReadyAtMs: number,
    message: string,
  ): void {
    const current = this.store.getState();
    const modelChanged = current.renderModel?.revision !== model.revision;
    const viewDiagnostics = model.diagnostics.map(diagnosticFromRender);
    this.store.setState({
      phase: 'ready',
      message,
      graphVersion,
      renderModel: model,
      ...(modelChanged ? { hover: null } : {}),
      diagnostics: boundedDiagnostics(
        current.diagnostics.filter((item) => item.source !== 'view-model'),
        viewDiagnostics,
      ),
      metrics: {
        ...current.metrics,
        layoutReadyAtMs,
        firstRenderMs: null,
      },
    });
  }

  replaceModelAfterSelection(model: RenderModel): void {
    const current = this.store.getState();
    this.store.setState({
      renderModel: model,
      hover: null,
      diagnostics: boundedDiagnostics(
        current.diagnostics.filter((item) => item.source !== 'view-model'),
        model.diagnostics.map(diagnosticFromRender),
      ),
    });
  }

  fail(generation: number, code: string, message: string): void {
    if (this.store.getState().source?.generation !== generation) return;
    const diagnostic: StudioDiagnostic = { source: 'pipeline', code, message };
    const current = this.store.getState();
    this.store.setState({
      phase: 'error',
      message,
      renderModel: null,
      hover: null,
      diagnostics: boundedDiagnostics(current.diagnostics, [diagnostic]),
    });
  }

  setNav(nav: StudioNavState | null): void {
    this.store.setState({ nav });
  }

  /**
   * Edit one 6E tunable in the session copy (the debug panel's write path).
   * Values are sanitized against the panel spec window (`tunable-specs.ts`);
   * a non-finite value is ignored. The change is visible to the navigator on
   * its next read — i.e. the next transition — without reload.
   */
  setTunable(key: keyof NavTunables, value: number): void {
    const sane = sanitizeTunable(key, value);
    if (sane === undefined) return;
    const current = this.store.getState().tunables;
    if (current[key] === sane) return;
    this.store.setState({ tunables: { ...current, [key]: sane } });
  }

  /** Reset the session copy to the canonical frozen ADR defaults (6E "reset
   * to defaults" affordance). */
  resetTunables(): void {
    this.store.setState({ tunables: NAV_TUNABLE_DEFAULTS });
  }

  setViewport(viewport: { width: number; height: number } | null): void {
    this.store.setState({ viewport });
  }

  setCamera(camera: CameraState): void {
    this.store.setState({
      camera: {
        center: { x: camera.center.x, y: camera.center.y },
        scale: camera.scale,
      },
    });
  }

  select(result: PickResult | null, startedAtMs: number): void {
    const selection: SelectionState =
      result === null
        ? EMPTY_SELECTION
        : result.kind === 'node'
          ? { nodes: [result.nodeId], edges: [], anchor: { kind: 'node', id: result.nodeId } }
          : { nodes: [], edges: [result.edgeKey], anchor: { kind: 'edge', key: result.edgeKey } };
    this.store.setState({
      selection,
      selectionStartedAtMs: result === null ? null : startedAtMs,
      ...(result === null ? { panel: null } : {}),
    });
  }

  setPanel(panel: SelectedElementPanel | null): void {
    this.store.setState({ panel });
  }

  setHover(sceneGeneration: number, element: PickResult | null, receivedAtMs: number): void {
    this.store.setState({
      hover:
        element === null
          ? null
          : { sceneGeneration, element, receivedAtMs },
    });
  }

  clearHover(sceneGeneration?: number): void {
    const current = this.store.getState().hover;
    if (current === null) return;
    if (sceneGeneration !== undefined && current.sceneGeneration !== sceneGeneration) return;
    this.store.setState({ hover: null });
  }

  rendererFault(fault: RendererFault): void {
    const current = this.store.getState();
    this.store.setState({
      diagnostics: boundedDiagnostics(current.diagnostics, [diagnosticsFromFault(fault)]),
    });
  }

  rendererFrame(stats: RendererStats, observedAtMs: number): void {
    const current = this.store.getState();
    const ready = current.metrics.layoutReadyAtMs;
    const firstRenderMs =
      ready !== null && current.metrics.firstRenderMs === null
        ? Math.max(0, observedAtMs - ready)
        : current.metrics.firstRenderMs;
    this.store.setState({
      rendererStats: stats,
      metrics: { ...current.metrics, firstRenderMs },
    });
  }

  recordInteractionCommitted(startedAtMs: number, committedAtMs: number): void {
    const current = this.store.getState();
    if (current.selectionStartedAtMs !== startedAtMs) return;
    this.store.setState({
      metrics: {
        ...current.metrics,
        interactionLatencyMs: Math.max(0, committedAtMs - startedAtMs),
      },
    });
  }

  sampleHeap(bytes: number | null): void {
    const current = this.store.getState();
    this.store.setState({ metrics: { ...current.metrics, heapBytes: bytes } });
  }
}
