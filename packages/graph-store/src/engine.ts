/**
 * The op-application engine: copy-on-write working state (ADR-0006) plus
 * per-op precondition checks that preserve U1–U3/U7–U8 incrementally, so a
 * committed snapshot is always `validate`-clean without whole-space
 * revalidation. Shared by `store.apply`, `store.transact`, and the pure
 * `applyDelta`.
 */
import type {
  EdgeId,
  GraphId,
  GraphSpace,
  NodeId,
  SemanticEdge,
  SemanticGraph,
  SemanticNode,
} from '@meridian/graph-core';
import type { EngineIndexView } from './indices.js';
import type { GraphOp, GraphOpInput } from './ops.js';
import {
  assertPrev,
  canonEdge,
  canonMeta,
  canonNode,
  checkAttrKey,
  checkAttrValue,
  checkId,
  OpViolation,
} from './payload.js';

interface MutableGraph {
  readonly id: GraphId;
  meta: SemanticGraph['meta'];
  readonly nodes: Map<NodeId, SemanticNode>;
  readonly edges: Map<EdgeId, SemanticEdge>;
}

/** Binary insert into a sorted GraphId array (roots stay canonical). */
function insertSorted(arr: GraphId[], id: GraphId): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < id) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, id);
}

function removeSorted(arr: GraphId[], id: GraphId): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < id) lo = mid + 1;
    else hi = mid;
  }
  if (arr[lo] === id) arr.splice(lo, 1);
}

export class Engine {
  private graphsW: Map<GraphId, SemanticGraph> | null = null;
  /** Graphs whose nodes/edges maps are already fresh copies (copy once). */
  private readonly copied = new Set<GraphId>();
  private rootsW: GraphId[] | null = null;
  readonly view: EngineIndexView;
  readonly touchedGraphs = new Set<GraphId>();
  readonly touchedNodes = new Set<NodeId>();
  readonly ops: GraphOp[] = [];

  constructor(
    private readonly base: GraphSpace,
    view: EngineIndexView,
  ) {
    this.view = view;
  }

  // ------------------------------------------------------------- reads

  private graphs(): ReadonlyMap<GraphId, SemanticGraph> {
    return this.graphsW ?? this.base.graphs;
  }

  graphOf(id: GraphId): SemanticGraph | undefined {
    return this.graphs().get(id);
  }

  requireGraph(id: GraphId, what: string): SemanticGraph {
    const g = this.graphs().get(id);
    if (!g) throw new OpViolation('unknown-graph', `${what}: graph "${id}" does not exist`, { graphId: String(id) });
    return g;
  }

  requireNode(graph: SemanticGraph, id: NodeId, what: string): SemanticNode {
    const n = graph.nodes.get(id);
    if (!n) {
      throw new OpViolation('unknown-node', `${what}: node "${id}" is not in graph "${graph.id}"`, {
        graphId: String(graph.id),
        elementId: String(id),
      });
    }
    return n;
  }

  /** Element ids are unique across the whole space (graphs, nodes, edges). */
  private requireFreshId(id: string, what: string, where: { graphId?: string }): void {
    if (
      this.graphs().has(id as GraphId) ||
      this.view.nodeGraphOf(id as NodeId) !== undefined ||
      this.view.edgeGraphOf(id as EdgeId) !== undefined
    ) {
      throw new OpViolation(
        'duplicate-id',
        `${what}: ID "${id}" is already used — IDs are unique across the space (ADR-0002)`,
        { ...where, elementId: id },
      );
    }
  }

  // ------------------------------------------------------------ writes

  private graphsForWrite(): Map<GraphId, SemanticGraph> {
    if (!this.graphsW) this.graphsW = new Map(this.base.graphs);
    return this.graphsW;
  }

  private graphForWrite(id: GraphId): MutableGraph {
    const gs = this.graphsForWrite();
    const g = gs.get(id)!;
    if (!this.copied.has(id)) {
      const copy: MutableGraph = {
        id: g.id,
        meta: g.meta,
        nodes: new Map(g.nodes),
        edges: new Map(g.edges),
      };
      gs.set(id, copy as unknown as SemanticGraph);
      this.copied.add(id);
      return copy;
    }
    return g as unknown as MutableGraph;
  }

  private rootsForWrite(): GraphId[] {
    if (!this.rootsW) this.rootsW = [...this.base.roots];
    return this.rootsW;
  }

  // -------------------------------------------------- containment helpers

  private isRoot(graph: GraphId): boolean {
    return this.view.containmentOf(graph) === undefined;
  }

  /**
   * U2 guard: claiming `target` as the detail of a node in `host` is illegal
   * when target is host itself or any ancestor of host. O(depth) walk.
   */
  private checkNoCycle(host: GraphId, target: GraphId, what: string): void {
    let current: GraphId | undefined = host;
    while (current !== undefined) {
      if (current === target) {
        throw new OpViolation(
          'containment-cycle',
          `${what}: graph "${target}" is an ancestor of (or is) "${host}" — claiming it would create a containment cycle (U2)`,
          { graphId: String(host), elementId: String(target) },
        );
      }
      current = this.view.containmentOf(current)?.parentGraph;
    }
  }

