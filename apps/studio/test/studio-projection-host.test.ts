import { describe, expect, it } from 'vitest';
import {
  MAP_PROJECTION,
  type ProjectionViewState,
  type ProjectionInstance,
  type ViewProjection,
} from '@meridian/projections';
import {
  EMPTY_FOCUS,
  EMPTY_SELECTION,
  type ProjectionModel,
  type RenderModel,
} from '@meridian/view-model';
import { createPerformanceRenderModel } from '../src/performance-fixtures.js';
import {
  StudioProjectionCoordinator,
  type StudioMapBridge,
} from '../src/studio-projection-host.js';
import { createStudioStore, StudioStoreCommands } from '../src/store.js';

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent: string | null = null;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

class FakeBridge implements StudioMapBridge {
  readonly renders: RenderModel[] = [];
  readonly revealed: Array<string | null> = [];
  destroyed = false;
  mountPromise: Promise<void> = Promise.resolve();
  viewState: ProjectionViewState = { camera: { center: { x: 0, y: 0 }, scale: 1 } };

  mount(): Promise<void> {
    return this.mountPromise;
  }

  acceptSettledModel(model: RenderModel | null): void {
    if (model !== null) this.renders.push(model);
  }

  renderTransient(): void {}
  captureViewState(): ProjectionViewState { return this.viewState; }
  restoreViewState(state: ProjectionViewState): void { this.viewState = state; }
  revealNode(nodeId: string | null): void { this.revealed.push(nodeId); }
  viewportSize(): { width: number; height: number } { return { width: 800, height: 600 }; }
  fit(): void {}
  zoomBy(): void {}
  setScale(): void {}
  screenPointForNode(): { x: number; y: number } | null { return null; }
  async runFrameProbe(): Promise<never> { throw new Error('not used'); }
  loseContext(): boolean { return false; }
  restoreContext(): boolean { return false; }
  destroy(): void { this.destroyed = true; }
}

function projectionModel(renderModel: RenderModel): ProjectionModel {
  return {
    cutLevel: 0,
    nodes: [],
    inducedEdges: [],
    selection: EMPTY_SELECTION,
    focus: EMPTY_FOCUS,
    domainMeta: { domain: 'test', label: 'Test' },
    renderModel,
  };
}

function hostElement(): FakeElement {
  const document = new FakeDocument();
  return new FakeElement(document, 'div');
}

function inertInstance(onDestroy: () => void): ProjectionInstance {
  return {
    render: () => undefined,
    applySelection: () => undefined,
    applyFocus: () => undefined,
    revealFocus: () => undefined,
    captureViewState: () => null,
    restoreViewState: () => undefined,
    destroy: onDestroy,
  };
}

describe('StudioProjectionCoordinator', () => {
  it('commits the latest semantic model after async map readiness', async () => {
    let resolveMount!: () => void;
    const bridge = new FakeBridge();
    bridge.mountPromise = new Promise<void>((resolve) => { resolveMount = resolve; });
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    commands.beginOpen({ generation: 1, name: 'fixture', bytes: 0 });
    const first = createPerformanceRenderModel(2);
    commands.setProjectionModel(projectionModel(first));
    const element = hostElement();
    const coordinator = new StudioProjectionCoordinator(
      element as unknown as HTMLElement,
      store,
      { bridgeFactory: () => bridge },
    );

    const mounting = coordinator.switchProjection('map');
    const latest = { ...createPerformanceRenderModel(3), revision: 'latest' };
    commands.setProjectionModel(projectionModel(latest));
    expect(bridge.renders).toEqual([]);
    resolveMount();
    await mounting;

    expect(coordinator.activeId()).toBe('map');
    expect(bridge.renders).toEqual([latest]);
    expect(element.children[0]?.attributes.get('data-testid')).toBe('graph-canvas');
    coordinator.destroy();
    expect(bridge.destroyed).toBe(true);
  });

  it('destroys a stale async completion and converges on the final request', async () => {
    let resolveSlow!: () => void;
    let slowDestroyed = false;
    const slow: ViewProjection = {
      id: 'slow',
      label: 'Slow',
      suitability: () => 1,
      mount: async () => {
        await new Promise<void>((resolve) => { resolveSlow = resolve; });
        return inertInstance(() => { slowDestroyed = true; });
      },
    };
    const bridge = new FakeBridge();
    const store = createStudioStore();
    new StudioStoreCommands(store).setProjectionModel(
      projectionModel(createPerformanceRenderModel(2)),
    );
    const coordinator = new StudioProjectionCoordinator(
      hostElement() as unknown as HTMLElement,
      store,
      { projections: [slow, MAP_PROJECTION], bridgeFactory: () => bridge },
    );

    const first = coordinator.switchProjection('slow');
    await Promise.resolve();
    const final = coordinator.switchProjection('map');
    resolveSlow();
    await Promise.all([first, final]);

    expect(coordinator.activeId()).toBe('map');
    expect(slowDestroyed).toBe(true);
    coordinator.destroy();
  });

  it('contains a target mount failure and atomically falls back to map', async () => {
    const failing: ViewProjection = {
      id: 'broken',
      label: 'Broken',
      suitability: () => 1,
      mount: async () => { throw new Error('projection exploded'); },
    };
    const bridge = new FakeBridge();
    const store = createStudioStore();
    const renderModel = createPerformanceRenderModel(2);
    new StudioStoreCommands(store).setProjectionModel(projectionModel(renderModel));
    const coordinator = new StudioProjectionCoordinator(
      hostElement() as unknown as HTMLElement,
      store,
      { projections: [failing, MAP_PROJECTION], bridgeFactory: () => bridge },
    );

    await coordinator.switchProjection('broken');

    expect(coordinator.activeId()).toBe('map');
    expect(bridge.renders).toEqual([renderModel]);
    expect(store.getState().diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'projection', code: 'projection-mount-failed' }),
      ]),
    );
    coordinator.destroy();
  });

  it('falls back to map and shows a deterministic failure if map also cannot mount', async () => {
    const selection = {
      nodes: ['selected' as never],
      edges: [],
      anchor: { kind: 'node' as const, id: 'selected' as never },
    };
    const focus = { node: 'focused' as never };
    const failing: ViewProjection = {
      id: 'broken',
      label: 'Broken',
      suitability: () => 1,
      mount: async () => { throw new Error('projection exploded'); },
    };
    const bridge = new FakeBridge();
    bridge.mountPromise = Promise.reject(new Error('gpu unavailable'));
    const store = createStudioStore();
    store.setState({ selection });
    const element = hostElement();
    const coordinator = new StudioProjectionCoordinator(
      element as unknown as HTMLElement,
      store,
      {
        projections: [failing, MAP_PROJECTION],
        bridgeFactory: () => bridge,
        focus: () => focus,
      },
    );

    await coordinator.switchProjection('broken');

    expect(coordinator.activeId()).toBeNull();
    expect(store.getState().selection).toBe(selection);
    expect(store.getState().diagnostics.some((item) => item.source === 'projection')).toBe(true);
    expect(
      element.children.find((child) => child.attributes.get('data-testid') === 'projection-failure')
        ?.textContent,
    ).toBe('Unable to display this view.');
    coordinator.destroy();
  });
});
