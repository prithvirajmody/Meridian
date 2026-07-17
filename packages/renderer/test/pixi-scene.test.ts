import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffRenderModels, type RenderModel } from '@meridian/view-model';
import { buildSpatialIndex } from '../src/spatial-index/build.js';
import type { SpatialIndexWorkerEndpoint } from '../src/spatial-index/host.js';
import type { SpatialIndexWorkerRequest } from '../src/spatial-index/protocol.js';
import type {
  PickResult,
  RendererFault,
  RendererStats,
  SceneAdapter,
  SceneOptions,
} from '../src/types.js';

interface GeometryRecord {
  label: string;
  instanceCount: number;
  destroyed: boolean;
}

const gpuLog = vi.hoisted(() => ({
  renderedFrames: 0,
  rendererInits: 0,
  rendererDestroys: 0,
  bufferCreations: 0,
  bufferUpdates: 0,
  geometryCreations: 0,
  geometryDestroys: 0,
  shaderCreations: 0,
  shaderDestroys: 0,
  rendererInitOptions: undefined as Readonly<Record<string, unknown>> | undefined,
  rendererInitResolutions: [] as number[],
  createdGeometries: [] as GeometryRecord[],
  nodeRectUpdates: [] as number[][],
}));

vi.mock('pixi.js', () => {
  class FakeBuffer {
    private readonly data?: Float32Array;
    private readonly label: string;

    constructor(options: { readonly data?: Float32Array; readonly label?: string }) {
      gpuLog.bufferCreations += 1;
      this.data = options.data;
      this.label = options.label ?? '';
    }

    update(): void {
      gpuLog.bufferUpdates += 1;
      if (this.label.startsWith('meridian-node-rects-') && this.data !== undefined) {
        gpuLog.nodeRectUpdates.push(Array.from(this.data.slice(0, 4)));
      }
    }

    destroy(): void {}
  }

  class FakeGeometry {
    label: string;
    instanceCount: number;
    destroyed = false;

    constructor(options: { readonly label?: string; readonly instanceCount?: number }) {
      this.label = options.label ?? '';
      this.instanceCount = options.instanceCount ?? 0;
      gpuLog.geometryCreations += 1;
      gpuLog.createdGeometries.push(this);
    }

    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      gpuLog.geometryDestroys += 1;
    }
  }

  class FakeShader {
    static from(): FakeShader {
      gpuLog.shaderCreations += 1;
      return new FakeShader();
    }

    destroy(): void {
      gpuLog.shaderDestroys += 1;
    }
  }

  class FakeMesh {
    readonly geometry: FakeGeometry;
    visible = true;

    constructor(options: { readonly geometry: FakeGeometry }) {
      this.geometry = options.geometry;
    }

    destroy(): void {}
  }

  class FakeContainer {
    label = '';
    children: unknown[] = [];
    readonly scale = { set: (_x: number, _y: number): void => {} };
    readonly position = { set: (_x: number, _y: number): void => {} };

    addChild(child: unknown): void {
      this.children.push(child);
    }

    removeChildren(): void {
      this.children = [];
    }

    destroy(): void {}
  }

  class FakeLabel {
    text: string;
    tint = 0xffffff;
    visible = true;
    readonly position = { set: (_x: number, _y: number): void => {} };
    readonly anchor = { set: (_v: number): void => {} };
    constructor(options: { text?: string } = {}) {
      this.text = options.text ?? '';
    }
    destroy(): void {}
  }

  const Assets = {
    load: async (): Promise<{ fontFamily: string }> => ({ fontFamily: 'DejaVuSans' }),
  };

  class FakeWebGLRenderer {
    async init(options: Readonly<Record<string, unknown>>): Promise<void> {
      gpuLog.rendererInits += 1;
      gpuLog.rendererInitOptions = options;
      gpuLog.rendererInitResolutions.push(Number(options.resolution));
    }

    render(): void {
      gpuLog.renderedFrames += 1;
    }

    resize(): void {}

    destroy(): void {
      gpuLog.rendererDestroys += 1;
    }
  }

  return {
    Assets,
    BitmapText: FakeLabel,
    Buffer: FakeBuffer,
    BufferUsage: { VERTEX: 0x20, COPY_DST: 0x8 },
    Container: FakeContainer,
    Geometry: FakeGeometry,
    Mesh: FakeMesh,
    Shader: FakeShader,
    Text: FakeLabel,
    WebGLRenderer: FakeWebGLRenderer,
  };
});