  private claimDetail(host: GraphId, node: NodeId, target: GraphId, what: string): void {
    if (!this.graphs().has(target)) {
      throw new OpViolation('unknown-detail-graph', `${what}: detail graph "${target}" does not exist`, {
        graphId: String(host),
        elementId: String(node),
      });
    }
    if (!this.isRoot(target)) {
      throw new OpViolation(
        'detail-not-root',
        `${what}: graph "${target}" is already the detail of another node (U3)`,
        { graphId: String(host), elementId: String(node) },
      );
    }
    this.checkNoCycle(host, target, what);
    this.view.setContainment(target, { parentGraph: host, parentNode: node });
    removeSorted(this.rootsForWrite(), target);
    this.touchedGraphs.add(target);
  }

  private releaseDetail(target: GraphId): void {
    this.view.clearContainment(target);
    insertSorted(this.rootsForWrite(), target);
    this.touchedGraphs.add(target);
  }

  // -------------------------------------------------------------- apply

  /** Apply one input op; returns the completed (invertible) canonical op. */
  applyOp(op: GraphOpInput): GraphOp {
    const out = this.applyOpInner(op);
    this.ops.push(out);
    return out;
  }

  private applyOpInner(op: GraphOpInput): GraphOp {
    switch (op.t) {
      case 'graph:add': {
        const graph = checkId(op.graph, 'graph:add', {}) as GraphId;
        const meta = canonMeta(op.meta, 'graph:add', { graphId: String(graph) });
        this.requireFreshId(graph, 'graph:add', {});
        this.graphsForWrite().set(graph, { id: graph, meta, nodes: new Map(), edges: new Map() });
        this.copied.add(graph);
        insertSorted(this.rootsForWrite(), graph);
        this.touchedGraphs.add(graph);
        return { t: 'graph:add', graph, meta };
      }

      case 'graph:remove': {
        const graph = op.graph;
        const g = this.requireGraph(graph, 'graph:remove');
        if (g.nodes.size > 0 || g.edges.size > 0) {
          throw new OpViolation(
            'graph-not-empty',
            `graph:remove: graph "${graph}" still has ${g.nodes.size} nodes and ${g.edges.size} edges — remove contents first`,
            { graphId: String(graph) },
          );
        }
        const containing = this.view.containmentOf(graph);
        if (containing) {
          throw new OpViolation(
            'graph-contained',
            `graph:remove: graph "${graph}" is the detail of node "${containing.parentNode}" — clear that detail first (U1)`,
            { graphId: String(graph) },
          );
        }
        assertPrev(op.prev, g.meta, 'graph:remove', { graphId: String(graph) });
        this.graphsForWrite().delete(graph);
        this.copied.delete(graph);
        removeSorted(this.rootsForWrite(), graph);
        this.touchedGraphs.add(graph);
        return { t: 'graph:remove', graph, prev: g.meta };
      }

      case 'graph:meta': {
        const graph = op.graph;
        const g = this.requireGraph(graph, 'graph:meta');
        assertPrev(op.prev, g.meta, 'graph:meta', { graphId: String(graph) });
        const next = canonMeta(op.next, 'graph:meta', { graphId: String(graph) });
        const prev = g.meta;
        const mut = this.graphForWrite(graph);
        mut.meta = next;
        this.touchedGraphs.add(graph);
        return { t: 'graph:meta', graph, prev, next };
      }

      case 'node:add': {
        const graph = op.graph;
        this.requireGraph(graph, 'node:add');
        const node = canonNode(op.node, 'node:add', { graphId: String(graph) });
        this.requireFreshId(node.id, 'node:add', { graphId: String(graph) });
        if (node.detail) this.claimDetail(graph, node.id, node.detail.graph, `node:add "${node.id}"`);
        this.graphForWrite(graph).nodes.set(node.id, node);
        this.view.addNode(node.id, graph);
        this.touchedGraphs.add(graph);
        this.touchedNodes.add(node.id);
        return { t: 'node:add', graph, node };
      }

      case 'node:remove': {
        const graph = op.graph;
        const g = this.requireGraph(graph, 'node:remove');
        const node = this.requireNode(g, op.id, 'node:remove');
        const degree = this.view.degreeOf(op.id);
        if (degree > 0) {
          throw new OpViolation(
            'node-has-edges',
            `node:remove: node "${op.id}" still has ${degree} incident edges — remove them first (U1)`,
            { graphId: String(graph), elementId: String(op.id) },
          );
        }
        assertPrev(op.prev, node, 'node:remove', { graphId: String(graph), elementId: String(op.id) });
        if (node.detail) this.releaseDetail(node.detail.graph);
        this.graphForWrite(graph).nodes.delete(op.id);
        this.view.removeNode(op.id);
        this.touchedGraphs.add(graph);
        this.touchedNodes.add(op.id);
        return { t: 'node:remove', graph, id: op.id, prev: node };
      }

      case 'node:attr': {
        const graph = op.graph;
        const g = this.requireGraph(graph, 'node:attr');
        const node = this.requireNode(g, op.id, 'node:attr');
        const where = { graphId: String(graph), elementId: String(op.id) };
        const key = checkAttrKey(op.key, 'node:attr', where);
        const actual = node.attrs[key];
        assertPrev(op.prev, actual, `node:attr "${key}"`, where);
        let next;
        const attrs = { ...node.attrs };
        if (op.next === undefined) {
          delete attrs[key];
        } else {
          next = checkAttrValue(op.next, `node:attr "${key}"`, where);
          attrs[key] = next;
        }
        this.graphForWrite(graph).nodes.set(op.id, { ...node, attrs });
        this.touchedGraphs.add(graph);
        this.touchedNodes.add(op.id);
        return {
          t: 'node:attr',
          graph,
          id: op.id,
          key,
          ...(actual !== undefined ? { prev: actual } : {}),
          ...(next !== undefined ? { next } : {}),
        };
      }

      case 'node:detail': {
        const graph = op.graph;
        const g = this.requireGraph(graph, 'node:detail');
        const node = this.requireNode(g, op.id, 'node:detail');
        const where = { graphId: String(graph), elementId: String(op.id) };
        assertPrev(op.prev, node.detail, 'node:detail', where);
        const prev = node.detail;
        const nextGraph = op.next
          ? (checkId(op.next.graph, 'node:detail next', { graphId: String(graph) }) as GraphId)
          : undefined;
        if (prev?.graph !== nextGraph) {
          if (prev) this.releaseDetail(prev.graph);
          if (nextGraph !== undefined) this.claimDetail(graph, op.id, nextGraph, `node:detail "${op.id}"`);
        }
        this.graphForWrite(graph).nodes.set(op.id, {
          id: node.id,
          kind: node.kind,
          label: node.label,
          ...(nextGraph !== undefined ? { detail: { graph: nextGraph } } : {}),
          attrs: node.attrs,
          provenance: node.provenance,
        });
        this.touchedGraphs.add(graph);
        this.touchedNodes.add(op.id);
        return {
          t: 'node:detail',
          graph,
          id: op.id,
          ...(prev ? { prev } : {}),
          ...(nextGraph !== undefined ? { next: { graph: nextGraph } } : {}),
        };
      }

      case 'edge:add': {
        const graph = op.graph;
        const g = this.requireGraph(graph, 'edge:add');
        const edge = canonEdge(op.edge, 'edge:add', { graphId: String(graph) });
        this.requireFreshId(edge.id, 'edge:add', { graphId: String(graph) });
        for (const [endpoint, name] of [
          [edge.src, 'src'],
          [edge.dst, 'dst'],
        ] as const) {
          if (!g.nodes.has(endpoint)) {
            const elsewhere = this.view.nodeGraphOf(endpoint);
            throw new OpViolation(
              elsewhere !== undefined ? 'cross-graph-edge' : 'unknown-node',
              elsewhere !== undefined
                ? `edge:add "${edge.id}": ${name} "${endpoint}" is a node of graph "${elsewhere}", not of "${graph}" — cross-graph edges are forbidden; record the link at the lowest common graph (portal rule, ADR-0001)`
                : `edge:add "${edge.id}": ${name} "${endpoint}" does not resolve to a node in graph "${graph}" (U1)`,
              { graphId: String(graph), elementId: String(edge.id) },
            );
          }
        }
        this.graphForWrite(graph).edges.set(edge.id, edge);
        this.view.addEdge(edge.id, graph, edge.src, edge.dst);
        this.touchedGraphs.add(graph);
        this.touchedNodes.add(edge.src);
        this.touchedNodes.add(edge.dst);
        return { t: 'edge:add', graph, edge };
      }

      case 'edge:remove': {
        const graph = op.graph;
        const g = this.requireGraph(graph, 'edge:remove');
        const edge = g.edges.get(op.id);
        if (!edge) {
          throw new OpViolation('unknown-edge', `edge:remove: edge "${op.id}" is not in graph "${graph}"`, {
            graphId: String(graph),
            elementId: String(op.id),
          });
        }
        assertPrev(op.prev, edge, 'edge:remove', { graphId: String(graph), elementId: String(op.id) });
        this.graphForWrite(graph).edges.delete(op.id);
        this.view.removeEdge(op.id, edge.src, edge.dst);
        this.touchedGraphs.add(graph);
        this.touchedNodes.add(edge.src);
        this.touchedNodes.add(edge.dst);
        return { t: 'edge:remove', graph, id: op.id, prev: edge };
      }
    }
  }

  /** The next snapshot. Shares every untouched graph with the base (ADR-0006). */
  finish(): GraphSpace {
    return {
      graphs: this.graphsW ?? this.base.graphs,
      roots: this.rootsW ?? this.base.roots,
    };
  }
}
