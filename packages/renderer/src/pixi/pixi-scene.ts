import { Container, WebGLRenderer } from 'pixi.js';
import type { CameraState, Point, RenderModel, ViewportSize } from '@meridian/view-model';
import {
  buildSceneGeometryPlan,
  completeScenePlan,
  cullScenePlan,
  unculledSceneGeometry,
  type SceneGeometryPlan,
  type ScenePlan,
} from '../scene-plan.js';
import { meridianAtlasCoverage, planLabels, type AtlasCoverage } from '../labels/index.js';
import { hitTest, type HitTestResult } from '../picking/index.js';
import { SceneEvents } from '../events.js';
import { PixiLabelLayer } from './label-layer.js';
import { createBrowserSpatialIndexWorkerFactory } from '../spatial-index/browser-worker-factory.js';
import {
  SpatialIndexHost,
  type SpatialIndexWorkerEndpoint,
  type SpatialIndexWorkerFactory,
  type SpatialIndexSnapshot,
} from '../spatial-index/host.js';
import { createSpatialIndexWorkerHandler } from '../spatial-index/worker.js';
import type {
  PickResult,
  RendererStats,
  SceneAdapter,
  SceneEventPayloads,
  SceneOptions,
  Unsubscribe,
} from '../types.js';
import { PixiGpuBatches } from './gpu-batches.js';
import { orderVisibleNodeBatches } from '../visual-order.js';

const EMPTY_STATS: RendererStats = {
  frameTimeMs: 0,
  drawCalls: 0,
  frameCount: 0,
  modelNodes: 0,
  candidateNodes: 0,
  visibleNodes: 0,
  culledNodes: 0,
  modelEdges: 0,
  visibleEdges: 0,
  culledEdges: 0,
  modelEdgeSegments: 0,
  candidateEdgeSegments: 0,
  visibleEdgeSegments: 0,
  submittedNodeBatches: 0,
  submittedEdgeBatches: 0,
  liveLabels: 0,
  bitmapLabelCount: 0,
  fallbackLabelCount: 0,
  omittedLabelCount: 0,
  pickQueryTimeMs: 0,
  contextLosses: 0,
  bufferUploadBytes: 0,
};

type Lifecycle = 'new' | 'mounting' | 'mounted' | 'destroyed';

function finitePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`renderer: ${name} must be a positive safe integer`);
  }
  return value;
}

function normalizedOptions(options: SceneOptions): Required<SceneOptions> {
  const maxDevicePixelRatio = options.maxDevicePixelRatio ?? 2;
  if (!Number.isFinite(maxDevicePixelRatio) || maxDevicePixelRatio <= 0) {
    throw new RangeError('renderer: maxDevicePixelRatio must be finite and greater than zero');
  }
  return {
    background: options.background ?? 0x0b1020,
    maxDevicePixelRatio,
    maxBatchSize: finitePositiveInteger(options.maxBatchSize ?? 512, 'maxBatchSize'),
    antialias: options.antialias ?? false,
    fontUrl: options.fontUrl ?? '/fonts/meridian-msdf.fnt',
  };
}

function copyStats(stats: RendererStats): RendererStats {
  return { ...stats };
}

/** Same hit target (ignoring the point), so coalesced hover emits nothing new. */
function sameHit(a: HitTestResult | null, b: HitTestResult | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'node' && b.kind === 'node') return a.nodeIndex === b.nodeIndex;
  if (a.kind === 'edge' && b.kind === 'edge') return a.edgeKey === b.edgeKey;
  return false;
}

/** Drop transient index-space fields; the public result carries stable identity. */
function toPickResult(hit: HitTestResult | null): PickResult | null {
  if (hit === null) return null;
  if (hit.kind === 'node') {
    return { kind: 'node', nodeId: hit.nodeId, screen: hit.screen, world: hit.world };
  }
  return { kind: 'edge', edgeKey: hit.edgeKey, screen: hit.screen, world: hit.world };
}