const { createScene } = await import('../src/index.js');
const { PixiScene } = await import('../src/pixi/pixi-scene.js');

type FrameCallback = (time: number) => void;
type NodeId = RenderModel['nodeIds'][number];
type RectTuple = readonly [x: number, y: number, width: number, height: number];
type EdgeTuple = readonly [source: number, target: number];

interface CanvasHarness {
  readonly canvas: HTMLCanvasElement;
  flushFrames(): number;
  pendingFrames(): number;
  canceledFrames(): number;
}

function fakeCanvas(
  width = 300,
  height = 100,
  options: { devicePixelRatio?: number; left?: number; top?: number } = {},
): CanvasHarness {
  const frameQueue = new Map<number, FrameCallback>();
  let nextFrameHandle = 1;
  let cancellationCount = 0;
  const view = {
    devicePixelRatio: options.devicePixelRatio ?? 1,
    requestAnimationFrame(callback: FrameCallback): number {
      const handle = nextFrameHandle;
      nextFrameHandle += 1;
      frameQueue.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle: number): void {
      if (frameQueue.delete(handle)) cancellationCount += 1;
    },
  };

  class CanvasTarget extends EventTarget {
    readonly clientWidth = width;
    readonly clientHeight = height;
    readonly width = width * view.devicePixelRatio;
    readonly height = height * view.devicePixelRatio;
    readonly ownerDocument = { defaultView: view };

    getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
      return { width, height, left: options.left ?? 0, top: options.top ?? 0 };
    }
  }

  return {
    canvas: new CanvasTarget() as unknown as HTMLCanvasElement,
    flushFrames(): number {
      const callbacks = [...frameQueue.values()];
      frameQueue.clear();
      for (const callback of callbacks) callback(0);
      return callbacks.length;
    },
    pendingFrames: () => frameQueue.size,
    canceledFrames: () => cancellationCount,
  };
}

