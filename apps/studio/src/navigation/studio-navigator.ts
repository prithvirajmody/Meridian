/**
 * The Studio choreography driver (subphase 6D): wires the 6C
 * `NavigationController` and the 6B `TransitionChoreographer` into the
 * renderer bridge. This plain `.ts` module is imperative shell only — every
 * decision it makes is delegated to pure code (`@meridian/navigation` planners
 * and `transition/animator.ts` sampling); it owns sequencing, the injected
 * clock, and telemetry.
 *
 * Contract highlights:
 * - **Retarget, never queue** (ADR-0023): a verb arriving mid-flight snapshots
 *   the interpolated state and replans from it; at most one flight exists.
 * - **Anchor held throughout** (ADR-0024): the camera path re-solves the
 *   closed-form center every sample; measured drift lands in telemetry and is
 *   gated <8px in Playwright.
 * - **Store mutation mid-transition** (P1 subscription): `spaceMutated`
 *   rebuilds the controller against the new snapshot, restores the serialized
 *   navigation state, and replans from the current interpolated frame.
 * - **Time is injected**: with a manual clock the driver never self-schedules;
 *   Playwright advances the clock deterministically for mid-transition
 *   baselines.
 */
import {
  buildForestIndex,
  buildLevelChain,
  resolveLod,
  type LodResult,
  type ZoomPolicy,
} from '@meridian/abstraction';
import { tokenizeLabel } from '@meridian/graph-store';
import {
  deriveRefinementMap,
  deriveScaleRange,
  MAX_TRANSITION_MS,
  NavigationController,
  planTransition,
  solveAnchoredCamera,
  type LabelTokenIndex,
  type NavContext,
  type NavTunables,
  type ScaleRange,
  type TransitionPlan,
} from '@meridian/navigation';
import {
  buildProjectionModel,
  buildRenderModel,
  characteristicLength,
  createFocusState,
  screenToWorld,
  type CameraState,
  type Cut,
  type GraphSpace,
  type LayoutResult,
  type NodeId,
  type Point,
  type ProjectionModel,
  type Rect,
  type RenderModel,
  type SelectionState,
  type TemporalDomainHints,
  type ViewportSize,
} from '@meridian/view-model';
import { layoutForLod, type StudioLayoutService } from '../pipeline/layout-cut.js';
import {
  anchorDriftPx,
  easeInOutCubic,
  GUARD_FINISH_FADE_MS,
  GUARD_INITIAL,
  guardStep,
  prepareTransition,
  sampleCameraPath,
  sampleTransitionModel,
  snapshotFlightLayout,
  type CameraPath,
  type GuardState,
  type PreparedTransition,
} from '../transition/animator.js';
import type { StudioClock } from '../transition/clock.js';
import { StudioStoreCommands, type StudioNavState, type StudioStore } from '../store.js';

// ----------------------------------------------------------------- telemetry

export type TransitionTrigger =
  | 'zoom'
  | 'override'
  | 'drill'
  | 'fly-to'
  | 'mutation'
  | 'restore';

/** One transition's measured record — the e2e gates read these. */
export interface TransitionRecord {
  readonly seq: number;
  readonly trigger: TransitionTrigger;
  mode: 'choreographed' | 'crossfade' | 'camera-only';
  planMs: number;
  layoutMs: number;
  durationMs: number;
  /** performance.now() at the gesture; plan-to-settle is measured real time. */
  gestureAtMs: number;
  settledAtMs: number | null;
  gestureToSettleMs: number | null;
  maxDriftPx: number;
  anchored: boolean;
  /** True when this transition replanned from a mid-flight snapshot. */
  replannedFromFlight: boolean;
  /** True when a later verb superseded this flight before it settled. */
  superseded: boolean;
  guardTripped: boolean;
  degradeTriggers: readonly string[];
  /** Renderer draw times observed while this flight was active. */
  drawTimesMs: number[];
}

// ------------------------------------------------------------------- wiring

/** What the driver needs from the canvas side (the ADR-0022 bridge). */
export interface NavigatorRenderer {
  render(model: RenderModel, camera: CameraState): void;
}

export interface StudioNavigatorOptions {
  readonly space: GraphSpace;
  readonly policy: ZoomPolicy;
  readonly viewport: ViewportSize;
  readonly initialZoom: number;
  readonly layoutService: StudioLayoutService;
  readonly store: StudioStore;
  readonly clock: StudioClock;
  readonly requestFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
  /** Called with the `#`-fragment when the linkable view state changes. */
  readonly onUrl?: (fragment: string) => void;
  /** Domain-declared temporal hints for the projection waist (ADR-0037). */
  readonly temporal?: TemporalDomainHints;
}

