/**
 * Breadcrumb truthfulness property (ROADMAP §11): the context stack ≡ a replay
 * of the nav events. Breadcrumbs are derived from containment + the stack
 * (ADR-0025), so for ANY sequence of drill-in/out verbs the controller's
 * breadcrumb graph path must equal the graph stack an independent replay
 * builds. A stored breadcrumb list could drift; a derived one cannot.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ZoomPolicy } from '@meridian/abstraction';
import type { GraphId, GraphSpace, NodeId, SemanticGraph } from '@meridian/view-model';
import { NavigationController } from '../src/controller.js';
import { buildSpace } from './helpers.js';

const SPACE = buildSpace([
  {
    id: 'A',
    children: [
      { id: 'a1', children: [{ id: 'a1x' }, { id: 'a1y' }] },
      { id: 'a2', children: [{ id: 'a2x' }] },
    ],
  },
  { id: 'B', children: [{ id: 'b1', children: [{ id: 'b1x' }] }] },
]);
const POLICY: ZoomPolicy = { thresholds: [0.5], hysteresis: 0.1 };
const VIEWPORT = { width: 100, height: 100 };

function graphOfNode(space: GraphSpace, id: NodeId): SemanticGraph | undefined {
  for (const graph of space.graphs.values()) if (graph.nodes.has(id)) return graph;
  return undefined;
}

function detailGraphId(space: GraphSpace, id: NodeId): GraphId | undefined {
  const graph = graphOfNode(space, id);
  return graph?.nodes.get(id)?.detail?.graph;
}

/** Every graph id reachable from `root` via detail refs (the drilled subtree). */
function subtreeGraphIds(space: GraphSpace, root: GraphId): Set<GraphId> {
  const seen = new Set<GraphId>();
  const stack: GraphId[] = [root];
  while (stack.length > 0) {
    const g = stack.pop()!;
    if (seen.has(g)) continue;
    seen.add(g);
    const graph = space.graphs.get(g);
    if (graph === undefined) continue;
    for (const node of graph.nodes.values()) {
      const d = node.detail?.graph;
      if (d !== undefined && !seen.has(d)) stack.push(d);
    }
  }
  return seen;
}

/** Nodes in the current working-root subtree that have a detail graph — the
 * legal drill targets for that context. */
function contextCandidates(space: GraphSpace, workingRoot: GraphId): NodeId[] {
  const out: NodeId[] = [];
  for (const g of subtreeGraphIds(space, workingRoot)) {
    const graph = space.graphs.get(g);
    if (graph === undefined) continue;
    for (const node of graph.nodes.values()) if (node.detail?.graph !== undefined) out.push(node.id);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('breadcrumb truthfulness — context stack ≡ replay of nav events', () => {
  it('holds for any random drill-in/out sequence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ op: fc.constantFrom<'in' | 'out'>('in', 'out'), pick: fc.nat() }), {
          maxLength: 40,
        }),
        (commands) => {
          const ctrl = new NavigationController({
            space: SPACE,
            policy: POLICY,
            viewport: VIEWPORT,
            initialZoom: 0,
          });
          const rootGraph = ctrl.context().workingRoot;
          const expected: GraphId[] = [rootGraph];

          for (const cmd of commands) {
            if (cmd.op === 'out') {
              if (expected.length > 1) {
                ctrl.drillOut();
                expected.pop();
              }
            } else {
              const candidates = contextCandidates(SPACE, expected[expected.length - 1]!);
              if (candidates.length === 0) continue;
              const node = candidates[cmd.pick % candidates.length]!;
              ctrl.drillInto(node);
              const detail = detailGraphId(SPACE, node);
              expect(detail).toBeDefined();
              expected.push(detail!);
            }
          }

          const crumbs = ctrl.context().breadcrumbs.map((b) => b.graphId);
          expect(crumbs).toEqual(expected);
          expect(ctrl.context().depth).toBe(expected.length);
        },
      ),
    );
  });
});