function boundsOf(rects: readonly RectTuple[]): RenderModel['bounds'] {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...rects.map(([x]) => x));
  const minY = Math.min(...rects.map(([, y]) => y));
  const maxX = Math.max(...rects.map(([x, , width]) => x + width));
  const maxY = Math.max(...rects.map(([, y, , height]) => y + height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function modelOf(
  revision: string,
  rects: readonly RectTuple[],
  edges: readonly EdgeTuple[] = [],
): RenderModel {
  const nodeIds = rects.map((_, index) => `n-${index}` as NodeId);
  return {
    revision,
    bounds: boundsOf(rects),
    nodeIds,
    nodeRects: Float64Array.from(rects.flat()),
    nodeColorKeys: ['node'],
    nodeColorIds: new Uint16Array(rects.length),
    nodeFlags: new Uint8Array(rects.length),
    nodeCoveredLeaves: new Float64Array(rects.length).fill(1),
    nodeDegrees: new Uint32Array(rects.length).fill(1),
    labelTable: nodeIds,
    labelRefs: Uint32Array.from(nodeIds.map((_, index) => index)),
    labelClasses: new Uint8Array(rects.length),
    edgeKeys: edges.map(([source, target]) => `n-${source}→n-${target}→test:edge`),
    edgeIndices: Uint32Array.from(edges.flat()),
    edgeColorKeys: edges.length === 0 ? [] : ['test:edge'],
    edgeColorIds: new Uint16Array(edges.length),
    edgeWeights: new Float64Array(edges.length).fill(1),
    edgeMultiplicities: new Uint32Array(edges.length).fill(1),
    edgeFlags: new Uint8Array(edges.length),
    edgeRouteOffsets: new Uint32Array(edges.length + 1),
    edgeRoutePoints: new Float64Array(),
    diagnostics: [],
  };
}

function initialModel(): RenderModel {
  return modelOf(
    'scene-revision-1',
    [
      [0, 0, 10, 10],
      [20, 0, 10, 10],
    ],
    [[0, 1]],
  );
}

function latestModel(): RenderModel {
  return modelOf(
    'scene-revision-2',
    [
      [0, 0, 10, 10],
      [20, 0, 10, 10],
      [1_000, 0, 10, 10],
      [1_020, 0, 10, 10],
    ],
    [
      [0, 1],
      [2, 3],
    ],
  );
}

function resetGpuLog(): void {
  gpuLog.renderedFrames = 0;
  gpuLog.rendererInits = 0;
  gpuLog.rendererDestroys = 0;
  gpuLog.bufferCreations = 0;
  gpuLog.bufferUpdates = 0;
  gpuLog.geometryCreations = 0;
  gpuLog.geometryDestroys = 0;
  gpuLog.shaderCreations = 0;
  gpuLog.shaderDestroys = 0;
  gpuLog.rendererInitOptions = undefined;
  gpuLog.rendererInitResolutions = [];
  gpuLog.createdGeometries = [];
  gpuLog.nodeRectUpdates = [];
}

function gpuWorkSnapshot(): Readonly<Record<string, number>> {
  return {
    renderedFrames: gpuLog.renderedFrames,
    bufferCreations: gpuLog.bufferCreations,
    bufferUpdates: gpuLog.bufferUpdates,
    geometryCreations: gpuLog.geometryCreations,
    geometryDestroys: gpuLog.geometryDestroys,
    shaderCreations: gpuLog.shaderCreations,
    shaderDestroys: gpuLog.shaderDestroys,
  };
}

const OVERVIEW_CAMERA = { center: { x: 515, y: 5 }, scale: 0.25 };
const CLOSE_UP_CAMERA = { center: { x: 15, y: 5 }, scale: 10 };
const activeScenes: SceneAdapter[] = [];

function trackedScene(options: SceneOptions = {}): SceneAdapter {
  const scene = createScene(options);
  activeScenes.push(scene);
  return scene;
}

beforeEach(() => {
  resetGpuLog();
});

afterEach(() => {
  for (const scene of activeScenes.splice(0)) scene.destroy();
});

describe('PixiScene public rendering seam', () => {
  it('applies a same-topology style patch without rebuilding scene geometry', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene();
    await scene.mount(canvas);
    flushFrames();
    const previous = modelOf('patch-before', [[0, 0, 10, 10]]);
    scene.render(previous, CLOSE_UP_CAMERA);
    flushFrames();
    const geometryCreations = gpuLog.geometryCreations;

    const flags = previous.nodeFlags.slice();
    flags[0] = 1;
    const next: RenderModel = { ...previous, revision: 'patch-after', nodeFlags: flags };
    scene.patch!(diffRenderModels(previous, next), CLOSE_UP_CAMERA);
    flushFrames();

    expect(gpuLog.geometryCreations).toBe(geometryCreations);
    expect(scene.stats()).toMatchObject({
      modelRevision: 'patch-after',
      fullModelRebuilds: 1,
      renderPatches: 1,
      patchChangedNodes: 1,
      patchChangedEdges: 0,
    });
  });

  it('restarts a pending spatial-index build when a style patch changes its revision', async () => {
    const requests: SpatialIndexWorkerRequest[] = [];
    let postToHost: (message: unknown) => void = () => undefined;
    const endpoint: SpatialIndexWorkerEndpoint = {
      postMessage: (message) => { requests.push(message); },
      onMessage: (listener) => {
        postToHost = listener;
        return () => { if (postToHost === listener) postToHost = () => undefined; };
      },
      onError: () => () => undefined,
      terminate: () => undefined,
    };
    const scene = new PixiScene({}, () => endpoint);
    activeScenes.push(scene);
    const { canvas, flushFrames } = fakeCanvas();
    await scene.mount(canvas);
    flushFrames();

    const previous = modelOf('pending-index-before', [[0, 0, 10, 10]]);
    scene.render(previous, { center: { x: 0, y: 0 }, scale: 1 });
    expect(scene.pick({ x: 155, y: 55 })).toBeNull();
    const flags = previous.nodeFlags.slice();
    flags[0] = 1;
    const next = { ...previous, revision: 'pending-index-after', nodeFlags: flags };
    scene.patch!(diffRenderModels(previous, next), { center: { x: 0, y: 0 }, scale: 1 });

    const builds = requests.filter((request) => request.type === 'build');
    expect(builds.map((request) => request.modelRevision)).toEqual([
      'pending-index-before',
      'pending-index-after',
    ]);
    expect(requests.some((request) => request.type === 'cancel')).toBe(true);
    postToHost(buildSpatialIndex(builds.at(-1)!));
    await Promise.resolve();
    expect(scene.pick({ x: 155, y: 55 })).toMatchObject({ kind: 'node', nodeId: 'n-0' });
  });

  it('reports fewer public draw calls and visible primitives from overview to close-up', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene: SceneAdapter = trackedScene({ maxBatchSize: 1 });
    const statsFrames: RendererStats[] = [];
    scene.on('stats', (stats) => statsFrames.push(stats));

    await scene.mount(canvas);
    flushFrames();
    scene.render(latestModel(), OVERVIEW_CAMERA);
    expect(flushFrames()).toBe(1);
    const overview = scene.stats();

    scene.render(latestModel(), CLOSE_UP_CAMERA);
    expect(flushFrames()).toBe(1);
    const closeUp = scene.stats();

    expect(overview).toMatchObject({
      drawCalls: 6,
      modelNodes: 4,
      visibleNodes: 4,
      culledNodes: 0,
      modelEdges: 2,
      visibleEdges: 2,
    });
    expect(closeUp).toMatchObject({
      drawCalls: 3,
      modelNodes: 4,
      visibleNodes: 2,
      culledNodes: 2,
      modelEdges: 2,
      visibleEdges: 1,
    });
    expect(closeUp.drawCalls).toBeLessThan(overview.drawCalls);
    expect(closeUp.visibleNodes).toBeLessThan(overview.visibleNodes);
    expect(closeUp.visibleEdges).toBeLessThan(overview.visibleEdges);
    expect(statsFrames.at(-1)).toEqual(closeUp);
  });

  it('renders a zero-node model without GPU batches or a fault', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene();
    const faults: RendererFault[] = [];
    scene.on('fault', (fault) => faults.push(fault));

    await scene.mount(canvas);
    flushFrames();
    const framesBeforeRender = gpuLog.renderedFrames;
    scene.render(modelOf('empty-revision', []), CLOSE_UP_CAMERA);

    expect(flushFrames()).toBe(1);
    expect(gpuLog.renderedFrames).toBe(framesBeforeRender + 1);
    expect(gpuLog.createdGeometries).toEqual([]);
    expect(scene.stats()).toMatchObject({
      drawCalls: 0,
      modelNodes: 0,
      visibleNodes: 0,
      culledNodes: 0,
      modelEdges: 0,
      visibleEdges: 0,
    });
    expect(faults).toEqual([]);
  });

  it('draws a zero-size layout node as the same 6x6 CSS-pixel marker used for picking', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene();
    await scene.mount(canvas);
    flushFrames();

    scene.render(modelOf('zero-size-revision', [[0, 0, 0, 0]]), {
      center: { x: 0, y: 0 },
      scale: 2,
    });
    flushFrames();

    const uploaded = gpuLog.nodeRectUpdates.at(-1);
    expect(uploaded).toEqual([-1.5, -1.5, 3, 3]);
    expect(uploaded![2]! * 2).toBe(6);
    expect(uploaded![3]! * 2).toBe(6);
  });

  it('uploads overlapping cross-Morton batches in the same topmost order as picking', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene({ maxBatchSize: 1 });
    const camera = { center: { x: 70, y: 50 }, scale: 1 };
    const overlapping = modelOf('overlap-draw-order', [
      [40, 0, 100, 100], // index 0; Morton would submit this batch last
      [0, 0, 100, 100],  // index 1; picking says greater index is topmost
    ]);
    await scene.mount(canvas);
    flushFrames();

    scene.render(overlapping, camera);
    flushFrames();

    // Node meshes are submitted in child order and instances in array order.
    // The last upload is therefore the painted/pickable top node (index 1).
    expect(gpuLog.nodeRectUpdates.slice(-2).map((rect) => rect[0])).toEqual([40, 0]);
    expect(scene.pick({ x: 140, y: 50 })).toMatchObject({ kind: 'node', nodeId: 'n-1' });
    expect(scene.stats()).toMatchObject({ submittedNodeBatches: 2, drawCalls: 2 });
  });
});