interface Settled {
  lod: LodResult;
  layout: LayoutResult;
  model: RenderModel;
}

interface Flight {
  readonly seq: number;
  prepared: PreparedTransition | null; // null ⇒ camera-only flight
  cameraPath: CameraPath;
  startedAtClock: number;
  durationMs: number;
  readonly target: Settled & { camera: CameraState };
  readonly record: TransitionRecord;
  guard: GuardState;
  phase: 'flying' | 'finish-fade';
  lastEase: number;
  lastT: number;
}

interface FromState {
  readonly members: readonly NodeId[];
  readonly positions: ReadonlyMap<NodeId, Rect>;
  readonly model: RenderModel;
  readonly camera: CameraState;
  readonly layoutForPrev: LayoutResult;
  readonly replanned: boolean;
}

function membersKey(members: readonly NodeId[]): string {
  return members.join('\u0000');
}

function boundsOfPositions(positions: ReadonlyMap<NodeId, Rect>): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of positions.values()) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * ADR-0023: "the choreographer accepts any `{cut, layout}`-shaped from-state"
 * — retarget snapshots are not covering antichains, so only `.members` is
 * meaningful (and it is the only field the pure planners consult).
 */
function asCut(members: readonly NodeId[]): Cut {
  return {
    level: -1,
    members,
    trace: new Map(),
    coverage: { leaves: 0, coveredLeaves: 0, covers: false },
  } as unknown as Cut;
}

function syntheticLayout(positions: ReadonlyMap<NodeId, Rect>): LayoutResult {
  return { positions, bounds: boundsOfPositions(positions), stability: 1 };
}

/** The P1 label-token index port (6C search seam), built with the store's own
 * `tokenizeLabel` so the two tokenizers cannot drift apart. */
export function storeLabelTokenIndex(space: GraphSpace): LabelTokenIndex {
  const nodesByToken = new Map<string, Set<NodeId>>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) {
      for (const token of new Set(tokenizeLabel(node.label))) {
        let set = nodesByToken.get(token);
        if (set === undefined) nodesByToken.set(token, (set = new Set()));
        set.add(node.id);
      }
    }
  }
  return { nodesByToken };
}

export interface SearchResult {
  readonly node: NodeId;
  readonly score: number;
  readonly label: string;
}

const LAYOUT_CACHE_LIMIT = 8;

export class StudioNavigator {
  private readonly policy: ZoomPolicy;
  private readonly viewport: ViewportSize;
  private readonly layoutService: StudioLayoutService;
  private readonly zStore: StudioStore;
  private readonly commands: StudioStoreCommands;
  private readonly clock: StudioClock;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly onUrl: ((fragment: string) => void) | undefined;
  private readonly rangeByGraph = new Map<string, ScaleRange>();
  private readonly layoutCache = new Map<string, LayoutResult>();
  private readonly records: TransitionRecord[] = [];

  private rootSpace: GraphSpace;
  private controller!: NavigationController;
  private labels = new Map<NodeId, string>();
  private parentOf = new Map<NodeId, NodeId>();
  private current!: Settled;
  private flight: Flight | null = null;
  private renderer: NavigatorRenderer | null = null;
  private frameHandle: number | null = null;
  private statsUnsub: (() => void) | null = null;
  private seq = 0;
  private booted = false;
  private destroyed = false;

  constructor(private readonly options: StudioNavigatorOptions) {
    this.policy = options.policy;
    this.viewport = options.viewport;
    this.layoutService = options.layoutService;
    this.zStore = options.store;
    this.commands = new StudioStoreCommands(options.store);
    this.clock = options.clock;
    this.requestFrame =
      options.requestFrame ?? ((callback) => requestAnimationFrame(() => callback()));
    this.cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.onUrl = options.onUrl;
    this.rootSpace = options.space;
  }

  // ------------------------------------------------------------------- boot

