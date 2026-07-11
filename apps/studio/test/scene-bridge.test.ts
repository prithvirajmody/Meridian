import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  PickResult,
  RendererFault,
  RendererStats,
  SceneAdapter,
  SceneEventPayloads,
  Unsubscribe,
} from '@meridian/renderer';
import type { CameraState, Point, RenderModel } from '@meridian/view-model';
import { createPerformanceRenderModel } from '../src/performance-fixtures.js';
import { StudioSceneBridge } from '../src/studio-scene-bridge.js';
import { createStudioStore, StudioStoreCommands } from '../src/store.js';

const STATS: RendererStats = {
  frameTimeMs: 1,
  drawCalls: 1,
  frameCount: 1,
  modelNodes: 4,
  candidateNodes: 4,
  visibleNodes: 4,
  culledNodes: 0,
  modelEdges: 2,
  visibleEdges: 2,
  culledEdges: 0,
  modelEdgeSegments: 2,
  candidateEdgeSegments: 2,
  visibleEdgeSegments: 2,
  submittedNodeBatches: 1,
  submittedEdgeBatches: 1,
  liveLabels: 1,
  bitmapLabelCount: 1,
  fallbackLabelCount: 0,
  omittedLabelCount: 0,
  pickQueryTimeMs: 0.01,
  contextLosses: 0,
  bufferUploadBytes: 100,
};

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

class FakeScene implements SceneAdapter {
  readonly renders: Array<{ model: RenderModel; camera: CameraState }> = [];
  destroyed = false;
  mountPromise: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<keyof SceneEventPayloads, Set<(payload: never) => void>>();

  mount(): Promise<void> {
    return this.mountPromise;
  }

  render(model: RenderModel, camera: CameraState): void {
    this.renders.push({ model, camera });
  }

  pick(_screen: Point): PickResult | null {
    return null;
  }

  on<E extends keyof SceneEventPayloads>(
    event: E,
    listener: (payload: SceneEventPayloads[E]) => void,
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => set!.delete(listener as (payload: never) => void);
  }

  emit<E extends keyof SceneEventPayloads>(event: E, payload: SceneEventPayloads[E]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload as never);
  }

  stats(): Readonly<RendererStats> {
    return STATS;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function canvas(): HTMLCanvasElement {
  const target = new EventTarget() as HTMLCanvasElement;
  Object.defineProperties(target, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
    width: { value: 800, writable: true },
    height: { value: 600, writable: true },
    ownerDocument: { value: { defaultView: { devicePixelRatio: 1 } } },
  });
  target.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) }) as DOMRect;
  target.setPointerCapture = () => undefined;
  target.releasePointerCapture = () => undefined;
  target.hasPointerCapture = () => false;
  target.getContext = () => null;
  return target;
}

let originalResizeObserver: typeof ResizeObserver | undefined;

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  if (originalResizeObserver === undefined) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  else globalThis.ResizeObserver = originalResizeObserver;
});

function bridgeFor(scene: FakeScene) {
  const store = createStudioStore();
  const bridge = new StudioSceneBridge(store, {
    sceneFactory: () => scene,
    now: () => 100,
    requestFrame: (callback) => {
      queueMicrotask(() => callback(0));
      return 1;
    },
    cancelFrame: () => undefined,
  });
  return { store, bridge };
}

describe('StudioSceneBridge lifecycle and event direction', () => {
  it('buffers the latest model while async mount is pending', async () => {
    let resolveMount!: () => void;
    const scene = new FakeScene();
    scene.mountPromise = new Promise<void>((resolve) => {
      resolveMount = resolve;
    });
    const { store, bridge } = bridgeFor(scene);
    const mounting = bridge.mount(canvas());
    const commands = new StudioStoreCommands(store);
    commands.beginOpen({ generation: 1, name: 'fixture', bytes: 0 });
    const first = createPerformanceRenderModel(2);
    const latest = { ...createPerformanceRenderModel(3), revision: 'latest' };
    commands.publishModel(first, 'v1', 0, 'first');
    commands.publishModel(latest, 'v1', 0, 'latest');
    expect(scene.renders).toHaveLength(0);
    resolveMount();
    await mounting;
    expect(scene.renders.at(-1)?.model.revision).toBe('latest');
    bridge.destroy();
  });

  it('discards late readiness after Strict-Mode-style cleanup', async () => {
    let resolveMount!: () => void;
    const scene = new FakeScene();
    scene.mountPromise = new Promise<void>((resolve) => {
      resolveMount = resolve;
    });
    const { bridge } = bridgeFor(scene);
    const mounting = bridge.mount(canvas());
    bridge.destroy();
    resolveMount();
    await mounting;
    expect(scene.destroyed).toBe(true);
    expect(scene.renders).toEqual([]);
  });

  it('translates plain hover/select/fault/stats events into Zustand values', async () => {
    const scene = new FakeScene();
    const { store, bridge } = bridgeFor(scene);
    await bridge.mount(canvas());
    const hit: PickResult = {
      kind: 'node',
      nodeId: 'selected' as never,
      screen: { x: 1, y: 2 },
      world: { x: 3, y: 4 },
    };
    scene.emit('hover', hit);
    scene.emit('select', hit);
    scene.emit('stats', STATS);
    const fault: RendererFault = { code: 'context-lost', message: 'lost' };
    scene.emit('fault', fault);
    expect(store.getState().hover?.element).toEqual(hit);
    expect(store.getState().selection.anchor).toEqual({ kind: 'node', id: 'selected' });
    expect(store.getState().rendererStats).toEqual(STATS);
    expect(store.getState().diagnostics.at(-1)).toMatchObject({ code: 'context-lost' });
    bridge.destroy();
    expect(store.getState().hover).toBeNull();
  });
});