function viewportOf(canvas: HTMLCanvasElement): ViewportSize {
  const bounds = canvas.getBoundingClientRect();
  return {
    width: Math.max(0, bounds.width || canvas.clientWidth || canvas.width || 0),
    height: Math.max(0, bounds.height || canvas.clientHeight || canvas.height || 0),
  };
}

function inlineSpatialIndexWorkerFactory(): SpatialIndexWorkerFactory {
  return (): SpatialIndexWorkerEndpoint => {
    let messageListener: (message: unknown) => void = () => undefined;
    let errorListener: (error: unknown) => void = () => undefined;
    const handle = createSpatialIndexWorkerHandler((message) => messageListener(message));
    return {
      postMessage(message): void {
        try {
          handle(message);
        } catch (error) {
          errorListener(error);
        }
      },
      onMessage(listener) {
        messageListener = listener;
        return (): void => {
          if (messageListener === listener) messageListener = () => undefined;
        };
      },
      onError(listener) {
        errorListener = listener;
        return (): void => {
          if (errorListener === listener) errorListener = () => undefined;
        };
      },
      terminate(): void {
        messageListener = () => undefined;
        errorListener = () => undefined;
      },
    };
  };
}

function defaultSpatialIndexWorkerFactory(): SpatialIndexWorkerFactory {
  return typeof Worker === 'undefined'
    ? inlineSpatialIndexWorkerFactory()
    : createBrowserSpatialIndexWorkerFactory();
}

