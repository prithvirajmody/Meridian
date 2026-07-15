import {
  asGraphId,
  type AttrBag,
  type AttrValue,
  type GraphSpace,
  type SemanticGraph,
  type SemanticNode,
  type SourceRef,
} from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import {
  buildProjectionModel,
  buildRenderModel,
  createFocusState,
  type DomainMeta,
  type SelectionState,
} from '../src/index.js';
import { edge, layoutOf, lodOf, n, node, spaceOf } from './helpers.js';

const DOMAIN: DomainMeta = {
  domain: 'test',
  label: 'Test corpus',
  temporal: {
    startAttribute: 'test:start',
    endAttribute: 'test:end',
    laneAttribute: 'test:lane',
  },
};

const UNLOCATED_SOURCE: SourceRef = { origin: 'source' };

function semanticNode(
  id: string,
  attrs: AttrBag = {},
  options: {
    readonly detail?: string;
    readonly provenance?: SourceRef;
    readonly label?: string;
  } = {},
): SemanticNode {
  return {
    id: n(id),
    label: options.label ?? id,
    kind: 'test:item',
    attrs,
    provenance: options.provenance ?? UNLOCATED_SOURCE,
    ...(options.detail === undefined ? {} : { detail: { graph: asGraphId(options.detail) } }),
  };
}

function semanticGraph(id: string, nodes: readonly SemanticNode[]): SemanticGraph {
  return {
    id: asGraphId(id),
    meta: { label: id, domain: 'test', provenance: UNLOCATED_SOURCE },
    nodes: new Map(nodes.map((value) => [value.id, value])),
    edges: new Map(),
  };
}

function lodFor(snapshot: GraphSpace, members: readonly string[]) {
  const lod = lodOf(members);
  const containingGraphs = new Map(
    [...snapshot.graphs.entries()].flatMap(([graphId, graph]) =>
      [...graph.nodes.keys()].map((nodeId) => [nodeId, graphId] as const),
    ),
  );
  return {
    ...lod,
    cut: {
      ...lod.cut,
      trace: new Map(
        members.map((id) => {
          const nodeId = n(id);
          return [
            nodeId,
            {
              node: nodeId,
              graph: containingGraphs.get(nodeId) ?? asGraphId('g-root'),
              depth: 0,
              reason: 'level' as const,
              coveredLeaves: 1,
            },
          ] as const;
        }),
      ),
    },
  };
}

describe('projection identity values', () => {
  it('normalizes navigation-owned optional focus without introducing authority', () => {
    expect(createFocusState()).toEqual({ node: null });
    expect(createFocusState(null)).toEqual({ node: null });
    expect(createFocusState(n('focused'))).toEqual({ node: n('focused') });
  });
});

