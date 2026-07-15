import {
  EMPTY_SELECTION,
  type InducedEdge,
  type NodeId,
  type ProjectionModel,
  type ProjectionNode,
  type SelectionState,
} from '@meridian/view-model';
import { describe, expect, it, vi } from 'vitest';
import {
  MATRIX_GUTTER_LEFT_PX,
  MATRIX_GUTTER_TOP_PX,
  MatrixProjection,
  orderMatrixNodes,
  type Canvas2dFrame,
  type Canvas2dInput,
  type Canvas2dSurface,
  type ProjectionDiagnostic,
  type ProjectionHost,
  type ProjectionViewState,
} from '../src/index.js';

function id(value: string): NodeId {
  return value as NodeId;
}

function node(
  value: string,
  orderPath: readonly number[],
  options: Partial<ProjectionNode> = {},
): ProjectionNode {
  return {
    id: id(value),
    label: `${value} label`,
    kind: 'test:item',
    attrs: {},
    graphId: null,
    parentId: null,
    detailGraphId: null,
    depth: 0,
    cutReason: null,
    coveredLeaves: 1,
    orderPath,
    temporal: null,
    ...options,
  };
}

function edge(src: string, dst: string, weight = 1, kind = 'test:link'): InducedEdge {
  return { src: id(src), dst: id(dst), kind, weight, multiplicity: 1, samples: [] };
}

function model(
  nodes: readonly ProjectionNode[],
  inducedEdges: readonly InducedEdge[] = [],
  options: { readonly selection?: SelectionState; readonly focus?: NodeId | null } = {},
): ProjectionModel {
  return {
    cutLevel: 0,
    nodes,
    inducedEdges,
    selection: options.selection ?? EMPTY_SELECTION,
    focus: { node: options.focus ?? null },
    domainMeta: { domain: 'test', label: 'Test' },
    diagnostics: [],
  };
}

function fixture() {
  const frames: Canvas2dFrame[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];
  const selections: Array<{ nodeId: NodeId; mode: 'replace' | 'toggle' }> = [];
  const edgeSelections: Array<{ keys: readonly string[]; anchorKey: string | undefined }> = [];
  let input: ((value: Canvas2dInput) => void) | null = null;
  let destroys = 0;
  const surface: Canvas2dSurface = {
    render: (frame) => frames.push(frame),
    destroy: () => {
      destroys++;
    },
  };
  const host: ProjectionHost = {
    nodeLink: { mount: async () => Promise.reject(new Error('unused')) },
    virtualList: { mount: async () => Promise.reject(new Error('unused')) },
    canvas2d: {
      mount: vi.fn(async (sink) => {
        input = sink;
        return surface;
      }),
    },
    viewport: () => ({ width: 932, height: 608, devicePixelRatio: 1 }),
    now: () => 0,
    selectNode: (nodeId, mode) => selections.push({ nodeId, mode }),
    selectEdges: (keys, anchorKey) => edgeSelections.push({ keys, anchorKey }),
    focusNode: vi.fn(),
    navigate: vi.fn(),
    reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    showDegraded: vi.fn(),
  };
  return {
    host,
    frames,
    diagnostics,
    selections,
    edgeSelections,
    destroys: () => destroys,
    input: (value: Canvas2dInput) => {
      if (input === null) throw new Error('matrix input was not mounted');
      input(value);
    },
  };
}

describe('orderMatrixNodes', () => {
  it('groups by containment cluster, contiguously, in orderPath order', () => {
    const ordering = orderMatrixNodes(
      model(
        [
          node('b1', [1, 0], { parentId: id('b') }),
          node('a2', [0, 1], { parentId: id('a') }),
          node('a1', [0, 0], { parentId: id('a') }),
          node('b2', [1, 1], { parentId: id('b') }),
        ],
        [edge('a1', 'b1')],
      ),
    );
    expect(ordering.clusters.map((cluster) => [cluster.key, cluster.start, cluster.count])).toEqual([
      ['a', 0, 2],
      ['b', 2, 2],
    ]);
    const positions = new Map(ordering.nodeIds.map((nodeId, index) => [nodeId, index] as const));
    expect(positions.get(id('a1'))).toBeLessThan(positions.get(id('b1'))!);
    expect(positions.get(id('a2'))).toBeLessThan(positions.get(id('b1'))!);
  });

  it('orders heavier nodes first within a cluster, then orderPath, deterministically', () => {
    const nodes = [
      node('x', [0, 0], { parentId: id('p') }),
      node('y', [0, 1], { parentId: id('p') }),
      node('z', [0, 2], { parentId: id('q') }),
    ];
    const edges = [edge('y', 'z', 5), edge('x', 'z', 1)];
    const forward = orderMatrixNodes(model(nodes, edges));
    const reversed = orderMatrixNodes(model([...nodes].reverse(), [...edges].reverse()));
    expect(forward.nodeIds).toEqual([id('y'), id('x'), id('z')]);
    expect(reversed.nodeIds).toEqual(forward.nodeIds);
  });

  it('falls back to connected components on flat cuts and trails unconnected nodes', () => {
    const ordering = orderMatrixNodes(
      model(
        [node('lone', [0, 3]), node('c', [0, 2]), node('a', [0, 0]), node('b', [0, 1])],
        [edge('a', 'b'), edge('b', 'c')],
      ),
    );
    expect(ordering.clusters.map((cluster) => cluster.key)).toEqual(['a', '(isolated)']);
    expect(ordering.clusters.at(-1)).toMatchObject({ label: 'Unconnected', count: 1 });
    expect(ordering.nodeIds.at(-1)).toBe(id('lone'));
  });

  it('labels containment clusters from the visible parent node when present', () => {
    const ordering = orderMatrixNodes(
      model(
        [
          node('p', [0]),
          node('c1', [0, 0], { parentId: id('p') }),
          node('c2', [0, 1], { parentId: id('p') }),
        ],
        [edge('c1', 'c2')],
      ),
    );
    expect(ordering.clusters.map((cluster) => cluster.label)).toEqual(['Top level', 'p label']);
  });
});