  /**
   * Resolve → layout → derive the real scale range → build the controller →
   * publish the first model. Returns the boot message for the pipeline strip.
   */
  async boot(): Promise<{ model: RenderModel; message: string }> {
    const space = this.rootSpace;
    const chain = buildLevelChain(space);
    const lod = resolveLod(space, chain, this.policy, {
      zoom: this.options.initialZoom,
      overrides: new Map(),
    });
    const { providerId, layout } = await layoutForLod(space, lod, this.layoutService);

    const lambda = characteristicLength(layout, {});
    const range = deriveScaleRange(layout.bounds, this.viewport, {
      leafWorldSize: lambda,
      readableLeafPx: this.tunables().readableLeafPx,
      frameMargin: this.tunables().frameMargin,
    });
    this.indexSpace(space);
    const rootGraphId = space.roots[0] ?? [...space.graphs.keys()].sort()[0] ?? '';
    this.rangeByGraph.set(rootGraphId, range);

    const zoom = this.options.initialZoom;
    const camera = this.centeredCamera(layout.bounds, this.scaleForZoom(zoom, range));
    this.controller = this.buildController(space, camera);

    const controllerLod = this.controller.currentResult() ?? lod;
    const usable = membersKey(controllerLod.cut.members) === membersKey(lod.cut.members);
    const bootLod = usable ? controllerLod : lod;
    const model = buildRenderModel(space, bootLod, layout, this.zStore.getState().selection);
    this.current = { lod: bootLod, layout, model };
    this.cacheLayout(bootLod.cut.members, layout);
    this.booted = true;

    this.commands.setCamera(camera);
    this.publishNav();
    this.emitUrl();
    const message = `${model.nodeIds.length.toLocaleString()} nodes · ${model.edgeKeys.length.toLocaleString()} edges · ${providerId}`;
    return { model, message };
  }

  /** The 6E session tunables — read fresh from the store at every use, so a
   * debug-panel edit takes effect on the next verb/transition (no reload). */
  private tunables(): NavTunables {
    return this.zStore.getState().tunables;
  }

  private buildController(space: GraphSpace, initialCamera: CameraState): NavigationController {
    return new NavigationController({
      space,
      policy: this.policy,
      viewport: this.viewport,
      scaleRangeFor: (graphId) =>
        this.rangeByGraph.get(graphId) ?? this.rangeByGraph.values().next().value ?? { sMin: 1, sMax: 1000 },
      search: storeLabelTokenIndex(space),
      initialCamera,
      tunables: () => this.tunables(),
    });
  }

  private indexSpace(space: GraphSpace): void {
    this.labels = new Map();
    for (const graph of space.graphs.values()) {
      for (const node of graph.nodes.values()) this.labels.set(node.id, node.label);
    }
    const forest = buildForestIndex(space);
    this.parentOf = new Map(forest.parent);
  }

  private scaleForZoom(z: number, range: ScaleRange): number {
    const clamped = Math.min(1, Math.max(0, z));
    if (range.sMax === range.sMin) return range.sMin;
    return Math.exp(Math.log(range.sMin) + clamped * (Math.log(range.sMax) - Math.log(range.sMin)));
  }

  private centeredCamera(bounds: Rect, scale: number): CameraState {
    return {
      center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    };
  }

  private fitCamera(bounds: Rect): CameraState {
    const padded = 1 + 2 * this.tunables().frameMargin;
    const sw = bounds.width > 0 ? this.viewport.width / (bounds.width * padded) : Infinity;
    const sh = bounds.height > 0 ? this.viewport.height / (bounds.height * padded) : Infinity;
    const scale = Math.min(sw, sh);
    return this.centeredCamera(bounds, Number.isFinite(scale) ? scale : 1);
  }

  // -------------------------------------------------------------- accessors

  get active(): boolean {
    return this.booted && !this.destroyed;
  }

  attachRenderer(renderer: NavigatorRenderer): void {
    this.renderer = renderer;
  }

  detachRenderer(renderer: NavigatorRenderer): void {
    if (this.renderer === renderer) this.renderer = null;
  }

  context(): NavContext {
    return this.controller.context();
  }

  telemetry(): readonly TransitionRecord[] {
    return this.records.map((record) => ({ ...record, drawTimesMs: [...record.drawTimesMs] }));
  }

  inFlight(): boolean {
    return this.flight !== null;
  }

  /** ADR-0036 switch rule: the semantic navigation intent completes while its
   * remaining visual interpolation is cancelled. The established settle path
   * is the single publisher of the chosen target model, camera, focus, and URL. */
  completeTransitionForProjectionSwitch(): void {
    const flight = this.flight;
    if (flight !== null) this.settle(flight);
  }

  urlFragment(): string {
    return this.controller.toUrl().fragment;
  }

  currentModel(): RenderModel {
    return this.current.model;
  }

  currentLod(): LodResult {
    return this.current.lod;
  }

