/**
 * Imperative React/canvas bridge (ADR-0022). This plain `.ts` module is the
 * only Studio code that invokes SceneAdapter rendering methods. React mounts a
 * canvas; this object owns renderer/camera lifecycle and value subscriptions.
 */
import {
  createCameraController,
  createScene,
  type CameraController,
  type RendererStats,
  type SceneAdapter,
  type SceneFactory,
  type Unsubscribe,
} from '@meridian/renderer';
import {
  diffRenderModels,
  worldToScreen,
  type CameraState,
  type Point,
  type RenderModel,
  type ViewportSize,
} from '@meridian/view-model';
import { StudioStoreCommands, type StudioStore } from './store.js';

/** The 6D navigation input sink (wheel/pan reroute when a corpus navigator is
 * active). Kept structural so the bridge never imports the navigator. */
export interface BridgeNavigationSink {
  wheelZoom(factor: number, screen: Point): void;
  pan(delta: Point): void;
}

let sceneGenerationSequence = 0;

export interface FrameProbeResult {
  readonly frames: number;
  readonly p95FrameTimeMs: number;
  readonly p95DrawTimeMs: number;
  readonly meanFrameTimeMs: number;
  readonly maxFrameTimeMs: number;
  readonly modelNodes: number;
  readonly visibleNodes: number;
  readonly drawCalls: number;
  readonly liveLabels: number;
  readonly bitmapLabelCount: number;
  readonly fallbackLabelCount: number;
  readonly omittedLabelCount: number;
}

export interface StudioSceneBridgeOptions {
  readonly sceneFactory?: SceneFactory;
  readonly now?: () => number;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  /** When it returns a sink, wheel and drag input is semantic (ADR-0025) and
   * routes through the NavigationController instead of the raw camera. */
  readonly navigation?: () => BridgeNavigationSink | null;
}

function viewportOf(canvas: HTMLCanvasElement): ViewportSize {
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.max(0, rect.width || canvas.clientWidth || canvas.width),
    height: Math.max(0, rect.height || canvas.clientHeight || canvas.height),
  };
}

