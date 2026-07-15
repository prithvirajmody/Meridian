import {
  EMPTY_FOCUS,
  EMPTY_SELECTION,
  type NodeId,
  type ProjectionModel,
  type ProjectionNode,
  type SelectionState,
} from '@meridian/view-model';
import { describe, expect, it, vi } from 'vitest';
import {
  OutlineProjection,
  type ProjectionDiagnostic,
  type ProjectionHost,
  type ProjectionNavigationIntent,
  type ProjectionViewState,
  type VirtualListFrame,
  type VirtualListInput,
  type VirtualListSurface,
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
    label: value,
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

function model(
  nodes: readonly ProjectionNode[],
  options: {
    readonly selection?: SelectionState;
    readonly focus?: NodeId | null;
  } = {},
): ProjectionModel {
  return {
    cutLevel: 0,
    nodes,
    inducedEdges: [],
    selection: options.selection ?? EMPTY_SELECTION,
    focus: { node: options.focus ?? null },
    domainMeta: { domain: 'test', label: 'Test' },
    diagnostics: [],
  };
}

function fixture() {
  const frames: VirtualListFrame[] = [];
  const revealed: NodeId[] = [];
  const restored: ProjectionViewState[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];
  const selections: Array<{ nodeId: NodeId; mode: 'replace' | 'toggle' }> = [];
  const navigation: ProjectionNavigationIntent[] = [];
  let input: ((value: VirtualListInput) => void) | null = null;
  let destroys = 0;
  let viewState: ProjectionViewState = { scrollTop: 64 };
  const surface: VirtualListSurface = {
    render: (frame) => frames.push(frame),
    captureViewState: () => viewState,
    restoreViewState: (state) => {
      restored.push(state);
      viewState = state;
    },
    revealNode: (nodeId) => revealed.push(nodeId),
    destroy: () => {
      destroys++;
    },
  };
  const host: ProjectionHost = {
    nodeLink: { mount: async () => Promise.reject(new Error('unused')) },
    virtualList: {
      mount: vi.fn(async (sink) => {
        input = sink;
        return surface;
      }),
    },
    canvas2d: { mount: async () => Promise.reject(new Error('unused')) },
    viewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
    now: () => 0,
    selectNode: (nodeId, mode) => selections.push({ nodeId, mode }),
    selectEdges: vi.fn(),
    focusNode: vi.fn(),
    navigate: (intent) => navigation.push(intent),
    reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    showDegraded: vi.fn(),
  };
  return {
    host,
    frames,
    revealed,
    restored,
    diagnostics,
    selections,
    navigation,
    destroys: () => destroys,
    input: (value: VirtualListInput) => {
      if (input === null) throw new Error('outline input was not mounted');
      input(value);
    },
  };
}

describe('OutlineProjection', () => {
  it('orders semantic rows without layout, normalizes depth, and marks expandable rows', async () => {
    const f = fixture();
    const projection = new OutlineProjection();
    const instance = await projection.mount(f.host);
    instance.render(model([
      node('third', [0, 2], { depth: 5 }),
      node('first', [0, 0], { depth: 3, detailGraphId: 'detail' as never }),
      node('second', [0, 1], { depth: 4, coveredLeaves: 7 }),
    ]));

    expect(f.frames.at(-1)?.rows.map((row) => row.nodeId)).toEqual([
      id('first'), id('second'), id('third'),
    ]);
    expect(f.frames.at(-1)?.rows.map((row) => row.depth)).toEqual([0, 1, 2]);
    expect(f.frames.at(-1)?.rows[0]).toMatchObject({ expandable: true, expanded: false });
    expect(projection.suitability(model([]))).toBeGreaterThan(0);

    instance.render(model([]));
    expect(f.frames.at(-1)).toMatchObject({ rows: [], emptyMessage: 'No visible nodes in this cut.' });
    expect(f.host.showDegraded).not.toHaveBeenCalled();
  });

  it('maps keyboard and pointer input to active-row, selection, and navigation intents', async () => {
    const f = fixture();
    const instance = await new OutlineProjection().mount(f.host);
    instance.render(model([
      node('a', [0, 0]),
      node('b', [0, 1], { parentId: id('parent'), detailGraphId: 'detail' as never }),
      node('c', [0, 2]),
    ]));

    f.input({ type: 'key', key: 'ArrowDown' });
    expect(f.frames.at(-1)?.activeNodeId).toBe(id('b'));
    expect(f.revealed.at(-1)).toBe(id('b'));
    f.input({ type: 'key', key: 'Enter' });
    f.input({ type: 'key', key: 'ArrowRight' });
    f.input({ type: 'key', key: 'ArrowLeft' });
    f.input({ type: 'activate', nodeId: id('c'), source: 'pointer' });

    expect(f.selections).toEqual([
      { nodeId: id('b'), mode: 'replace' },
      { nodeId: id('c'), mode: 'replace' },
    ]);
    expect(f.navigation).toEqual([
      { kind: 'expand', nodeId: id('b') },
      { kind: 'collapse', nodeId: id('parent') },
    ]);
  });

  it('preserves active-row continuity across a parent-to-children replacement', async () => {
    const f = fixture();
    const instance = await new OutlineProjection().mount(f.host);
    instance.render(model([node('parent', [0, 0], { detailGraphId: 'detail' as never })]));
    f.input({ type: 'activate', nodeId: id('parent'), source: 'pointer' });

    instance.render(model([
      node('child-b', [0, 0, 1], { parentId: id('parent'), depth: 1 }),
      node('child-a', [0, 0, 0], { parentId: id('parent'), depth: 1 }),
    ]));

    expect(f.frames.at(-1)?.activeNodeId).toBe(id('child-a'));
  });

  it('applies canonical selection and reveals focus before a node anchor', async () => {
    const f = fixture();
    const instance = await new OutlineProjection().mount(f.host);
    const selection: SelectionState = {
      nodes: [id('anchor')],
      edges: [],
      anchor: { kind: 'node', id: id('anchor') },
    };
    instance.render(model(
      [node('anchor', [0, 0]), node('focused', [0, 1])],
      { selection, focus: id('focused') },
    ));
    instance.revealFocus();
    instance.applyFocus(EMPTY_FOCUS);
    instance.revealFocus();

    expect(f.frames.at(-1)?.selection).toEqual(selection);
    expect(f.revealed).toEqual([id('focused'), id('anchor')]);
  });

  it('round-trips valid view state and diagnoses malformed or stale state without failing', async () => {
    const f = fixture();
    const instance = await new OutlineProjection().mount(f.host);
    instance.restoreViewState({ version: 1, scrollTop: 96, activeNodeId: 'missing' });
    instance.render(model([node('visible', [0, 0])]));
    expect(f.restored[0]).toEqual({ scrollTop: 96 });
    expect(f.diagnostics.at(-1)?.code).toBe('invalid-view-state');
    expect(instance.captureViewState()).toEqual({
      version: 1,
      scrollTop: 96,
      activeNodeId: id('visible'),
    });

    instance.restoreViewState({ version: 4, scrollTop: -1, activeNodeId: false });
    expect(f.restored.at(-1)).toEqual({ scrollTop: 0 });
    expect(f.diagnostics.at(-1)).toMatchObject({
      code: 'invalid-view-state',
      phase: 'view-state',
    });
  });

  it('reports mount failure, destroys idempotently, and rejects later lifecycle calls', async () => {
    const failure = new Error('DOM host unavailable');
    const f = fixture();
    f.host.virtualList.mount = async () => Promise.reject(failure);
    await expect(new OutlineProjection().mount(f.host)).rejects.toBe(failure);
    expect(f.diagnostics.at(-1)).toMatchObject({ code: 'mount-failed', phase: 'mount' });

    const healthy = fixture();
    const instance = await new OutlineProjection().mount(healthy.host);
    instance.destroy();
    instance.destroy();
    expect(healthy.destroys()).toBe(1);
    expect(() => instance.render(model([]))).toThrow('outline.render called after destroy');
    expect(() => instance.applySelection(EMPTY_SELECTION)).toThrow(
      'outline.applySelection called after destroy',
    );
    expect(() => instance.applyFocus(EMPTY_FOCUS)).toThrow(
      'outline.applyFocus called after destroy',
    );
    expect(() => instance.revealFocus()).toThrow('outline.revealFocus called after destroy');
    expect(() => instance.captureViewState()).toThrow(
      'outline.captureViewState called after destroy',
    );
    expect(() => instance.restoreViewState(null)).toThrow(
      'outline.restoreViewState called after destroy',
    );
  });
});
