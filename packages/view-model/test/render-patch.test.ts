import { describe, expect, it } from 'vitest';
import { buildRenderModel, diffRenderModels } from '../src/index.js';
import { edge, layoutOf, lodOf, n, node, spaceOf } from './helpers.js';

function base() {
  const relation = edge('n-a', 'n-b');
  const space = spaceOf([node('n-a', 'Alpha'), node('n-b', 'Beta')]);
  const lod = lodOf(['n-a', 'n-b'], [relation]);
  const layout = layoutOf({
    'n-a': { x: 0, y: 0, width: 20, height: 10 },
    'n-b': { x: 40, y: 0, width: 20, height: 10 },
  });
  return { space, lod, layout, model: buildRenderModel(space, lod, layout) };
}

describe('diffRenderModels', () => {
  it('returns an empty patch for equal revisions', () => {
    const { model } = base();
    const patch = diffRenderModels(model, structuredClone(model));
    expect(patch.topologyChanged).toBe(false);
    expect(patch.geometryChanged).toBe(false);
    expect([...patch.changedNodeIndices]).toEqual([]);
    expect([...patch.changedEdgeIndices]).toEqual([]);
  });

  it('locates style-only node changes without declaring geometry dirty', () => {
    const { model } = base();
    const flags = model.nodeFlags.slice();
    flags[1] = 1;
    const next = { ...model, revision: 'selected', nodeFlags: flags };
    const patch = diffRenderModels(model, next);
    expect(patch.topologyChanged).toBe(false);
    expect(patch.geometryChanged).toBe(false);
    expect([...patch.changedNodeIndices]).toEqual([1]);
    expect([...patch.movedNodeIndices]).toEqual([]);
  });

  it('marks moved nodes and their incident straight edges', () => {
    const { model } = base();
    const rects = model.nodeRects.slice();
    rects[4] = 50;
    const next = { ...model, revision: 'moved', nodeRects: rects };
    const patch = diffRenderModels(model, next);
    expect(patch.geometryChanged).toBe(true);
    expect([...patch.changedNodeIndices]).toEqual([1]);
    expect([...patch.movedNodeIndices]).toEqual([1]);
    expect([...patch.changedEdgeIndices]).toEqual([0]);
  });

  it('requires a topology rebuild when identities change', () => {
    const { space, layout, model } = base();
    const next = buildRenderModel(space, lodOf(['n-a']), layout);
    const patch = diffRenderModels(model, next);
    expect(patch.topologyChanged).toBe(true);
    expect(patch.geometryChanged).toBe(true);
    expect([...patch.changedNodeIndices]).toEqual([0]);
    expect(next.nodeIds).toEqual([n('n-a')]);
  });
});