describe('PixiScene context loss auto-restore (ADR-0019)', () => {
  it('cancels a pending animation frame as soon as the context is lost', async () => {
    const { canvas, flushFrames, pendingFrames, canceledFrames } = fakeCanvas();
    const scene = trackedScene();
    await scene.mount(canvas);
    expect(pendingFrames()).toBe(1);

    const lossEvent = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(lossEvent);

    expect(lossEvent.defaultPrevented).toBe(true);
    expect(pendingFrames()).toBe(0);
    expect(canceledFrames()).toBe(1);
    expect(flushFrames()).toBe(0);
    expect(gpuLog.renderedFrames).toBe(0);
  });

  it('counts and emits duplicate context-loss notifications only once', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene();
    const faults: RendererFault[] = [];
    scene.on('fault', (fault) => faults.push(fault));
    await scene.mount(canvas);
    flushFrames();

    const first = new Event('webglcontextlost', { cancelable: true });
    const duplicate = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(first);
    canvas.dispatchEvent(duplicate);

    expect(first.defaultPrevented).toBe(true);
    expect(duplicate.defaultPrevented).toBe(true);
    expect(scene.stats().contextLosses).toBe(1);
    expect(faults).toEqual([expect.objectContaining({ code: 'context-lost' })]);
  });

  it('does no GPU work for a new model revision while the context is lost', async () => {
    const { canvas, flushFrames, pendingFrames } = fakeCanvas();
    const scene = trackedScene({ maxBatchSize: 1 });
    await scene.mount(canvas);
    scene.render(initialModel(), OVERVIEW_CAMERA);
    flushFrames();
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    const workAtLoss = gpuWorkSnapshot();

    scene.render(latestModel(), OVERVIEW_CAMERA);

    expect(gpuWorkSnapshot()).toEqual(workAtLoss);
    expect(pendingFrames()).toBe(0);
    expect(flushFrames()).toBe(0);
  });

  it('rebuilds resources and renders the retained latest revision after restore', async () => {
    const { canvas, flushFrames, pendingFrames } = fakeCanvas();
    const scene = trackedScene({ maxBatchSize: 1 });
    const faults: RendererFault[] = [];
    const statsFrames: RendererStats[] = [];
    scene.on('fault', (fault) => faults.push(fault));
    scene.on('stats', (stats) => statsFrames.push(stats));
    await scene.mount(canvas);
    scene.render(initialModel(), OVERVIEW_CAMERA);
    flushFrames();
    const framesBeforeLoss = gpuLog.renderedFrames;

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    scene.render(latestModel(), OVERVIEW_CAMERA);
    const liveBeforeRestore = gpuLog.createdGeometries.filter(({ destroyed }) => !destroyed);
    const geometryCountBeforeRestore = gpuLog.createdGeometries.length;

    canvas.dispatchEvent(new Event('webglcontextrestored'));

    expect(liveBeforeRestore).not.toHaveLength(0);
    expect(liveBeforeRestore.every(({ destroyed }) => destroyed)).toBe(true);
    expect(gpuLog.createdGeometries.length).toBeGreaterThan(geometryCountBeforeRestore);
    expect(pendingFrames()).toBe(1);
    expect(gpuLog.renderedFrames).toBe(framesBeforeLoss);
    expect(flushFrames()).toBe(1);

    const restoredStats = scene.stats();
    expect(gpuLog.renderedFrames).toBe(framesBeforeLoss + 1);
    expect(restoredStats).toMatchObject({
      drawCalls: 6,
      modelNodes: 4,
      visibleNodes: 4,
      modelEdges: 2,
      visibleEdges: 2,
      contextLosses: 1,
    });
    const freshGeometries = gpuLog.createdGeometries.slice(geometryCountBeforeRestore);
    expect(freshGeometries.some(({ destroyed }) => !destroyed)).toBe(true);
    expect(freshGeometries.some(({ instanceCount }) => instanceCount > 0)).toBe(true);
    expect(faults).toEqual([expect.objectContaining({ code: 'context-lost' })]);
    expect(statsFrames.at(-1)).toEqual(restoredStats);
  });
});