describe('MatrixProjection', () => {
  it('renders cells for induced edges and suitability tracks meaningfulness', async () => {
    const projection = new MatrixProjection();
    const f = fixture();
    const instance = await projection.mount(f.host);
    const filled = model(
      [node('a', [0, 0]), node('b', [0, 1])],
      [edge('a', 'b', 2)],
    );
    instance.render(filled);

    const frame = f.frames.at(-1)!;
    expect(frame.message).toBeNull();
    expect(frame.rects.length).toBeGreaterThan(0);
    expect(projection.suitability(filled)).toBeGreaterThan(0);
    expect(projection.suitability(model([node('a', [0, 0])], []))).toBe(0);
    expect(projection.suitability(model([], []))).toBe(0);
  });

  it('degrades with a message when the cut has no relationships, and when empty', async () => {
    const f = fixture();
    const instance = await new MatrixProjection().mount(f.host);
    instance.render(model([node('a', [0, 0]), node('b', [0, 1])], []));
    expect(f.frames.at(-1)?.message).toMatch(/no relationships/i);

    instance.render(model([], []));
    expect(f.frames.at(-1)?.message).toBe('No visible nodes in this cut.');
  });

  it('maps cell clicks to canonical edge selection and diagonal/gutter clicks to nodes', async () => {
    const f = fixture();
    const instance = await new MatrixProjection().mount(f.host);
    instance.render(model(
      [node('a', [0, 0]), node('b', [0, 1])],
      [edge('a', 'b', 1, 'test:link'), edge('a', 'b', 1, 'test:cites')],
    ));
    const state = instance.captureViewState() as { readonly cellSize: number };
    const cell = state.cellSize;

    // Cell (row 0 = a, col 1 = b) — both coincident edges selected, sorted keys.
    const click = (x: number, y: number): void => {
      f.input({ type: 'pointer', action: 'down', x, y, primary: true });
      f.input({ type: 'pointer', action: 'up', x, y, primary: true });
    };
    click(MATRIX_GUTTER_LEFT_PX + cell * 1.5, MATRIX_GUTTER_TOP_PX + cell * 0.5);
    expect(f.edgeSelections.at(-1)).toEqual({
      keys: ['a→b→test:cites', 'a→b→test:link'],
      anchorKey: 'a→b→test:cites',
    });

    click(MATRIX_GUTTER_LEFT_PX + cell * 0.5, MATRIX_GUTTER_TOP_PX + cell * 0.5);
    expect(f.selections.at(-1)).toEqual({ nodeId: id('a'), mode: 'replace' });

    click(MATRIX_GUTTER_LEFT_PX - 40, MATRIX_GUTTER_TOP_PX + cell * 1.5);
    expect(f.selections.at(-1)).toEqual({ nodeId: id('b'), mode: 'replace' });
  });

  it('pans by drag, zooms by wheel within bounds, and round-trips view state', async () => {
    const f = fixture();
    const instance = await new MatrixProjection().mount(f.host);
    const nodes = Array.from({ length: 400 }, (_, index) => node(`n${index}`, [0, index]));
    const edges = Array.from({ length: 399 }, (_, index) => edge(`n${index}`, `n${index + 1}`));
    instance.render(model(nodes, edges));

    f.input({ type: 'wheel', x: MATRIX_GUTTER_LEFT_PX + 100, y: MATRIX_GUTTER_TOP_PX + 100, deltaY: -700 });
    const zoomed = instance.captureViewState() as {
      readonly cellSize: number;
      readonly offsetX: number;
      readonly offsetY: number;
    };
    expect(zoomed.cellSize).toBeGreaterThan(2);

    f.input({ type: 'pointer', action: 'down', x: 400, y: 300, primary: true });
    f.input({ type: 'pointer', action: 'move', x: 360, y: 280, primary: true });
    f.input({ type: 'pointer', action: 'up', x: 360, y: 280, primary: true });
    const panned = instance.captureViewState() as {
      readonly offsetX: number;
      readonly offsetY: number;
    };
    expect(panned.offsetX).toBeGreaterThanOrEqual(zoomed.offsetX + 40 - 1e-6);
    expect(f.selections).toEqual([]); // a drag is not a click

    const saved = instance.captureViewState();
    const g = fixture();
    const second = await new MatrixProjection().mount(g.host);
    second.restoreViewState(saved);
    second.render(model(nodes, edges));
    expect(second.captureViewState()).toEqual(saved);
    expect(g.diagnostics).toEqual([]);
  });

  it('diagnoses malformed view state and falls back to deterministic defaults', async () => {
    const f = fixture();
    const instance = await new MatrixProjection().mount(f.host);
    instance.restoreViewState({ version: 9, cellSize: -4, offsetX: Number.NaN } as ProjectionViewState);
    expect(f.diagnostics.at(-1)).toMatchObject({
      projectionId: 'matrix',
      code: 'invalid-view-state',
      phase: 'view-state',
    });
    instance.render(model([node('a', [0, 0]), node('b', [0, 1])], [edge('a', 'b')]));
    expect(f.frames.at(-1)?.message).toBeNull();
  });

  it('reveals focus by centring its diagonal cell, falling back to the node anchor', async () => {
    const f = fixture();
    const instance = await new MatrixProjection().mount(f.host);
    const nodes = Array.from({ length: 1_000 }, (_, index) => node(`n${index}`, [0, index]));
    const edges = Array.from({ length: 999 }, (_, index) => edge(`n${index}`, `n${index + 1}`));
    const rendered = model(nodes, edges, { focus: id('n900') });
    instance.render(rendered);
    const ordering = orderMatrixNodes(rendered);
    const viewportGrid = { width: 932 - MATRIX_GUTTER_LEFT_PX, height: 608 - MATRIX_GUTTER_TOP_PX };
    const expectOffsets = (target: string): { x: number; y: number } => {
      const state = instance.captureViewState() as { readonly cellSize: number };
      const index = ordering.nodeIds.indexOf(id(target));
      const centre = index * state.cellSize + state.cellSize / 2;
      const max = ordering.nodeIds.length * state.cellSize;
      return {
        x: Math.min(Math.max(0, centre - viewportGrid.width / 2), max - viewportGrid.width),
        y: Math.min(Math.max(0, centre - viewportGrid.height / 2), max - viewportGrid.height),
      };
    };

    instance.applyFocus({ node: id('n900') });
    instance.revealFocus();
    const focused = instance.captureViewState() as {
      readonly offsetX: number;
      readonly offsetY: number;
    };
    expect(focused).toMatchObject({
      offsetX: expectOffsets('n900').x,
      offsetY: expectOffsets('n900').y,
    });
    expect(focused.offsetX).toBeGreaterThan(0);

    instance.applyFocus({ node: null });
    instance.applySelection({
      nodes: [id('n500')],
      edges: [],
      anchor: { kind: 'node', id: id('n500') },
    });
    instance.revealFocus();
    const anchored = instance.captureViewState() as { readonly offsetX: number };
    expect(anchored.offsetX).toBe(expectOffsets('n500').x);
    expect(anchored.offsetX).not.toBe(focused.offsetX);
  });

  it('renders a 2k×2k cut within the 500ms budget', async () => {
    const f = fixture();
    const instance = await new MatrixProjection().mount(f.host);
    const count = 2_000;
    const nodes = Array.from({ length: count }, (_, index) =>
      node(`n${index}`, [Math.floor(index / 40), index % 40], {
        parentId: id(`cluster-${Math.floor(index / 40)}`),
      }),
    );
    const edges: InducedEdge[] = [];
    for (let index = 0; index < count; index++) {
      edges.push(edge(`n${index}`, `n${(index + 1) % count}`, 1 + (index % 5)));
      edges.push(edge(`n${index}`, `n${(index * 7) % count}`, 1));
      edges.push(edge(`n${index}`, `n${(index + 40) % count}`, 2));
    }
    const start = performance.now();
    instance.render(model(nodes, edges));
    const elapsed = performance.now() - start;
    expect(f.frames.at(-1)?.message).toBeNull();
    expect(elapsed).toBeLessThan(500);
  });

  it('reports mount failure, destroys idempotently, and rejects later lifecycle calls', async () => {
    const failure = new Error('canvas host unavailable');
    const f = fixture();
    f.host.canvas2d.mount = async () => Promise.reject(failure);
    await expect(new MatrixProjection().mount(f.host)).rejects.toBe(failure);
    expect(f.diagnostics.at(-1)).toMatchObject({ code: 'mount-failed', phase: 'mount' });

    const healthy = fixture();
    const instance = await new MatrixProjection().mount(healthy.host);
    instance.destroy();
    instance.destroy();
    expect(healthy.destroys()).toBe(1);
    expect(() => instance.render(model([], []))).toThrow('matrix.render called after destroy');
    expect(() => instance.captureViewState()).toThrow(
      'matrix.captureViewState called after destroy',
    );
  });
});
