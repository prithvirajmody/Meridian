import { describe, expect, it } from 'vitest';
import {
  buildRenderModel,
  EDGE_FLAG_SELECTED,
  LABEL_CLASS_CONNECTED,
  LABEL_CLASS_FORCED,
  LABEL_CLASS_SUMMARY,
  NODE_FLAG_HAS_DETAIL,
  NODE_FLAG_SELECTED,
  NODE_FLAG_SELECTION_ANCHOR,
} from '../src/index.js';
import { edge, layoutOf, lodOf, n, node, spaceOf } from './helpers.js';

describe('buildRenderModel', () => {
  it('builds deterministic flat arrays from hand-built semantic/LOD/layout inputs', () => {
    const relation = edge('n-a', 'n-b');
    const snapshot = spaceOf([
      node('n-a', 'Alpha', 'test:group', 'g-a-detail'),
      node('n-b', 'Beta'),
      node('n-c', 'Gamma'),
    ]);
    // Deliberately ragged input ordering: the model boundary canonicalizes it.
    const lod = lodOf(['n-c', 'n-a', 'n-b'], [relation], { 'n-a': 4 });
    const key = 'n-a→n-b→test:rel';
    const layout = layoutOf(
      {
        'n-c': { x: 50, y: 5, width: 10, height: 10 },
        'n-a': { x: 0, y: 0, width: 20, height: 10 },
        'n-b': { x: 30, y: 0, width: 10, height: 10 },
      },
      new Map([[key, [{ x: 10, y: 5 }, { x: 20, y: 40 }, { x: 35, y: 5 }]]]),
    );

    const selection = {
      nodes: [n('n-c')],
      edges: [key],
      anchor: { kind: 'node' as const, id: n('n-a') },
    };
    const model = buildRenderModel(snapshot, lod, layout, selection);

    expect(model.nodeIds).toEqual([n('n-a'), n('n-b'), n('n-c')]);
    expect([...model.nodeRects]).toEqual([
      0, 0, 20, 10,
      30, 0, 10, 10,
      50, 5, 10, 10,
    ]);
    expect(model.bounds).toEqual({ x: 0, y: 0, width: 60, height: 40 });
    expect(model.nodeColorKeys).toEqual(['test:group', 'test:item']);
    expect([...model.nodeColorIds]).toEqual([0, 1, 1]);
    expect(model.labelTable).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect([...model.labelRefs]).toEqual([0, 1, 2]);
    expect([...model.nodeDegrees]).toEqual([1, 1, 0]);
    expect([...model.nodeCoveredLeaves]).toEqual([4, 1, 1]);
    expect([...model.labelClasses]).toEqual([
      LABEL_CLASS_FORCED,
      LABEL_CLASS_CONNECTED,
      LABEL_CLASS_SUMMARY,
    ]);
    expect(model.nodeFlags[0]).toBe(NODE_FLAG_HAS_DETAIL | NODE_FLAG_SELECTION_ANCHOR);
    expect(model.nodeFlags[2]).toBe(NODE_FLAG_SELECTED);

    expect(model.edgeKeys).toEqual([key]);
    expect([...model.edgeIndices]).toEqual([0, 1]);
    expect(model.edgeColorKeys).toEqual(['test:rel']);
    expect([...model.edgeWeights]).toEqual([2]);
    expect([...model.edgeMultiplicities]).toEqual([3]);
    expect(model.edgeFlags[0]).toBe(EDGE_FLAG_SELECTED);
    expect([...model.edgeRouteOffsets]).toEqual([0, 3]);
    expect([...model.edgeRoutePoints]).toEqual([10, 5, 20, 40, 35, 5]);
    expect(model.diagnostics).toEqual([]);

    const second = buildRenderModel(snapshot, lod, layout, selection);
    expect(second.revision).toBe(model.revision);
    expect(structuredClone(model)).toEqual(model);
  });

  it('returns a canonical empty model for a zero-node cut', () => {
    const model = buildRenderModel(spaceOf([]), lodOf([]), layoutOf({}));
    expect(model.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(model.nodeIds).toEqual([]);
    expect(model.nodeRects).toHaveLength(0);
    expect(model.edgeIndices).toHaveLength(0);
    expect(model.edgeRouteOffsets).toEqual(new Uint32Array([0]));
    expect(model.diagnostics).toEqual([]);
  });
});