describe('buildProjectionModel', () => {
  it('copies the exact cut, semantic fields, induced edges, identity, and containment context', () => {
    const root = node('root', 'Root', 'test:group', 'g-detail');
    const child: SemanticNode = {
      ...node('child', 'Child', 'test:item'),
      attrs: { 'test:tags': ['one', 'two'], 'test:start': '2026-07-15T00:00:00Z' },
    };
    const snapshot = spaceOf([root]);
    const detail = snapshot.graphs.get(asGraphId('g-detail'))!;
    (detail.nodes as Map<ReturnType<typeof n>, SemanticNode>).set(child.id, child);
    const lod = lodOf(['child'], [edge('child', 'child', 'test:self')]);
    const trace = new Map(lod.cut.trace);
    trace.set(child.id, {
      node: child.id,
      graph: asGraphId('g-detail'),
      depth: 1,
      reason: 'expand-parent',
      coveredLeaves: 4,
    });
    const nestedLod = { ...lod, cut: { ...lod.cut, level: 1, trace } };
    const selection: SelectionState = {
      nodes: [child.id, child.id],
      edges: ['child→child→test:self'],
      anchor: { kind: 'node', id: child.id },
    };

    const model = buildProjectionModel(snapshot, nestedLod, {
      selection,
      focus: createFocusState(child.id),
      domainMeta: DOMAIN,
    });

    expect(model.nodes).toEqual([
      {
        id: child.id,
        orderPath: [0, 0, 0],
        label: 'Child',
        kind: 'test:item',
        attrs: { 'test:start': '2026-07-15T00:00:00Z', 'test:tags': ['one', 'two'] },
        graphId: asGraphId('g-detail'),
        parentId: root.id,
        detailGraphId: null,
        depth: 1,
        cutReason: 'expand-parent',
        coveredLeaves: 4,
        temporal: {
          start: Date.parse('2026-07-15T00:00:00Z'),
          end: Date.parse('2026-07-15T00:00:00Z'),
        },
      },
    ]);
    expect(model.diagnostics).toEqual([]);
    expect(model.inducedEdges).toEqual(nestedLod.inducedEdges);
    expect(model.selection).toEqual(selection);
    expect(model.selection).not.toBe(selection);
    expect(model.focus).toEqual({ node: child.id });
    expect(model.domainMeta).toEqual(DOMAIN);
    expect(model).not.toHaveProperty('layout');
    expect(model).not.toHaveProperty('renderModel');
    expect(structuredClone(model)).toEqual(model);

    const copiedTags = model.nodes[0]!.attrs['test:tags'] as readonly string[];
    const sourceTags = child.attrs['test:tags'] as readonly string[];
    expect(copiedTags).not.toBe(sourceTags);
  });

  it('derives the map model only through the behavior-locked builder when layout exists', () => {
    const snapshot = spaceOf([node('b', 'Beta'), node('a', 'Alpha')]);
    const lod = lodOf(['b', 'a'], [edge('a', 'b')]);
    const layout = layoutOf({
      a: { x: 10, y: 20, width: 30, height: 40 },
      b: { x: 90, y: 80, width: 20, height: 10 },
    });
    const selection: SelectionState = { nodes: [n('a')], edges: [] };

    const model = buildProjectionModel(snapshot, lod, { layout, selection });

    expect(model.renderModel).toEqual(buildRenderModel(snapshot, lod, layout, selection));
    expect(model.layout).toEqual(layout);
    expect(model.layout).not.toBe(layout);
    expect(model.layout!.positions).not.toBe(layout.positions);
    expect(structuredClone(model)).toEqual(model);
  });

  it('does not apply projection-specific or provenance filtering', () => {
    const aiNode: SemanticNode = {
      ...node('ai', 'AI node'),
      attrs: { 'test:visible': true as AttrValue },
      provenance: { origin: 'ai', model: 'fixture' },
    };
    const sourceNode = node('source', 'Source node');
    const snapshot = spaceOf([aiNode, sourceNode]);
    const lod = lodOf(['source', 'ai'], [edge('ai', 'source')]);

    const model = buildProjectionModel(snapshot, lod);

    expect(model.nodes.map((value) => value.id)).toEqual([n('source'), n('ai')]);
    expect(model.inducedEdges).toHaveLength(1);
  });

  it('derives canonical semantic forest paths without map or NodeId insertion order', () => {
    const earlyChild = semanticNode('z-early-child', { 'test:index': 1 });
    const lateChild = semanticNode('a-late-child', { 'test:index': 9 });
    const nodes = {
      indexFirst: semanticNode('z-index-first', { 'z:index': 0, 'a:index': 0 }),
      indexSecond: semanticNode('a-index-second', { 'test:index': 1 }),
      provenanceFirst: semanticNode('z-provenance-first', {}, {
        provenance: { origin: 'source', uri: 'file:test', span: [1, 2] },
      }),
      provenanceSecond: semanticNode('a-provenance-second', {}, {
        provenance: { origin: 'source', uri: 'file:test', span: [8, 9] },
      }),
      earlyContainer: semanticNode('z-early-container', {}, { detail: 'g-early' }),
      lateContainer: semanticNode('a-late-container', {}, { detail: 'g-late' }),
      fallbackFirst: semanticNode('a-fallback'),
      fallbackSecond: semanticNode('z-fallback'),
      otherRoot: semanticNode('a-other-root', { 'test:index': 0 }),
    };

    const graphAForward = semanticGraph('g-a', [
      nodes.fallbackSecond,
      nodes.lateContainer,
      nodes.provenanceSecond,
      nodes.indexSecond,
      nodes.earlyContainer,
      nodes.provenanceFirst,
      nodes.indexFirst,
      nodes.fallbackFirst,
    ]);
    const graphAReverse = semanticGraph('g-a', [...graphAForward.nodes.values()].reverse());
    const earlyForward = semanticGraph('g-early', [earlyChild]);
    const earlyReverse = semanticGraph('g-early', [earlyChild]);
    const lateForward = semanticGraph('g-late', [lateChild]);
    const lateReverse = semanticGraph('g-late', [lateChild]);
    const graphZForward = semanticGraph('g-z', [nodes.otherRoot]);
    const graphZReverse = semanticGraph('g-z', [nodes.otherRoot]);
    const forward: GraphSpace = {
      graphs: new Map([
        [graphZForward.id, graphZForward],
        [lateForward.id, lateForward],
        [graphAForward.id, graphAForward],
        [earlyForward.id, earlyForward],
      ]),
      roots: [graphZForward.id, graphAForward.id],
    };
    const reverse: GraphSpace = {
      graphs: new Map([
        [earlyReverse.id, earlyReverse],
        [graphAReverse.id, graphAReverse],
        [lateReverse.id, lateReverse],
        [graphZReverse.id, graphZReverse],
      ]),
      roots: [graphAReverse.id, graphZReverse.id],
    };
    const members = [
      'z-fallback',
      'a-other-root',
      'a-late-child',
      'a-index-second',
      'z-early-container',
      'z-provenance-first',
      'a-fallback',
      'z-index-first',
      'a-provenance-second',
      'a-late-container',
      'z-early-child',
    ];

    const forwardModel = buildProjectionModel(forward, lodFor(forward, members));
    const reverseModel = buildProjectionModel(reverse, lodFor(reverse, [...members].reverse()));
    const identitiesAndPaths = (model: ReturnType<typeof buildProjectionModel>) =>
      model.nodes.map((value) => [value.id, value.orderPath]);

    expect(identitiesAndPaths(forwardModel)).toEqual([
      [n('z-index-first'), [0, 0]],
      [n('a-index-second'), [0, 1]],
      [n('z-provenance-first'), [0, 2]],
      [n('a-provenance-second'), [0, 3]],
      [n('z-early-container'), [0, 4]],
      [n('z-early-child'), [0, 4, 0]],
      [n('a-late-container'), [0, 5]],
      [n('a-late-child'), [0, 5, 0]],
      [n('a-fallback'), [0, 6]],
      [n('z-fallback'), [0, 7]],
      [n('a-other-root'), [1, 0]],
    ]);
    expect(identitiesAndPaths(reverseModel)).toEqual(identitiesAndPaths(forwardModel));
  });

  it('keeps semantic paths stable when the caller filters the visible cut', () => {
    const first = semanticNode('z-first', { 'test:index': 0 });
    const survivor = semanticNode('a-survivor', { 'test:index': 1 });
    const snapshot: GraphSpace = {
      graphs: new Map([[asGraphId('g-root'), semanticGraph('g-root', [survivor, first])]]),
      roots: [asGraphId('g-root')],
    };

    const full = buildProjectionModel(snapshot, lodFor(snapshot, ['a-survivor', 'z-first']));
    const filtered = buildProjectionModel(snapshot, lodFor(snapshot, ['a-survivor']));

    expect(full.nodes.find((value) => value.id === survivor.id)?.orderPath).toEqual([0, 1]);
    expect(filtered.nodes[0]?.orderPath).toEqual([0, 1]);
    expect(filtered.nodes[0]?.attrs).toEqual(full.nodes.find((value) => value.id === survivor.id)?.attrs);
  });

});
