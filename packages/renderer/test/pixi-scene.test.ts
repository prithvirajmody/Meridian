import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderModel } from '@meridian/view-model';
import type {
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
  createdGeometries: [] as GeometryRecord[],
}));

vi.mock('pixi.js', () => {
  class FakeBuffer {
    constructor(_options: { readonly label?: string }) {
      gpuLog.bufferCreations += 1;
    }

    update(): void {
      gpuLog.bufferUpdates += 1;
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

  class FakeWebGLRenderer {
    async init(options: Readonly<Record<string, unknown>>): Promise<void> {
      gpuLog.rendererInits += 1;
      gpuLog.rendererInitOptions = options;
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
    Buffer: FakeBuffer,
    BufferUsage: { VERTEX: 0x20, COPY_DST: 0x8 },
    Container: FakeContainer,
    Geometry: FakeGeometry,
    Mesh: FakeMesh,
    Shader: FakeShader,
    WebGLRenderer: FakeWebGLRenderer,
  };
});

const { createScene } = await import('../src/index.js');

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

function fakeCanvas(width = 300, height = 100): CanvasHarness {
  const frameQueue = new Map<number, FrameCallback>();
  let nextFrameHandle = 1;
  let cancellationCount = 0;
  const view = {
    devicePixelRatio: 1,
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
    readonly ownerDocument = { defaultView: view };

    getBoundingClientRect(): { width: number; height: number } {
      return { width, height };
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
  gpuLog.createdGeometries = [];
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
