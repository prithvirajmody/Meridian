/**
 * Test fixtures: build real `GraphSpace`s and cuts from tiny tree specs, plus
 * hand-made `LayoutResult`s. Spaces are materialized through graph-core's
 * public constructors bottom-up (a detail graph must exist before the node that
 * claims it, U3). Cuts come from the real `buildCut` where possible; `cutOf`
 * wraps an arbitrary member set (deriveRefinementMap / planTransition read only
 * `.members` / `.positions`) for mixed-override and empty-cut fixtures.
 */
import {
  addGraph,
  addNode,
  asGraphId,
  asNodeId,
  type GraphId,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';
import { buildCut, buildLevelChain, type Cut } from '@meridian/abstraction';
import type { LayoutResult, NodeId, Rect } from '@meridian/view-model';

const SRC: SourceRef = { origin: 'source', uri: 'test://nav' };

/** A tree spec: `{ id, children }`. A node with children gets a detail graph. */
export interface Spec {
  readonly id: string;
  readonly children?: readonly Spec[];
}

/** Materialize root-level specs into a valid `GraphSpace`. */
export function buildSpace(roots: readonly Spec[]): GraphSpace {
  const rootGraphId = asGraphId('g-root');
  let space = addGraph(
    { graphs: new Map(), roots: [] },
    { id: rootGraphId, label: 'root', domain: 'test', provenance: SRC },
  );
  let graphCounter = 0;

  const addChildren = (graph: GraphId, specs: readonly Spec[]): void => {
    for (const spec of specs) {
      if (spec.children !== undefined && spec.children.length > 0) {
        const detailId = asGraphId(`g-${graphCounter++}`);
        space = addGraph(space, { id: detailId, label: 'detail', domain: 'test', provenance: SRC });
        addChildren(detailId, spec.children); // populate before claiming (U3)
        space = addNode(space, graph, {
          id: asNodeId(spec.id),
          kind: 'test:group',
          label: spec.id,
          detail: { graph: detailId },
          provenance: SRC,
        });
      } else {
        space = addNode(space, graph, {
          id: asNodeId(spec.id),
          kind: 'test:leaf',
          label: spec.id,
          provenance: SRC,
        });
      }
    }
  };

  addChildren(rootGraphId, roots);
  return space;
}

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The real default cut at `level` (I5-covering antichain). */
export function cutAt(space: GraphSpace, level: number): Cut {
  return buildCut(space, buildLevelChain(space), level);
}

/** A minimal `Cut` over an explicit member set — for mixed-override / empty
 * fixtures the level-based builder cannot express. Only `.members` is read by
 * the planners; the trace/coverage are stubs. */
export function cutOf(members: readonly string[]): Cut {
  const ids = members.map((m) => asNodeId(m)).sort(compareIds);
  return {
    level: 0,
    members: ids,
    trace: new Map(),
    coverage: { leaves: ids.length, coveredLeaves: ids.length, covers: true },
  };
}

/** A `LayoutResult` from an id→rect map (bounds/stability filled trivially). */
export function layoutOf(
  positions: Readonly<Record<string, Rect>>,
  opts: { readonly edgeRoutes?: ReadonlyMap<string, readonly { x: number; y: number }[]> } = {},
): LayoutResult {
  const map = new Map<NodeId, Rect>();
  for (const [id, rect] of Object.entries(positions)) map.set(asNodeId(id), rect);
  return {
    positions: map,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    stability: 1,
    ...(opts.edgeRoutes !== undefined ? { edgeRoutes: opts.edgeRoutes } : {}),
  };
}

/** Shorthand rect. */
export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export { asNodeId };