function sameCamera(left: CameraState, right: CameraState): boolean {
  return (
    left.center.x === right.center.x &&
    left.center.y === right.center.y &&
    left.scale === right.scale
  );
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

export class StudioSceneBridge {
  readonly sceneGeneration = ++sceneGenerationSequence;
  private readonly commands: StudioStoreCommands;
  private readonly sceneFactory: SceneFactory;
  private readonly now: () => number;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private scene: SceneAdapter | null = null;
  private camera: CameraController | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private storeUnsubscribe: (() => void) | null = null;
  private rendererUnsubscribes: Unsubscribe[] = [];
  private cameraUnsubscribe: Unsubscribe | null = null;
  private latestModel: RenderModel | null = null;
  private latestSourceGeneration: number | null = null;
  private fittedSourceGeneration: number | null = null;
  private ready = false;
  private destroyed = false;
  private syncingFromStore = false;
  private publishCameraFrame: number | null = null;
  private dragPoint: Point | null = null;
  private loseContextExtension: WEBGL_lose_context | null = null;
  private readonly navigation: () => BridgeNavigationSink | null;

  constructor(
    readonly store: StudioStore,
    options: StudioSceneBridgeOptions = {},
  ) {
    this.commands = new StudioStoreCommands(store);
    this.sceneFactory = options.sceneFactory ?? createScene;
    this.now = options.now ?? (() => performance.now());
    this.requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.navigation = options.navigation ?? (() => null);
  }

  async mount(canvas: HTMLCanvasElement): Promise<void> {
    if (this.canvas !== null) throw new Error('StudioSceneBridge.mount is single-use');
    this.canvas = canvas;
    const viewport = viewportOf(canvas);
    const win = canvas.ownerDocument.defaultView;
    this.camera = createCameraController({
      initialState: this.store.getState().camera,
      viewport,
      devicePixelRatio: win?.devicePixelRatio ?? 1,
    });
    this.cameraUnsubscribe = this.camera.on('change', (camera) => this.cameraChanged(camera));
    this.scene = this.sceneFactory({ fontUrl: '/fonts/meridian-msdf.fnt' });
    this.bindRendererEvents(this.scene);
    this.storeUnsubscribe = this.store.subscribe((state, previous) => {
      if (state.camera !== previous.camera && !sameCamera(state.camera, this.camera!.state())) {
        this.syncCameraFromStore(state.camera);
      }
    });
    this.addInputListeners(canvas);
    this.observeResize(canvas);
    this.commands.setViewport(viewport);

    try {
      await this.scene.mount(canvas);
      if (this.destroyed) return;
      this.ready = true;
      if (this.latestModel !== null) {
        this.modelChanged(this.latestModel, this.latestSourceGeneration);
      }
    } catch (error) {
      if (!this.destroyed) {
        this.commands.rendererFault({
          code: 'mount-failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private bindRendererEvents(scene: SceneAdapter): void {
    this.rendererUnsubscribes = [
      scene.on('hover', (element) => {
        this.commands.setHover(this.sceneGeneration, element, this.now());
      }),
      scene.on('select', (element) => {
        this.commands.select(element, this.now());
      }),
      scene.on('fault', (fault) => this.commands.rendererFault(fault)),
      scene.on('stats', (stats) => {
        this.commands.rendererFrame(stats, this.now());
        this.sampleHeap();
      }),
    ];
  }

  private modelChanged(model: RenderModel | null, sourceGeneration: number | null): void {
    const previous = this.latestModel;
    this.latestModel = model;
    this.latestSourceGeneration = sourceGeneration;
    this.commands.clearHover(this.sceneGeneration);
    if (!this.ready || model === null || this.scene === null || this.camera === null) return;
    if (sourceGeneration !== null && sourceGeneration !== this.fittedSourceGeneration) {
      this.fittedSourceGeneration = sourceGeneration;
      // With a 6D navigator active the boot camera is the controller's
      // (ADR-0025 scale↔z coupling); auto-fit would desynchronize z.
      if (this.store.getState().nav === null) {
        this.camera.fitToBounds(model.nodeIds.length === 0 ? null : model.bounds, { padding: 64 });
      }
    }
    this.renderScene(model, this.camera.state(), previous);
  }

  private renderScene(
    model: RenderModel,
    camera: CameraState,
    previous: RenderModel | null,
  ): void {
    if (
      previous !== null &&
      previous.revision !== model.revision &&
      this.scene?.patch !== undefined
    ) {
      this.scene.patch(diffRenderModels(previous, model), camera);
      return;
    }
    this.scene?.render(model, camera);
  }

  /** Settled map-model ingress owned by MapProjection's node-link port. */
  acceptSettledModel(model: RenderModel | null, sourceGeneration: number | null): void {
    if (this.destroyed) throw new Error('StudioSceneBridge.acceptSettledModel called after destroy');
    this.modelChanged(model, sourceGeneration);
  }

  private cameraChanged(camera: CameraState): void {
    if (this.ready && this.latestModel !== null && this.scene !== null) {
      this.scene.render(this.latestModel, camera);
    }
    if (this.syncingFromStore || this.destroyed) return;
    if (this.publishCameraFrame !== null) return;
    this.publishCameraFrame = this.requestFrame(() => {
      this.publishCameraFrame = null;
      if (!this.destroyed && this.camera !== null) this.commands.setCamera(this.camera.state());
    });
  }

  private syncCameraFromStore(target: CameraState): void {
    const camera = this.camera;
    if (camera === null) return;
    this.syncingFromStore = true;
    try {
      let current = camera.state();
      const viewport = camera.viewport();
      camera.zoomAt(
        { x: viewport.width / 2, y: viewport.height / 2 },
        target.scale / current.scale,
      );
      current = camera.state();
      camera.panBy({
        x: (current.center.x - target.center.x) * current.scale,
        y: (current.center.y - target.center.y) * current.scale,
      });
      if (this.ready && this.latestModel !== null && this.scene !== null) {
        this.scene.render(this.latestModel, camera.state());
      }
    } finally {
      this.syncingFromStore = false;
    }
  }

  private observeResize(canvas: HTMLCanvasElement): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.camera === null) return;
      const win = canvas.ownerDocument.defaultView;
      const viewport = viewportOf(canvas);
      this.camera.resize(viewport, win?.devicePixelRatio ?? 1);
      this.commands.setViewport(viewport);
    });
    this.resizeObserver.observe(canvas);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.dragPoint = { x: event.clientX, y: event.clientY };
    this.canvas?.setPointerCapture?.(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.dragPoint === null || this.camera === null) return;
    const delta = {
      x: event.clientX - this.dragPoint.x,
      y: event.clientY - this.dragPoint.y,
    };
    this.dragPoint = { x: event.clientX, y: event.clientY };
    const sink = this.navigation();
    if (sink !== null) {
      sink.pan(delta);
      return;
    }
    this.camera.panBy(delta);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    this.dragPoint = null;
    if (this.canvas?.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.camera === null || this.canvas === null) return;
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const factor = Math.exp(-event.deltaY * 0.0015);
    const sink = this.navigation();
    if (sink !== null) {
      // ADR-0025: wheel is the continuous-zoom verb — semantic, may move the cut.
      sink.wheelZoom(factor, screen);
      return;
    }
    this.camera.zoomAt(screen, factor);
  };

  private addInputListeners(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerUp);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  private removeInputListeners(): void {
    const canvas = this.canvas;
    if (canvas === null) return;
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerUp);
    canvas.removeEventListener('wheel', this.handleWheel);
  }

  fit(): void {
    if (this.camera === null || this.latestModel === null) return;
    this.camera.fitToBounds(
      this.latestModel.nodeIds.length === 0 ? null : this.latestModel.bounds,
      { padding: 64 },
    );
  }

  zoomBy(factor: number): void {
    const camera = this.camera;
    if (camera === null) throw new Error('Studio scene is not mounted');
    const viewport = camera.viewport();
    camera.zoomAt({ x: viewport.width / 2, y: viewport.height / 2 }, factor);
  }

  setScale(scale: number): void {
    const camera = this.camera;
    if (camera === null) throw new Error('Studio scene is not mounted');
    this.zoomBy(scale / camera.state().scale);
  }

  screenPointForNode(nodeId: string): Point | null {
    const model = this.latestModel;
    const camera = this.camera;
    if (model === null || camera === null) return null;
    const index = model.nodeIds.findIndex((id) => id === nodeId);
    if (index < 0) return null;
    const lane = index * 4;
    return worldToScreen(
      {
        x: model.nodeRects[lane]! + model.nodeRects[lane + 2]! / 2,
        y: model.nodeRects[lane + 1]! + model.nodeRects[lane + 3]! / 2,
      },
      camera.state(),
      camera.viewport(),
    );
  }

  /** Serializable map-local state used by projection switching. */
  captureViewState(): {
    readonly camera: {
      readonly center: { readonly x: number; readonly y: number };
      readonly scale: number;
    };
  } {
    const camera = this.camera?.state() ?? this.store.getState().camera;
    return {
      camera: {
        center: { x: camera.center.x, y: camera.center.y },
        scale: camera.scale,
      },
    };
  }

  restoreViewState(state: unknown): void {
    if (this.destroyed) throw new Error('StudioSceneBridge.restoreViewState called after destroy');
    if (typeof state !== 'object' || state === null || !('camera' in state)) {
      throw new TypeError('Studio map view state is missing camera');
    }
    const candidate = (state as { readonly camera?: unknown }).camera;
    if (typeof candidate !== 'object' || candidate === null || !('center' in candidate)) {
      throw new TypeError('Studio map view state has an invalid camera');
    }
    const camera = candidate as {
      readonly center?: { readonly x?: unknown; readonly y?: unknown };
      readonly scale?: unknown;
    };
    const x = camera.center?.x;
    const y = camera.center?.y;
    const scale = camera.scale;
    if (
      typeof x !== 'number' || !Number.isFinite(x) ||
      typeof y !== 'number' || !Number.isFinite(y) ||
      typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0
    ) {
      throw new TypeError('Studio map view state has a non-finite camera');
    }
    this.commands.setCamera({ center: { x, y }, scale });
  }

  /** Make an identity target visible without changing scale when it is already
   * on-screen. Hidden/non-cut identities intentionally remain untouched. */
  revealNode(nodeId: string | null): void {
    if (nodeId === null || this.latestModel === null || this.camera === null) return;
    const index = this.latestModel.nodeIds.findIndex((id) => id === nodeId);
    if (index < 0) return;
    const lane = index * 4;
    const world = {
      x: this.latestModel.nodeRects[lane]! + this.latestModel.nodeRects[lane + 2]! / 2,
      y: this.latestModel.nodeRects[lane + 1]! + this.latestModel.nodeRects[lane + 3]! / 2,
    };
    const viewport = this.camera.viewport();
    const screen = worldToScreen(world, this.camera.state(), viewport);
    if (screen.x >= 0 && screen.x <= viewport.width && screen.y >= 0 && screen.y <= viewport.height) {
      return;
    }
    const current = this.camera.state();
    this.commands.setCamera({ center: world, scale: current.scale });
  }

  /** Render one transition frame (ADR-0022: the player's only pixel path).
   * Transient models never enter the store; the settled model is published by
   * the navigator at flight end. */
  renderTransient(model: RenderModel, camera: CameraState): void {
    if (!this.ready || this.scene === null) return;
    const previous = this.latestModel;
    this.latestModel = model;
    this.renderScene(model, camera, previous);
  }

  /** Current canvas viewport in CSS px (the navigator's camera-math input). */
  viewportSize(): ViewportSize {
    const camera = this.camera;
    if (camera === null) return { width: 0, height: 0 };
    const viewport = camera.viewport();
    return { width: viewport.width, height: viewport.height };
  }

  stats(): Readonly<RendererStats> | null {
    return this.scene?.stats() ?? null;
  }

  loseContext(): boolean {
    const gl = this.canvas?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (extension === null || extension === undefined) return false;
    // getExtension() returns null on a lost context, so restoreContext()
    // can only work through the handle taken before the loss.
    this.loseContextExtension = extension;
    extension.loseContext();
    return true;
  }

  restoreContext(): boolean {
    const extension =
      this.loseContextExtension ??
      this.canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (extension === null || extension === undefined) return false;
    extension.restoreContext();
    return true;
  }

  async runFrameProbe(frames = 300, warmup = 60): Promise<FrameProbeResult> {
    if (!this.ready || this.camera === null || this.scene === null || this.latestModel === null) {
      throw new Error('Studio scene is not ready');
    }
    this.fit();
    // Exercise the label path, not just a tiny-label overview.
    if (this.camera.state().scale < 0.65) this.setScale(0.65);

    const frameIntervals: number[] = [];
    const drawTimes: number[] = [];
    const off = this.scene.on('stats', (stats) => drawTimes.push(stats.frameTimeMs));
    let previousTimestamp: number | null = null;
    let index = 0;
    await new Promise<void>((resolve) => {
      const step = (timestamp: number): void => {
        if (previousTimestamp !== null && index >= warmup) {
          frameIntervals.push(timestamp - previousTimestamp);
        }
        previousTimestamp = timestamp;
        this.camera!.panBy({
          x: Math.sin(index * 0.17) * 8,
          y: Math.cos(index * 0.13) * 6,
        });
        if (index > 0 && index % 24 === 0) {
          const viewport = this.camera!.viewport();
          this.camera!.zoomAt(
            { x: viewport.width / 2, y: viewport.height / 2 },
            index % 48 === 0 ? 1.08 : 1 / 1.08,
          );
        }
        index++;
        if (index >= frames + warmup) resolve();
        else this.requestFrame(step);
      };
      this.requestFrame(step);
    });
    off();
    const measuredDrawTimes = drawTimes.slice(Math.min(warmup, drawTimes.length));
    const stats = this.scene.stats();
    return {
      frames: frameIntervals.length,
      p95FrameTimeMs: percentile95(frameIntervals),
      p95DrawTimeMs: percentile95(measuredDrawTimes),
      meanFrameTimeMs:
        frameIntervals.reduce((sum, value) => sum + value, 0) / Math.max(1, frameIntervals.length),
      maxFrameTimeMs: Math.max(0, ...frameIntervals),
      modelNodes: stats.modelNodes,
      visibleNodes: stats.visibleNodes,
      drawCalls: stats.drawCalls,
      liveLabels: stats.liveLabels,
      bitmapLabelCount: stats.bitmapLabelCount,
      fallbackLabelCount: stats.fallbackLabelCount,
      omittedLabelCount: stats.omittedLabelCount,
    };
  }

  private sampleHeap(): void {
    if (!this.store.getState().debugEnabled) return;
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    this.commands.sampleHeap(memory?.usedJSHeapSize ?? null);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ready = false;
    this.commands.clearHover(this.sceneGeneration);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.removeInputListeners();
    this.storeUnsubscribe?.();
    this.storeUnsubscribe = null;
    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;
    if (this.publishCameraFrame !== null) this.cancelFrame(this.publishCameraFrame);
    this.publishCameraFrame = null;
    for (const unsubscribe of this.rendererUnsubscribes) unsubscribe();
    this.rendererUnsubscribes = [];
    this.scene?.destroy();
    this.scene = null;
    this.camera?.destroy();
    this.camera = null;
    this.canvas = null;
    this.latestModel = null;
    this.latestSourceGeneration = null;
  }
}
