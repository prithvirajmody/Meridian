/**
 * Random `LodRequest`s over a random forest, for the resolver property suites.
 * A request mixes real node ids (as override/focus targets) with occasional
 * ghosts, a random zoom, an optional budget and an optional prevLevel — the
 * whole surface the resolver must handle without ever throwing.
 */
import fc from 'fast-check';
import { asNodeId, type GraphSpace, type NodeId } from '@meridian/graph-core';
import type { LodRequest, OverrideKind } from '../src/index.js';

export function allNodeIds(space: GraphSpace): NodeId[] {
  const out: NodeId[] = [];
  for (const graph of space.graphs.values()) for (const nodeId of graph.nodes.keys()) out.push(nodeId);
  return out;
}

const KINDS: readonly OverrideKind[] = ['pin', 'expand', 'collapse'];

/** A random request for a specific already-materialized space. */
export function requestArb(space: GraphSpace): fc.Arbitrary<LodRequest> {
  const nodeIds = allNodeIds(space);
  const ghostId = fc.integer({ min: 0, max: 99_999 }).map((k) => asNodeId(`ghost-${k}`));
  const anyId: fc.Arbitrary<NodeId> =
    nodeIds.length > 0
      ? fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...nodeIds) }, { weight: 1, arbitrary: ghostId })
      : ghostId;

  const overridesArb = fc
    .array(fc.tuple(anyId, fc.constantFrom(...KINDS)), { maxLength: 8 })
    .map((pairs) => new Map<NodeId, OverrideKind>(pairs));

  return fc.record({
    zoom: fc.double({ min: 0, max: 1, noNaN: true }),
    overrides: overridesArb,
    focus: fc.option(anyId, { nil: undefined }),
    viewportHint: fc.option(fc.record({ maxNodes: fc.integer({ min: 0, max: 20 }) }), { nil: undefined }),
    prevLevel: fc.option(fc.integer({ min: 0, max: 6 }), { nil: undefined }),
  });
}