describe('PixiScene lifecycle', () => {
  it('keeps mount single-use and destroy idempotent', async () => {
    const { canvas, pendingFrames } = fakeCanvas();
    const scene = trackedScene();

    expect(() => scene.render(initialModel(), OVERVIEW_CAMERA)).toThrow(
      'requires a mounted scene',
    );
    expect(() => scene.pick({ x: 0, y: 0 })).toThrow('requires a mounted scene');

    await scene.mount(canvas);
    expect(gpuLog.rendererInitOptions).toMatchObject({
      skipExtensionImports: true,
      preferWebGLVersion: 2,
    });
    await expect(scene.mount(canvas)).rejects.toThrow('mount is single-use');
    expect(pendingFrames()).toBe(1);

    scene.destroy();
    const afterFirstDestroy = {
      rendererDestroys: gpuLog.rendererDestroys,
      shaderDestroys: gpuLog.shaderDestroys,
      pendingFrames: pendingFrames(),
    };
    scene.destroy();

    expect(afterFirstDestroy).toEqual({
      rendererDestroys: 1,
      shaderDestroys: 2,
      pendingFrames: 0,
    });
    expect({
      rendererDestroys: gpuLog.rendererDestroys,
      shaderDestroys: gpuLog.shaderDestroys,
      pendingFrames: pendingFrames(),
    }).toEqual(afterFirstDestroy);
    expect(() => scene.render(initialModel(), OVERVIEW_CAMERA)).toThrow(
      'requires a mounted scene',
    );
    expect(() => scene.pick({ x: 0, y: 0 })).toThrow('requires a mounted scene');
    expect(() => scene.on('stats', () => {})).toThrow('cannot subscribe to a destroyed scene');
  });
});

