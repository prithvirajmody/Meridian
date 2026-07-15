import {
  createFocusState,
  EMPTY_SELECTION,
  type NodeId,
  type ProjectionModel,
  type RenderModel,
  type SelectionState,
} from '@meridian/view-model';
import { describe, expect, it, vi } from 'vitest';
import {
  MapProjection,
  type NodeLinkSurface,
  type ProjectionDiagnostic,
  type ProjectionHost,
} from '../src/index.js';

function id(value: string): NodeId {
  return value as NodeId;
}

function projectionModel(renderModel?: RenderModel): ProjectionModel {
  return {
    cutLevel: 0,
    nodes: [],
    inducedEdges: [],
    selection: EMPTY_SELECTION,
    focus: createFocusState(),
    domainMeta: { domain: 'test', label: 'Test' },
    ...(renderModel === undefined ? {} : { renderModel }),
  };
}

function renderModel(): RenderModel {
  return {
    revision: 'rm-test',
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    nodeIds: [],
    nodeRects: new Float64Array(),
    nodeColorKeys: [],
    nodeColorIds: new Uint16Array(),
    nodeFlags: new Uint8Array(),
    nodeCoveredLeaves: new Float64Array(),
    nodeDegrees: new Uint32Array(),
    labelTable: [],
    labelRefs: new Uint32Array(),
    labelClasses: new Uint8Array(),
    edgeKeys: [],
    edgeIndices: new Uint32Array(),
    edgeColorKeys: [],
    edgeColorIds: new Uint16Array(),
    edgeWeights: new Float64Array(),
    edgeMultiplicities: new Uint32Array(),
    edgeFlags: new Uint8Array(),
    edgeRouteOffsets: new Uint32Array([0]),
    edgeRoutePoints: new Float64Array(),
    diagnostics: [],
  };
}

function neutralHostPorts(): Omit<
  ProjectionHost,
  'nodeLink' | 'reportDiagnostic' | 'showDegraded'
> {
  return {
    virtualList: { mount: async () => Promise.reject(new Error('unused')) },
    canvas2d: { mount: async () => Promise.reject(new Error('unused')) },
    viewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
    now: () => 0,
    selectNode: vi.fn(),
    selectEdges: vi.fn(),
    focusNode: vi.fn(),
    navigate: vi.fn(),
  };
}

function fixture() {
  const diagnostics: ProjectionDiagnostic[] = [];
  const degraded: string[] = [];
  const rendered: RenderModel[] = [];
  const revealed: Array<NodeId | null> = [];
  const restored: unknown[] = [];
  let destroys = 0;
  const state = { camera: { center: { x: 3, y: 4 }, scale: 2 } };
  const surface: NodeLinkSurface = {
    render: (model) => rendered.push(model),
    captureViewState: () => state,
    restoreViewState: (value) => restored.push(value),
    revealNode: (nodeId) => revealed.push(nodeId),
    destroy: () => {
      destroys++;
    },
  };
  const host: ProjectionHost = {
    ...neutralHostPorts(),
    nodeLink: { mount: vi.fn(async () => surface) },
    reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    showDegraded: (message) => degraded.push(message),
  };
  return {
    host,
    diagnostics,
    degraded,
    rendered,
    revealed,
    restored,
    state,
    destroys: () => destroys,
  };
}

describe('MapProjection', () => {
  it('mounts asynchronously and delegates the established RenderModel and view state unchanged', async () => {
    const f = fixture();
    const projection = new MapProjection();
    const pending = projection.mount(f.host);
    expect(pending).toBeInstanceOf(Promise);
    const instance = await pending;
    const render = renderModel();
    const restored = { camera: { center: { x: 8, y: 9 }, scale: 1 } };

    instance.render(projectionModel(render));
    instance.restoreViewState(restored);

    expect(f.rendered).toEqual([render]);
    expect(f.rendered[0]).toBe(render);
    expect(instance.captureViewState()).toBe(f.state);
    expect(f.restored).toEqual([restored]);
    expect(projection.suitability(projectionModel(render))).toBe(1);
    expect(projection.suitability(projectionModel())).toBe(0);
  });

  it('preserves focus identity and falls back only to a node selection anchor', async () => {
    const f = fixture();
    const instance = await new MapProjection().mount(f.host);
    const selection: SelectionState = {
      nodes: [id('selected')],
      edges: [],
      anchor: { kind: 'node', id: id('anchor') },
    };

    instance.applySelection(selection);
    instance.applyFocus(createFocusState(id('focused')));
    instance.revealFocus();
    instance.applyFocus(createFocusState());
    instance.revealFocus();
    instance.applySelection({ nodes: [id('selected')], edges: [] });
    instance.revealFocus();

    expect(f.revealed).toEqual([id('focused'), id('anchor'), null]);
  });

  it('degrades explicitly when layout/render data is unavailable', async () => {
    const f = fixture();
    const instance = await new MapProjection().mount(f.host);

    instance.render(projectionModel());

    expect(f.rendered).toEqual([]);
    expect(f.degraded).toEqual(['Map projection requires layout before it can render.']);
    expect(f.diagnostics).toEqual([
      {
        projectionId: 'map',
        code: 'missing-render-model',
        phase: 'render',
        message: 'Map projection requires layout before it can render.',
      },
    ]);
  });

  it('destroys idempotently and rejects every other lifecycle call afterwards', async () => {
    const f = fixture();
    const instance = await new MapProjection().mount(f.host);

    instance.destroy();
    instance.destroy();

    expect(f.destroys()).toBe(1);
    expect(() => instance.render(projectionModel(renderModel()))).toThrow('map.render called after destroy');
    expect(() => instance.applySelection(EMPTY_SELECTION)).toThrow(
      'map.applySelection called after destroy',
    );
    expect(() => instance.applyFocus(createFocusState())).toThrow(
      'map.applyFocus called after destroy',
    );
    expect(() => instance.revealFocus()).toThrow('map.revealFocus called after destroy');
    expect(() => instance.captureViewState()).toThrow('map.captureViewState called after destroy');
    expect(() => instance.restoreViewState({})).toThrow(
      'map.restoreViewState called after destroy',
    );
  });

  it('reports and rethrows asynchronous mount failure', async () => {
    const diagnostics: ProjectionDiagnostic[] = [];
    const failure = new Error('GPU unavailable');
    const host: ProjectionHost = {
      ...neutralHostPorts(),
      nodeLink: { mount: async () => Promise.reject(failure) },
      reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      showDegraded: vi.fn(),
    };

    await expect(new MapProjection().mount(host)).rejects.toBe(failure);
    expect(diagnostics).toEqual([
      {
        projectionId: 'map',
        code: 'mount-failed',
        phase: 'mount',
        message: 'GPU unavailable',
      },
    ]);
  });
});
