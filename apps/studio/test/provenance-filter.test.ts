/**
 * 8F provenance helpers: `collectAiOriginNodeIds` (which nodes are AI-origin) and
 * `filterRenderModelNodes` (the evidence-only view transform). Both are pure; the
 * filter is exercised with a hand-built RenderModel so the typed-array reindex is
 * asserted directly.
 */
import { describe, expect, it } from 'vitest';
import {
  addGraph,
  addNode,
  asGraphId,
  asNodeId,
  createGraphSpace,
  type SourceRef,
} from '@meridian/graph-core';
import type { NodeId, RenderModel } from '@meridian/view-model';
import {
  aiOriginNodesInModel,
  collectAiOriginNodeIds,
  filterRenderModelNodes,
} from '../src/ai/provenance.js';

const SOURCE: SourceRef = { origin: 'source', uri: 'test://p' };
const AI: SourceRef = { origin: 'ai', model: 'claude-opus-4-8', confidence: 0.7 };

/** A tiny model: nodes a,b,c with rects, and edges a→b, b→c. */
function makeModel(): RenderModel {
  const ids = ['a', 'b', 'c'] as unknown as NodeId[];
  return {
    revision: 'rm-test',
    bounds: { x: 0, y: 0, width: 30, height: 10 },
    nodeIds: ids,
    nodeRects: Float64Array.from([0, 0, 10, 10, 10, 0, 10, 10, 20, 0, 10, 10]),
    nodeColorKeys: ['k'],
    nodeColorIds: Uint16Array.from([0, 0, 0]),
    nodeFlags: Uint8Array.from([0, 0, 0]),
    nodeCoveredLeaves: Float64Array.from([1, 1, 1]),
    nodeDegrees: Uint32Array.from([1, 2, 1]),
    labelTable: ['a', 'b', 'c'],
    labelRefs: Uint32Array.from([0, 1, 2]),
    labelClasses: Uint8Array.from([0, 0, 0]),
    edgeKeys: ['a→b→x', 'b→c→x'],
    edgeIndices: Uint32Array.from([0, 1, 1, 2]),
    edgeColorKeys: ['x'],
    edgeColorIds: Uint16Array.from([0, 0]),
    edgeWeights: Float64Array.from([1, 1]),
    edgeMultiplicities: Uint32Array.from([1, 1]),
    edgeFlags: Uint8Array.from([0, 0]),
    edgeRouteOffsets: Uint32Array.from([0, 0, 0]),
    edgeRoutePoints: Float64Array.from([]),
    diagnostics: [],
  };
}

describe('collectAiOriginNodeIds', () => {
  it('returns exactly the nodes whose provenance origin is ai', () => {
    let space = addGraph(createGraphSpace(), {
      id: asGraphId('r'),
      label: 'r',
      domain: 'doc',
      provenance: SOURCE,
    });
    space = addNode(space, asGraphId('r'), { id: asNodeId('n1'), kind: 'doc:node', label: 'n1', provenance: SOURCE });
    space = addNode(space, asGraphId('r'), { id: asNodeId('n2'), kind: 'core:cluster', label: 'n2', provenance: AI });
    const ai = collectAiOriginNodeIds(space);
    expect([...ai]).toEqual(['n2']);
  });

  it('is empty when no node is AI-origin', () => {
    let space = addGraph(createGraphSpace(), { id: asGraphId('r'), label: 'r', domain: 'doc', provenance: SOURCE });
    space = addNode(space, asGraphId('r'), { id: asNodeId('n1'), kind: 'doc:node', label: 'n1', provenance: SOURCE });
    expect(collectAiOriginNodeIds(space).size).toBe(0);
  });
});

describe('filterRenderModelNodes', () => {
  it('is identity when nothing is hidden', () => {
    const model = makeModel();
    expect(filterRenderModelNodes(model, new Set())).toBe(model);
  });

  it('drops the hidden node and every incident edge, reindexing the rest', () => {
    const model = makeModel();
    const filtered = filterRenderModelNodes(model, new Set(['a'] as unknown as NodeId[]));

    // Node 'a' gone; b,c survive in order.
    expect([...filtered.nodeIds]).toEqual(['b', 'c']);
    expect([...filtered.nodeRects]).toEqual([10, 0, 10, 10, 20, 0, 10, 10]);

    // Edge a→b dropped (touches a); b→c kept, reindexed to [0,1].
    expect([...filtered.edgeKeys]).toEqual(['b→c→x']);
    expect([...filtered.edgeIndices]).toEqual([0, 1]);

    // Degrees recomputed over surviving edges: b and c each have degree 1.
    expect([...filtered.nodeDegrees]).toEqual([1, 1]);

    // Route CSR stays consistent (m+1 offsets).
    expect(filtered.edgeRouteOffsets.length).toBe(2);
    // Shared string tables are preserved; the revision changes so consumers refresh.
    expect(filtered.nodeColorKeys).toBe(model.nodeColorKeys);
    expect(filtered.revision).not.toBe(model.revision);
  });

  it('removing every node yields an empty, consistent model', () => {
    const model = makeModel();
    const filtered = filterRenderModelNodes(model, new Set(['a', 'b', 'c'] as unknown as NodeId[]));
    expect(filtered.nodeIds).toHaveLength(0);
    expect(filtered.edgeKeys).toHaveLength(0);
    expect([...filtered.edgeRouteOffsets]).toEqual([0]);
  });

  it('aiOriginNodesInModel intersects model order with the AI set', () => {
    const model = makeModel();
    const present = aiOriginNodesInModel(model, new Set(['b', 'zzz'] as unknown as NodeId[]));
    expect(present).toEqual(['b']);
  });
});