  /** Snapshot the settled semantic cut without moving presentation authority
   * into Studio state. Focus always comes from the active NavContext. */
  projectionModel(selection: SelectionState): ProjectionModel {
    return buildProjectionModel(this.controller.currentSpace(), this.current.lod, {
      layout: this.current.layout,
      selection,
      focus: createFocusState(this.controller.context().focus),
      ...(this.options.temporal === undefined ? {} : { temporal: this.options.temporal }),
    });
  }

  displayedCamera(): CameraState {
    const flight = this.flight;
    if (flight === null) return this.controller.camera();
    return sampleCameraPath(flight.cameraPath, this.viewport, flight.lastEase);
  }

  search(query: string): SearchResult[] {
    if (!this.active) return [];
    return this.controller
      .search(query)
      .slice(0, 20)
      .map((hit) => ({ node: hit.node, score: hit.score, label: this.labels.get(hit.node) ?? String(hit.node) }));
  }

  /** Rebuild the settled model for a selection change (session delegates). */
  modelForSelection(selection: SelectionState): RenderModel {
    const model = buildRenderModel(
      this.controller.currentSpace(),
      this.current.lod,
      this.current.layout,
      selection,
    );
    if (this.flight !== null) this.flight.target.model = model;
    else this.current = { ...this.current, model };
    return model;
  }

  // ------------------------------------------------------------------ verbs

  /** Wheel/pinch zoom about a screen point — the ADR-0025 continuous verb. */
  wheelZoom(factor: number, screen: Point): void {
    if (!this.active) return;
    const worldOut = screenToWorld(screen, this.displayedCamera(), this.viewport);
    const wasFlying = this.flight !== null;
    const before = this.captureFromState();
    this.controller.zoomBy(factor, screen);
    this.afterZoomVerb(before, screen, worldOut, wasFlying);
  }