describe('PixiScene picking, hover, and label stats (ADR-0020/0021)', () => {
  const CAMERA = { center: { x: 0, y: 0 }, scale: 1 };
  const oneNode = (revision = 'pick-rev-1'): RenderModel =>
    modelOf(revision, [[0, 0, 10, 10]]);

  function pointer(type: string, clientX: number, clientY: number): Event {
    const event = new Event(type) as Event & { clientX: number; clientY: number; pointerId: number };
    event.clientX = clientX;
    event.clientY = clientY;
    event.pointerId = 1;
    return event;
  }

  it('returns null from pick before any index is available', async () => {
    const { canvas } = fakeCanvas();
    const scene = trackedScene();
    await scene.mount(canvas);
    expect(scene.pick({ x: 155, y: 55 })).toBeNull();
  });

  it('picks the node under a canvas-local point once rendered', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene();
    await scene.mount(canvas);
    flushFrames();
    scene.render(oneNode(), CAMERA);
    expect(scene.pick({ x: 155, y: 55 })).toMatchObject({ kind: 'node', nodeId: 'n-0' });
    expect(scene.pick({ x: 250, y: 55 })).toBeNull();
    expect(scene.stats().pickQueryTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('reflects a model revision change and never answers from a stale index', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene();
    await scene.mount(canvas);
    flushFrames();
    scene.render(oneNode(), CAMERA);
    expect(scene.pick({ x: 155, y: 55 })).toMatchObject({ kind: 'node', nodeId: 'n-0' });
    // The node is gone in the next revision; a stale hit here would be a bug.
    scene.render(modelOf('pick-rev-2', []), CAMERA);
    expect(scene.pick({ x: 155, y: 55 })).toBeNull();
  });

  it('emits an immediate select on pointer down', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene();
    const selects: (PickResult | null)[] = [];
    scene.on('select', (result) => selects.push(result));
    await scene.mount(canvas);
    flushFrames();
    scene.render(oneNode(), CAMERA);
    canvas.dispatchEvent(pointer('pointerdown', 155, 55));
    canvas.dispatchEvent(pointer('pointerup', 155, 55));
    expect(selects).toEqual([
      { kind: 'node', nodeId: 'n-0', screen: { x: 155, y: 55 }, world: { x: 5, y: 5 } },
    ]);
  });

  it('coalesces pointer move into one hover per frame and clears on leave', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene();
    const hovers: (PickResult | null)[] = [];
    scene.on('hover', (result) => hovers.push(result));
    await scene.mount(canvas);
    flushFrames();
    scene.render(oneNode(), CAMERA);
    canvas.dispatchEvent(pointer('pointermove', 154, 54));
    canvas.dispatchEvent(pointer('pointermove', 155, 55));
    flushFrames();
    expect(hovers).toEqual([{ kind: 'node', nodeId: 'n-0', screen: { x: 155, y: 55 }, world: { x: 5, y: 5 } }]);
    canvas.dispatchEvent(pointer('pointerleave', 0, 0));
    expect(hovers.at(-1)).toBeNull();
  });

  it('clears hover immediately when the model revision is replaced', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene();
    const hovers: (PickResult | null)[] = [];
    scene.on('hover', (result) => hovers.push(result));
    await scene.mount(canvas);
    flushFrames();
    scene.render(oneNode('hover-rev-1'), CAMERA);
    canvas.dispatchEvent(pointer('pointermove', 155, 55));
    flushFrames();
    expect(hovers.at(-1)).toMatchObject({ kind: 'node', nodeId: 'n-0' });

    scene.render(oneNode('hover-rev-2'), CAMERA);

    expect(hovers.at(-1)).toBeNull();
    expect(hovers).toHaveLength(2);
  });

  it('normalizes real pointer events in CSS pixels at DPR 1 and DPR 2', async () => {
    const selections: (PickResult | null)[][] = [[], []];
    const configurations = [
      { devicePixelRatio: 1, backingWidth: 300 },
      { devicePixelRatio: 2, backingWidth: 600 },
    ] as const;

    for (const [index, configuration] of configurations.entries()) {
      const { canvas, flushFrames } = fakeCanvas(300, 100, {
        devicePixelRatio: configuration.devicePixelRatio,
        left: 40,
        top: 20,
      });
      expect(canvas.width).toBe(configuration.backingWidth);
      const scene = trackedScene();
      scene.on('select', (result) => selections[index]!.push(result));
      await scene.mount(canvas);
      flushFrames();
      scene.render(oneNode(`hidpi-${configuration.devicePixelRatio}`), CAMERA);
      // The same client-space point maps to canvas-local CSS (155,55) in both
      // cases even though the second canvas has twice as many backing pixels.
      canvas.dispatchEvent(pointer('pointerdown', 40 + 155, 20 + 55));
    }

    expect(gpuLog.rendererInitResolutions.slice(-2)).toEqual([1, 2]);
    expect(selections[0]).toEqual(selections[1]);
    expect(selections[1]).toEqual([
      { kind: 'node', nodeId: 'n-0', screen: { x: 155, y: 55 }, world: { x: 5, y: 5 } },
    ]);
  });

  it('counts bitmap labels in stats for an ASCII model', async () => {
    const { canvas, flushFrames } = fakeCanvas();
    const scene = trackedScene();
    await scene.mount(canvas);
    flushFrames();
    scene.render(oneNode(), CAMERA);
    flushFrames();
    const stats = scene.stats();
    expect(stats.bitmapLabelCount).toBe(1);
    expect(stats.fallbackLabelCount).toBe(0);
    expect(stats.liveLabels).toBe(1);
  });
});