/** Pixi is completely contained in this leaf; no Pixi declaration crosses the public seam. */
export class PixiScene implements SceneAdapter {
  private readonly options: Required<SceneOptions>;
  private readonly events = new SceneEvents();
  private lifecycle: Lifecycle = 'new';
  private canvas: HTMLCanvasElement | null = null;
  private renderer: WebGLRenderer<HTMLCanvasElement> | null = null;
  private rendererReady = false;
  private root: Container | null = null;
  private stage: Container | null = null;
  private gpu: PixiGpuBatches | null = null;
  private labels: PixiLabelLayer | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private viewport: ViewportSize = { width: 0, height: 0 };
  private latestModel: RenderModel | null = null;
  private latestCamera: CameraState | null = null;
  private geometry: SceneGeometryPlan | null = null;
  private plan: ScenePlan | null = null;
  private readonly spatialIndex: SpatialIndexHost;
  private readonly coverage: AtlasCoverage = meridianAtlasCoverage();
  private frameHandle: number | null = null;
  private contextLost = false;
  private currentStats: RendererStats = EMPTY_STATS;
  private hover: HitTestResult | null = null;
  private pointerScreen: Point | null = null;
  private hoverPending = false;
  private readonly reportedLabelDiagnostics = new Set<string>();

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.lifecycle !== 'mounted') return;
    if (this.contextLost) return;
    this.contextLost = true;
    this.cancelFrame();
    this.currentStats = {
      ...this.currentStats,
      contextLosses: this.currentStats.contextLosses + 1,
    };
    this.events.emit('fault', {
      code: 'context-lost',
      message: 'WebGL context lost; the latest CPU-side scene is retained for restoration.',
    });
  };

  private readonly handleContextRestored = (): void => {
    if (this.lifecycle !== 'mounted' || !this.contextLost) return;
    try {
      this.applyViewport();
      this.rebuildGpuResources();
      this.contextLost = false;
      this.schedule();
    } catch (error) {
      this.events.emit('fault', {
        code: 'context-restore-failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.lifecycle !== 'mounted') return;
    this.pointerScreen = this.canvasLocal(event);
    this.hoverPending = true;
    this.schedule();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.lifecycle !== 'mounted') return;
    // Selection hit-tests immediately against the same index (ADR-0021).
    this.events.emit('select', toPickResult(this.runHitTest(this.canvasLocal(event))));
  };

  private readonly handlePointerLeave = (): void => {
    if (this.lifecycle !== 'mounted') return;
    this.pointerScreen = null;
    this.hoverPending = false;
    if (this.hover !== null) {
      this.hover = null;
      this.events.emit('hover', null);
      this.schedule();
    }
  };

  constructor(options: SceneOptions = {}) {
    this.options = normalizedOptions(options);
    this.spatialIndex = new SpatialIndexHost({ factory: defaultSpatialIndexWorkerFactory() });
  }

  async mount(canvas: HTMLCanvasElement): Promise<void> {
    if (this.lifecycle !== 'new') {
      throw new Error(`renderer: mount is single-use (current lifecycle: ${this.lifecycle})`);
    }
    this.lifecycle = 'mounting';
    this.canvas = canvas;
    this.viewport = viewportOf(canvas);

    const renderer = new WebGLRenderer<HTMLCanvasElement>();
    this.renderer = renderer;
    const devicePixelRatio = Math.min(
      this.options.maxDevicePixelRatio,
      canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1,
    );

    try {
      await renderer.init({
        canvas,
        width: Math.max(1, this.viewport.width),
        height: Math.max(1, this.viewport.height),
        resolution: devicePixelRatio,
        autoDensity: true,
        antialias: this.options.antialias,
        backgroundColor: this.options.background,
        preferWebGLVersion: 2,
        powerPreference: 'high-performance',
        // The full `pixi.js` entry above already registers browser/rendering
        // extensions. A second environment auto-import can deadlock a
        // Vite-split entry while its own module graph is still evaluating.
        skipExtensionImports: true,
      });
      this.rendererReady = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.events.emit('fault', { code: 'mount-failed', message });
      this.removeCanvasListeners();
      this.renderer = null;
      this.canvas = null;
      this.lifecycle = 'destroyed';
      throw error;
    }

    if (this.isDestroyed()) {
      renderer.destroy({ removeView: false });
      this.rendererReady = false;
      this.renderer = null;
      this.canvas = null;
      return;
    }

    // Pixi registers its context lifecycle during `init`. Register Meridian
    // second so Pixi restores the renderer before we rebuild scene resources.
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    this.root = new Container();
    this.stage = new Container();
    this.root.addChild(this.stage);
    this.gpu = new PixiGpuBatches(this.options.maxBatchSize);
    this.labels = new PixiLabelLayer(this.root);

    // ADR-0020: mount resolves only after the local MSDF atlas is ready. A load
    // failure degrades to no bitmap labels rather than failing the whole mount.
    try {
      await this.labels.load(this.options.fontUrl);
    } catch (error) {
      this.events.emit('fault', {
        code: 'font-load-failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.isDestroyed()) {
      renderer.destroy({ removeView: false });
      this.rendererReady = false;
      this.renderer = null;
      this.canvas = null;
      return;
    }

    this.addPointerListeners(canvas);
    this.lifecycle = 'mounted';
    this.observeResize(canvas);
    this.schedule();
  }

  render(model: RenderModel, camera: CameraState): void {
    this.assertMounted('render');
    if (this.latestModel !== null && this.latestModel.revision !== model.revision) {
      // Hover is renderer-lifetime state tied to one immutable model revision.
      // Never let an index-space identity survive replacement, even when the
      // next revision happens to reuse the same slot or stable node id.
      this.hoverPending = false;
      if (this.hover !== null) {
        this.hover = null;
        this.events.emit('hover', null);
      }
    }
    this.latestModel = model;
    this.latestCamera = {
      center: { x: camera.center.x, y: camera.center.y },
      scale: camera.scale,
    };
    if (this.geometry?.modelRevision !== model.revision) {
      this.geometry = buildSceneGeometryPlan(model, {
        maxBatchSize: this.options.maxBatchSize,
      });
      this.plan = null;
      if (!this.contextLost) {
        this.gpu!.configure(
          this.stage!,
          this.geometry.nodeBatches.length,
          this.geometry.edgeBatches.length,
        );
      }
      this.requestSpatialIndex(model, this.geometry);
    }
    this.schedule();
  }

  pick(screen: Point): PickResult | null {
    this.assertMounted('pick');
    return toPickResult(this.runHitTest(screen));
  }

  /** Node index used for hover-based label promotion and the topmost tie-break. */
  private hoverNodeIndex(): number | null {
    return this.hover?.kind === 'node' ? this.hover.nodeIndex : null;
  }

  /**
   * Synchronous pick against the current index. Returns `null` until the worker
   * index for the live model revision is installed, never from a stale revision.
   */
  private runHitTest(screen: Point): HitTestResult | null {
    if (this.plan === null || this.latestModel === null || this.latestCamera === null) return null;
    if (this.plan.modelRevision !== this.latestModel.revision) return null;
    const start = performance.now();
    const result = hitTest({
      model: this.latestModel,
      nodeTree: this.plan.nodeTree,
      edgeTree: this.plan.edgeTree,
      edgeSegments: this.plan.edgeSegments,
      camera: this.latestCamera,
      viewport: this.viewport,
      screen,
      hoverNodeIndex: this.hoverNodeIndex(),
    });
    this.currentStats = { ...this.currentStats, pickQueryTimeMs: performance.now() - start };
    return result;
  }

  /** One coalesced hover hit-test per frame; unchanged targets emit nothing. */
  private updateHover(): void {
    if (!this.hoverPending) return;
    this.hoverPending = false;
    const next = this.pointerScreen === null ? null : this.runHitTest(this.pointerScreen);
    if (sameHit(this.hover, next)) return;
    this.hover = next;
    this.events.emit('hover', toPickResult(next));
  }

  private reportLabelDiagnostic(diagnostic: string): void {
    if (this.reportedLabelDiagnostics.has(diagnostic)) return;
    this.reportedLabelDiagnostics.add(diagnostic);
    globalThis.console?.warn?.(`renderer: labels ${diagnostic}`);
  }

  private canvasLocal(event: PointerEvent): Point {
    const bounds = this.canvas?.getBoundingClientRect();
    if (bounds === undefined) return { x: event.clientX, y: event.clientY };
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private addPointerListeners(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);
  }

  private removePointerListeners(): void {
    this.canvas?.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas?.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas?.removeEventListener('pointerleave', this.handlePointerLeave);
  }

  on<E extends keyof SceneEventPayloads>(
    event: E,
    listener: (payload: SceneEventPayloads[E]) => void,
  ): Unsubscribe {
    if (this.lifecycle === 'destroyed') {
      throw new Error('renderer: cannot subscribe to a destroyed scene');
    }
    return this.events.on(event, listener);
  }

  stats(): Readonly<RendererStats> {
    return copyStats(this.currentStats);
  }

  destroy(): void {
    if (this.lifecycle === 'destroyed') return;
    this.lifecycle = 'destroyed';
    this.cancelFrame();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.removeCanvasListeners();
    this.removePointerListeners();
    this.gpu?.destroy();
    this.gpu = null;
    this.labels?.destroy();
    this.labels = null;
    this.stage?.removeChildren();
    this.stage?.destroy();
    this.stage = null;
    this.root?.destroy();
    this.root = null;
    this.hover = null;
    this.pointerScreen = null;
    // During async init, mount owns final renderer cleanup after its await.
    if (this.renderer !== null && this.rendererReady) {
      this.renderer.destroy({ removeView: false });
      this.rendererReady = false;
      this.renderer = null;
    }
    this.canvas = null;
    this.latestModel = null;
    this.latestCamera = null;
    this.geometry = null;
    this.plan = null;
    void this.spatialIndex.dispose();
    this.events.clear();
  }

  private observeResize(canvas: HTMLCanvasElement): void {
    const Observer = canvas.ownerDocument.defaultView?.ResizeObserver;
    if (Observer === undefined) return;
    this.resizeObserver = new Observer(() => {
      if (this.lifecycle !== 'mounted' || this.renderer === null) return;
      this.applyViewport();
      this.schedule();
    });
    this.resizeObserver.observe(canvas);
  }

  private schedule(): void {
    if (
      this.lifecycle !== 'mounted' ||
      this.contextLost ||
      this.frameHandle !== null ||
      this.canvas === null
    ) {
      return;
    }
    const view = this.canvas.ownerDocument.defaultView;
    if (view === null) return;
    this.frameHandle = view.requestAnimationFrame(() => {
      this.frameHandle = null;
      this.draw();
    });
  }

  private draw(): void {
    if (
      this.lifecycle !== 'mounted' ||
      this.contextLost ||
      this.renderer === null ||
      this.root === null ||
      this.stage === null ||
      this.gpu === null
    ) {
      return;
    }
    this.updateHover();
    const start = performance.now();
    try {
      let liveLabels = 0;
      let bitmapLabelCount = 0;
      let fallbackLabelCount = 0;
      let omittedLabelCount = 0;
      let drawCalls = 0;
      let modelNodes = 0;
      let candidateNodes = 0;
      let visibleNodes = 0;
      let culledNodes = 0;
      let modelEdges = 0;
      let visibleEdges = 0;
      let culledEdges = 0;
      let modelEdgeSegments = 0;
      let candidateEdgeSegments = 0;
      let visibleEdgeSegments = 0;
      let submittedNodeBatches = 0;
      let submittedEdgeBatches = 0;
      let uploaded = 0;
      if (this.latestModel !== null && this.latestCamera !== null && this.geometry !== null) {
        const camera = this.latestCamera;
        const visible =
          this.plan === null
            ? unculledSceneGeometry(this.geometry, camera, this.viewport)
            : cullScenePlan(this.plan, camera, this.viewport);
        const orderedNodeBatches = orderVisibleNodeBatches(
          this.latestModel,
          visible.nodeBatches,
          this.hoverNodeIndex(),
          this.options.maxBatchSize,
        );
        this.stage.scale.set(camera.scale, camera.scale);
        this.stage.position.set(
          this.viewport.width / 2 - camera.center.x * camera.scale,
          this.viewport.height / 2 - camera.center.y * camera.scale,
        );
        uploaded += this.gpu.updateEdges(
          this.latestModel,
          this.geometry.edgeSegments,
          visible.edgeBatches,
          camera.scale,
        );
        uploaded += this.gpu.updateNodes(
          this.latestModel,
          orderedNodeBatches,
          camera.scale,
        );
        drawCalls = orderedNodeBatches.length + visible.stats.submittedEdgeBatches;
        modelNodes = visible.stats.modelNodes;
        candidateNodes = visible.stats.candidateNodes;
        visibleNodes = visible.stats.visibleNodes;
        culledNodes = visible.stats.culledNodes;
        modelEdges = visible.stats.modelEdges;
        visibleEdges = visible.stats.visibleEdges;
        culledEdges = visible.stats.culledEdges;
        modelEdgeSegments = visible.stats.modelEdgeSegments;
        candidateEdgeSegments = visible.stats.candidateEdgeSegments;
        visibleEdgeSegments = visible.stats.visibleEdgeSegments;
        submittedNodeBatches = orderedNodeBatches.length;
        submittedEdgeBatches = visible.stats.submittedEdgeBatches;

        if (this.labels !== null) {
          const visibleNodeIndices: number[] = [];
          for (const batch of visible.nodeBatches) {
            for (const index of batch.indices) visibleNodeIndices.push(index);
          }
          const labelPlan = planLabels({
            model: this.latestModel,
            camera,
            viewport: this.viewport,
            visibleNodeIndices,
            hoverNodeIndex: this.hoverNodeIndex(),
            coverage: this.coverage,
          });
          this.labels.sync(labelPlan);
          bitmapLabelCount = labelPlan.bitmapLabelCount;
          fallbackLabelCount = labelPlan.fallbackLabelCount;
          omittedLabelCount = labelPlan.omittedLabelCount;
          liveLabels = bitmapLabelCount + fallbackLabelCount;
          for (const diagnostic of labelPlan.diagnostics) this.reportLabelDiagnostic(diagnostic);
        }
      }
      this.renderer.render(this.root);
      const frameTimeMs = performance.now() - start;
      this.currentStats = {
        frameTimeMs,
        drawCalls,
        frameCount: this.currentStats.frameCount + 1,
        modelNodes,
        candidateNodes,
        visibleNodes,
        culledNodes,
        modelEdges,
        visibleEdges,
        culledEdges,
        modelEdgeSegments,
        candidateEdgeSegments,
        visibleEdgeSegments,
        submittedNodeBatches,
        submittedEdgeBatches,
        liveLabels,
        bitmapLabelCount,
        fallbackLabelCount,
        omittedLabelCount,
        pickQueryTimeMs: this.currentStats.pickQueryTimeMs,
        contextLosses: this.currentStats.contextLosses,
        bufferUploadBytes: this.currentStats.bufferUploadBytes + uploaded,
      };
      this.events.emit('stats', copyStats(this.currentStats));
    } catch (error) {
      this.events.emit('fault', {
        code: 'render-failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private rebuildGpuResources(): void {
    if (this.stage === null) return;
    this.gpu?.destroy();
    this.stage.removeChildren();
    this.gpu = new PixiGpuBatches(this.options.maxBatchSize);
    if (this.geometry !== null) {
      this.gpu.configure(
        this.stage,
        this.geometry.nodeBatches.length,
        this.geometry.edgeBatches.length,
      );
    }
  }

  private requestSpatialIndex(model: RenderModel, geometry: SceneGeometryPlan): void {
    const pending = this.spatialIndex.build({
      modelRevision: model.revision,
      nodeRects: model.nodeRects.slice(),
      edgeSegments: geometry.edgeSegments.coordinates.slice(),
    });

    const immediate = this.spatialIndex.snapshotFor(model.revision);
    if (immediate !== null) this.installSpatialIndex(geometry, immediate);

    void pending.then(
      (snapshot) => this.installSpatialIndex(geometry, snapshot),
      (error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (this.lifecycle !== 'mounted' || this.geometry !== geometry) return;
        this.events.emit('fault', {
          code: 'spatial-index-failed',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  private installSpatialIndex(
    geometry: SceneGeometryPlan,
    snapshot: SpatialIndexSnapshot,
  ): void {
    if (
      this.lifecycle !== 'mounted' ||
      this.geometry !== geometry ||
      this.latestModel?.revision !== snapshot.modelRevision ||
      this.plan?.modelRevision === snapshot.modelRevision
    ) {
      return;
    }
    this.plan = completeScenePlan(geometry, snapshot);
    this.schedule();
  }

  private applyViewport(): void {
    if (this.canvas === null || this.renderer === null) return;
    this.viewport = viewportOf(this.canvas);
    const resolution = Math.min(
      this.options.maxDevicePixelRatio,
      this.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1,
    );
    this.renderer.resize(
      Math.max(1, this.viewport.width),
      Math.max(1, this.viewport.height),
      resolution,
    );
  }

  private cancelFrame(): void {
    if (this.frameHandle === null || this.canvas === null) return;
    this.canvas.ownerDocument.defaultView?.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private removeCanvasListeners(): void {
    this.canvas?.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas?.removeEventListener('webglcontextrestored', this.handleContextRestored);
  }

  private assertMounted(operation: string): void {
    if (this.lifecycle !== 'mounted') {
      throw new Error(`renderer: ${operation} requires a mounted scene`);
    }
  }

  private isDestroyed(): boolean {
    return this.lifecycle === 'destroyed';
  }
}