  /** Programmatic zoom to a scalar `z` about the viewport center. */
  zoomTo(z: number): void {
    if (!this.active) return;
    const screen = { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    const worldOut = screenToWorld(screen, this.displayedCamera(), this.viewport);
    const wasFlying = this.flight !== null;
    const before = this.captureFromState();
    this.controller.zoomTo(z, screen);
    this.afterZoomVerb(before, screen, worldOut, wasFlying);
  }

  zoomIn(): void {
    const factor = this.tunables().keyZoomFactor;
    this.wheelZoom(factor, { x: this.viewport.width / 2, y: this.viewport.height / 2 });
  }

  zoomOut(): void {
    const factor = this.tunables().keyZoomFactor;
    this.wheelZoom(1 / factor, { x: this.viewport.width / 2, y: this.viewport.height / 2 });
  }

  private afterZoomVerb(before: FromState, screen: Point, worldOut: Point, wasFlying: boolean): void {
    const after = this.controller.currentResult();
    if (after === undefined) return;
    const changed = membersKey(after.cut.members) !== membersKey(before.members);
    if (!changed && !wasFlying) {
      // Pure geometric zoom: no cut change, nothing in flight — render now.
      this.renderSettled();
      this.publishNav();
      this.emitUrl();
      return;
    }
    void this.transitionTo('zoom', before, { anchorScreen: screen, worldOut });
  }

  /** Pan by a CSS-pixel drag delta. Never changes the cut (ADR-0025). */
  pan(delta: Point): void {
    if (!this.active) return;
    this.controller.panBy(delta);
    const flight = this.flight;
    if (flight !== null) {
      // Mid-flight pan retargets the camera path; the anchor is re-evaluated
      // as gone (ADR-0024: anchors never queue; a pan is a new camera intent).
      const to = flight.cameraPath.to;
      flight.cameraPath = {
        from: flight.cameraPath.from,
        to: {
          center: { x: to.center.x - delta.x / to.scale, y: to.center.y - delta.y / to.scale },
          scale: to.scale,
        },
      };
      flight.record.anchored = false;
      return;
    }
    this.renderSettled();
    this.publishNav();
    this.emitUrl();
  }

  /** Explicit scope change (ADR-0025): push the node's detail context. */
  drillInto(id: NodeId): void {
    if (!this.active) return;
    const before = this.captureFromState();
    this.controller.drillInto(id);
    if (this.controller.lastNotice() !== undefined) {
      // Located no-op (no detail / unknown node): surface the notice.
      this.resumeAfterNoop(before);
      return;
    }
    void this.transitionTo('drill', before, { frame: 'fit-context' });
  }

  drillOut(): void {
    if (!this.active) return;
    const before = this.captureFromState();
    this.controller.drillOut();
    if (this.controller.lastNotice() !== undefined) {
      this.resumeAfterNoop(before);
      return;
    }
    void this.transitionTo('drill', before, { frame: 'restored-camera' });
  }

  /** Breadcrumb click: pop to `depth` (1 = root). A click on the current crumb
   * is a no-op. */
  breadcrumbTo(depth: number): void {
    if (!this.active) return;
    if (depth >= this.controller.context().depth) return;
    const before = this.captureFromState();
    this.controller.drillOutTo(depth);
    if (this.controller.lastNotice() !== undefined) {
      this.resumeAfterNoop(before);
      return;
    }
    void this.transitionTo('drill', before, { frame: 'restored-camera' });
  }

  /** Expand/collapse in place (ADR-0012 overrides through the controller). */
  toggleExpand(id: NodeId): void {
    this.overrideVerb(() => this.controller.toggle(id));
  }

  expand(id: NodeId): void {
    this.overrideVerb(() => this.controller.expand(id));
  }

  collapse(id: NodeId): void {
    this.overrideVerb(() => this.controller.collapse(id));
  }

  private overrideVerb(run: () => void): void {
    if (!this.active) return;
    const center = { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    const worldOut = screenToWorld(center, this.displayedCamera(), this.viewport);
    const before = this.captureFromState();
    run();
    const after = this.controller.currentResult();
    if (after === undefined) return;
    if (membersKey(after.cut.members) === membersKey(before.members)) {
      this.resumeAfterNoop(before);
      return;
    }
    void this.transitionTo('override', before, { anchorScreen: center, worldOut });
  }

  /** Search-result selection: set focus and fly the camera; never drills. */
  flyTo(id: NodeId): void {
    if (!this.active) return;
    const before = this.captureFromState();
    this.controller.flyTo(id);
    void this.transitionTo('fly-to', before, { flyToNode: id });
  }

  /** Keyboard bridge (6C `keyToNavCommand` → controller verbs, via the
   * transition machinery). */
  dispatchKey(verb: 'zoom-in' | 'zoom-out' | 'drill-in' | 'drill-out' | 'toggle-expand', selection?: NodeId): void {
    switch (verb) {
      case 'zoom-in':
        this.zoomIn();
        break;
      case 'zoom-out':
        this.zoomOut();
        break;
      case 'drill-in':
        if (selection !== undefined) this.drillInto(selection);
        break;
      case 'drill-out':
        this.drillOut();
        break;
      case 'toggle-expand':
        if (selection !== undefined) this.toggleExpand(selection);
        break;
    }
  }

  /** Restore a URL fragment (ADR-0025 exact view restoration). */
  restoreFromFragment(fragment: string): { readonly ok: boolean; readonly errors: readonly string[] } {
    if (!this.active) return { ok: false, errors: ['navigator inactive'] };
    const before = this.captureFromState();
    const result = this.controller.restoreFromFragment(fragment);
    void this.transitionTo('restore', before, { frame: 'restored-camera' });
    return result;
  }

  /** Pan the settled camera so `world` is centered (minimap click). */
  centerOn(world: Point): void {
    if (!this.active) return;
    const camera = this.displayedCamera();
    this.controller.setCamera({ center: world, scale: camera.scale });
    if (this.flight === null) {
      this.renderSettled();
      this.publishNav();
      this.emitUrl();
    }
  }

  /**
   * P1 subscription entry: the graph store committed a delta. Rebuild the
   * controller over the new snapshot, restore the serialized navigation state,
   * and replan — from the interpolated frame when a transition is in flight
   * (the roadmap's store-mutation-mid-transition failure case).
   */
  spaceMutated(space: GraphSpace): void {
    if (!this.active) return;
    const before = this.captureFromState();
    const state = this.controller.serialize();
    this.rootSpace = space;
    this.indexSpace(space);
    this.controller = this.buildController(space, this.controller.camera());
    const restored = this.controller.restore(state);
    if (!restored.ok && restored.errors.length > 0) {
      // Root graph changed identity — an ingest-level change, not a delta;
      // nothing to navigate. Surface via nav notice.
      this.publishNav();
      return;
    }
    this.layoutCache.clear();
    void this.transitionTo('mutation', before, { frame: 'restored-camera' });
  }

  // ------------------------------------------------------ transition machinery

  private captureFromState(): FromState {
    const flight = this.flight;
    if (flight === null) {
      return {
        members: this.current.lod.cut.members,
        positions: this.current.layout.positions,
        model: this.current.model,
        camera: this.controller.camera(),
        layoutForPrev: this.current.layout,
        replanned: false,
      };
    }
    // Retarget: snapshot the interpolated state (ADR-0023) and cancel — never queue.
    flight.record.superseded = true;
    const camera = sampleCameraPath(flight.cameraPath, this.viewport, flight.lastEase);
    const state =
      flight.prepared === null
        ? { members: this.current.lod.cut.members, positions: this.current.layout.positions }
        : snapshotFlightLayout(flight.prepared, flight.lastEase);
    const model =
      flight.prepared === null
        ? this.current.model
        : sampleTransitionModel(flight.prepared, flight.lastEase);
    this.endFlight(flight, false);
    return {
      members: state.members,
      positions: state.positions,
      model,
      camera,
      layoutForPrev: flight.target.layout,
      replanned: true,
    };
  }

  private resumeAfterNoop(before: FromState): void {
    if (before.replanned) {
      // A no-op verb still consumed the flight snapshot; finish the journey to
      // the (unchanged) target from the snapshot geometry.
      void this.transitionTo('zoom', before, {});
      return;
    }
    this.publishNav();
  }

  private async transitionTo(
    trigger: TransitionTrigger,
    before: FromState,
    opts: {
      readonly anchorScreen?: Point;
      readonly worldOut?: Point;
      readonly frame?: 'fit-context' | 'restored-camera';
      readonly flyToNode?: NodeId;
    },
  ): Promise<void> {
    const gestureAt = performance.now();
    const seq = ++this.seq;
    const lod = this.controller.currentResult();
    if (lod === undefined) return;
    const space = this.controller.currentSpace();
    const context = this.controller.context();
    // One snapshot of the 6E session tunables per transition: a panel edit
    // lands wholly on the *next* transition, never mid-plan.
    const tunables = this.tunables();

    const record: TransitionRecord = {
      seq,
      trigger,
      mode: 'camera-only',
      planMs: 0,
      layoutMs: 0,
      durationMs: 0,
      gestureAtMs: gestureAt,
      settledAtMs: null,
      gestureToSettleMs: null,
      maxDriftPx: 0,
      anchored: opts.anchorScreen !== undefined,
      replannedFromFlight: before.replanned,
      superseded: false,
      guardTripped: false,
      degradeTriggers: [],
      drawTimesMs: [],
    };
    this.records.push(record);
    if (this.records.length > 64) this.records.shift();

    // ---- layout the target cut (cached per member set within a context) ----
    const cacheKey = `${context.workingRoot}\u0000${membersKey(lod.cut.members)}`;
    let layout = this.layoutCache.get(cacheKey);
    if (layout === undefined) {
      const layoutStart = performance.now();
      try {
        const result = await layoutForLod(space, lod, this.layoutService, before.layoutForPrev);
        layout = result.layout;
      } catch {
        return; // layout worker crashed; the settled frame stays up (located elsewhere)
      }
      record.layoutMs = performance.now() - layoutStart;
      if (seq !== this.seq || this.destroyed) {
        record.superseded = true;
        return; // a newer verb took over while laying out — never queue
      }
      this.cacheLayoutKeyed(cacheKey, layout);
    }

    // First visit to a drilled context: derive its real scale range from the
    // laid-out bounds (ADR-0025 amendment; preserves z so the cut holds).
    if (!this.rangeByGraph.has(context.workingRoot)) {
      const lambda = characteristicLength(layout, {});
      const range = deriveScaleRange(layout.bounds, this.viewport, {
        leafWorldSize: lambda,
        readableLeafPx: tunables.readableLeafPx,
        frameMargin: tunables.frameMargin,
      });
      this.rangeByGraph.set(context.workingRoot, range);
      this.controller.updateScaleRange(range, 'z');
    }

    // ---- plan (pure) -------------------------------------------------------
    const fromLayout = syntheticLayout(before.positions);
    const planStart = performance.now();
    const refinement = deriveRefinementMap(asCut(before.members), lod.cut, this.rootSpace);
    const plan: TransitionPlan = planTransition(
      { cut: asCut(before.members), layout: fromLayout },
      { cut: lod.cut, layout },
      refinement,
      tunables,
    );
    record.planMs = performance.now() - planStart;
    const degrade = plan.diagnostics.find((d) => d.code === 'degrade-to-crossfade');
    record.degradeTriggers = degrade?.triggers ?? [];

    // ---- camera target (ADR-0024 anchored solve, or framing) ---------------
    let toCamera: CameraState;
    let anchor: CameraPath['anchor'];
    if (opts.anchorScreen !== undefined && opts.worldOut !== undefined) {
      const solution = solveAnchoredCamera({
        worldOut: opts.worldOut,
        anchorScreen: opts.anchorScreen,
        viewport: this.viewport,
        scaleIn: this.controller.camera().scale,
        fromCut: asCut(before.members),
        fromLayout,
        toLayout: layout,
        refinement,
        lambda: characteristicLength(fromLayout, {}),
        anchorSnapFactor: tunables.anchorSnapFactor,
      });
      toCamera = solution.camera;
      anchor = { screen: opts.anchorScreen, worldOut: solution.worldOut, worldIn: solution.worldIn };
      this.controller.setCamera(toCamera);
    } else if (opts.frame === 'fit-context') {
      toCamera = this.fitCamera(layout.bounds);
      this.controller.setCamera(toCamera);
    } else if (opts.flyToNode !== undefined) {
      const rect = this.rectForNode(opts.flyToNode, lod, layout);
      const camera = this.controller.camera();
      toCamera =
        rect === undefined
          ? camera
          : { center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, scale: camera.scale };
      this.controller.setCamera(toCamera);
    } else {
      toCamera = this.controller.camera(); // restored/mutation: the controller holds truth
    }

    // Camera writes above may themselves have re-resolved; take the final cut.
    const finalLod = this.controller.currentResult() ?? lod;
    const model = buildRenderModel(space, finalLod, layout, this.zStore.getState().selection);

    const changed = membersKey(finalLod.cut.members) !== membersKey(before.members);
    const prepared = changed || before.replanned ? prepareTransition(before.model, model, plan) : null;
    record.mode = prepared === null ? 'camera-only' : plan.mode;

    // ADR-0023 duration clamp: plan computation + layout + animation ≤ 300ms.
    // Under the manual clock the timeline is test-driven and must not depend
    // on real measured overhead (deterministic baselines), so the plan's own
    // duration stands.
    const overhead = this.clock.manual ? 0 : record.layoutMs + record.planMs;
    record.durationMs =
      prepared === null
        ? Math.min(tunables.baseTransitionMs, MAX_TRANSITION_MS) // camera-only flight
        : Math.max(0, Math.min(plan.durationMs, MAX_TRANSITION_MS - overhead));

    this.flight = {
      seq,
      prepared,
      cameraPath: { from: before.camera, to: toCamera, ...(anchor !== undefined ? { anchor } : {}) },
      startedAtClock: this.clock.now(),
      durationMs: record.durationMs,
      target: { lod: finalLod, layout, model, camera: toCamera },
      record,
      guard: GUARD_INITIAL,
      phase: 'flying',
      lastEase: 0,
      lastT: 0,
    };
    this.watchStats();
    this.publishNav();
    this.tick();
  }

  private rectForNode(id: NodeId, lod: LodResult, layout: LayoutResult): Rect | undefined {
    const direct = layout.positions.get(id);
    if (direct !== undefined) return direct;
    // The target sits below the cut: fly to its covering member (ADR-0012 —
    // the member stands in for its subtree).
    const memberSet = new Set(lod.cut.members);
    let cursor: NodeId | undefined = id;
    while (cursor !== undefined && !memberSet.has(cursor)) cursor = this.parentOf.get(cursor);
    return cursor === undefined ? undefined : layout.positions.get(cursor);
  }

  // ---------------------------------------------------------------- the loop

  /** Advance one frame. Public for the manual-clock test API. */
  tick(): void {
    const flight = this.flight;
    if (flight === null || this.destroyed) return;
    const elapsed = this.clock.now() - flight.startedAtClock;
    const t = flight.durationMs <= 0 ? 1 : Math.min(1, elapsed / flight.durationMs);
    const e = easeInOutCubic(t);
    flight.lastT = t;
    flight.lastEase = e;

    const camera = sampleCameraPath(flight.cameraPath, this.viewport, e);
    const drift = anchorDriftPx(flight.cameraPath, this.viewport, e, camera);
    if (drift > flight.record.maxDriftPx) flight.record.maxDriftPx = drift;

    if (t >= 1) {
      this.settle(flight);
      return;
    }
    const model =
      flight.prepared === null ? this.current.model : sampleTransitionModel(flight.prepared, e);
    this.renderer?.render(model, camera);
    if (!this.clock.manual) this.scheduleTick();
  }

  private scheduleTick(): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = null;
      this.tick();
    });
  }

  private settle(flight: Flight): void {
    this.endFlight(flight, true);
    this.current = { lod: flight.target.lod, layout: flight.target.layout, model: flight.target.model };
    flight.record.settledAtMs = performance.now();
    flight.record.gestureToSettleMs = flight.record.settledAtMs - flight.record.gestureAtMs;
    this.renderer?.render(flight.target.model, flight.target.camera);
    this.commands.replaceModelAfterSelection(flight.target.model);
    this.commands.setCamera(flight.target.camera);
    this.publishNav();
    this.emitUrl();
  }

  private endFlight(flight: Flight, settled: boolean): void {
    if (this.flight === flight) this.flight = null;
    if (!settled) flight.record.settledAtMs = null;
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.statsUnsub !== null) {
      this.statsUnsub();
      this.statsUnsub = null;
    }
  }

  /** ADR-0023 runtime guard: watch renderer draw times while flying; three
   * consecutive >22ms frames abandon tweens for a ≤100ms finish-fade. Disabled
   * under the manual clock (deterministic baselines must not depend on host
   * speed); measured by the 6D FPS harness under the real clock. */
  private watchStats(): void {
    if (this.statsUnsub !== null) return;
    this.statsUnsub = this.zStore.subscribe((state, previous) => {
      const flight = this.flight;
      if (flight === null) return;
      const stats = state.rendererStats;
      if (stats === null || stats === previous.rendererStats) return;
      flight.record.drawTimesMs.push(stats.frameTimeMs);
      if (flight.record.drawTimesMs.length > 2000) flight.record.drawTimesMs.shift();
      if (this.clock.manual || flight.phase !== 'flying' || flight.prepared === null) return;
      flight.guard = guardStep(flight.guard, stats.frameTimeMs);
      if (flight.guard.tripped) this.tripGuard(flight);
    });
  }

  private tripGuard(flight: Flight): void {
    flight.record.guardTripped = true;
    flight.phase = 'finish-fade';
    const sampled = sampleTransitionModel(flight.prepared!, flight.lastEase);
    const remaining = Math.max(0, flight.durationMs * (1 - flight.lastT));
    const fadeMs = Math.min(GUARD_FINISH_FADE_MS, remaining);
    const fadePlan: TransitionPlan = {
      mode: 'crossfade',
      enter: [],
      exit: [],
      move: [],
      durationMs: fadeMs,
      diagnostics: [],
    };
    flight.prepared = prepareTransition(sampled, flight.target.model, fadePlan);
    flight.cameraPath = {
      from: sampleCameraPath(flight.cameraPath, this.viewport, flight.lastEase),
      to: flight.target.camera,
      ...(flight.cameraPath.anchor !== undefined ? { anchor: flight.cameraPath.anchor } : {}),
    };
    flight.startedAtClock = this.clock.now();
    flight.durationMs = fadeMs;
    flight.lastEase = 0;
    flight.lastT = 0;
  }

  // ------------------------------------------------------------ store & url

  private renderSettled(): void {
    this.renderer?.render(this.current.model, this.controller.camera());
    this.commands.setCamera(this.controller.camera());
  }

  private publishNav(): void {
    const context = this.controller.context();
    const notice = this.controller.lastNotice();
    const last = this.records.at(-1);
    const nav: StudioNavState = {
      depth: context.depth,
      zoom: context.zoom,
      level: context.level,
      breadcrumbs: context.breadcrumbs.map((crumb) => ({
        graphId: crumb.graphId,
        node: crumb.node ?? null,
        label: crumb.label ?? null,
      })),
      focus: context.focus ?? null,
      cutSize: context.cutMembers.length,
      notice: notice === undefined ? null : { code: notice.code, message: notice.message },
      urlFragment: this.controller.toUrl().fragment,
      transition: {
        active: this.flight !== null,
        count: this.records.length,
        lastMode: last?.mode ?? null,
      },
      saturated: context.zoom >= 1,
    };
    this.commands.setNav(nav);
  }

  private emitUrl(): void {
    this.onUrl?.(this.controller.toUrl().fragment);
  }

  private cacheLayout(members: readonly NodeId[], layout: LayoutResult): void {
    const context = this.controller?.context();
    const root = context?.workingRoot ?? 'root';
    this.cacheLayoutKeyed(`${root}\u0000${membersKey(members)}`, layout);
  }

  private cacheLayoutKeyed(key: string, layout: LayoutResult): void {
    this.layoutCache.set(key, layout);
    while (this.layoutCache.size > LAYOUT_CACHE_LIMIT) {
      const oldest = this.layoutCache.keys().next().value;
      if (oldest === undefined) break;
      this.layoutCache.delete(oldest);
    }
  }

  destroy(): void {
    this.destroyed = true;
    const flight = this.flight;
    if (flight !== null) this.endFlight(flight, false);
    this.renderer = null;
  }
}
