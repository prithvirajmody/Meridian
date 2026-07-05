/**
 * GraphTransaction (ROADMAP Phase 1 §5): the ergonomic layer over the op
 * vocabulary. Ops apply eagerly against the transaction's working state, so
 * violations surface at the offending call and `removeNode` can cascade the
 * node's incident edges (as explicit edge:remove ops — the log stays honest).
 * The store commits everything atomically when the callback returns.
 */
import type {
  AttrBag,
  AttrValue,
  EdgeId,
  GraphId,
  GraphMeta,
  GraphRef,
  NodeId,
  SourceRef,
} from '@meridian/graph-core';
import { MeridianError } from '@meridian/graph-core';
import type { Engine } from './engine.js';

export interface TxGraphInit {
  readonly id: GraphId;
  readonly label: string;
  readonly domain: string;
  readonly provenance: SourceRef;
}

export interface TxNodeInit {
  readonly id: NodeId;
  readonly kind: string;
  readonly label: string;
  readonly attrs?: AttrBag;
  readonly provenance: SourceRef;
  readonly detail?: GraphRef;
}

export interface TxEdgeInit {
  readonly id: EdgeId;
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly kind: string;
  readonly weight?: number;
  readonly attrs?: AttrBag;
  readonly provenance: SourceRef;
}

export interface GraphTransaction {
  addGraph(init: TxGraphInit): void;
  /** The graph must be empty and unclaimed — compose removals explicitly. */
  removeGraph(id: GraphId): void;
  setGraphMeta(id: GraphId, meta: GraphMeta): void;
  addNode(graph: GraphId, init: TxNodeInit): void;
  /** Cascades the node's incident edges as explicit edge:remove ops. */
  removeNode(graph: GraphId, id: NodeId): void;
  /** `value: undefined` removes the key. */
  setAttr(graph: GraphId, id: NodeId, key: string, value: AttrValue | undefined): void;
  /** `ref: undefined` clears the detail, releasing the child graph to root. */
  setDetail(graph: GraphId, id: NodeId, ref: GraphRef | undefined): void;
  addEdge(graph: GraphId, init: TxEdgeInit): void;
  removeEdge(graph: GraphId, id: EdgeId): void;
}

export class GraphTransactionImpl implements GraphTransaction {
  private open = true;

  constructor(private readonly engine: Engine) {}

  /** Called by the store after the callback returns; late use is a bug. */
  close(): void {
    this.open = false;
  }

  private guard(): Engine {
    if (!this.open) {
      throw new MeridianError(
        'transaction-closed',
        'GraphTransaction used after its callback returned — transactions do not escape their scope',
      );
    }
    return this.engine;
  }

  addGraph(init: TxGraphInit): void {
    this.guard().applyOp({
      t: 'graph:add',
      graph: init.id,
      meta: { label: init.label, domain: init.domain, provenance: init.provenance },
    });
  }

  removeGraph(id: GraphId): void {
    this.guard().applyOp({ t: 'graph:remove', graph: id });
  }

  setGraphMeta(id: GraphId, meta: GraphMeta): void {
    this.guard().applyOp({ t: 'graph:meta', graph: id, next: meta });
  }

  addNode(graph: GraphId, init: TxNodeInit): void {
    this.guard().applyOp({
      t: 'node:add',
      graph,
      node: {
        id: init.id,
        kind: init.kind,
        label: init.label,
        ...(init.detail ? { detail: init.detail } : {}),
        attrs: init.attrs ?? {},
        provenance: init.provenance,
      },
    });
  }

  removeNode(graph: GraphId, id: NodeId): void {
    const engine = this.guard();
    // Deterministic cascade order: sorted incident edge ids.
    const incident = [...new Set([...engine.view.outOf(id), ...engine.view.inOf(id)])].sort();
    for (const edgeId of incident) {
      const owner = engine.view.edgeGraphOf(edgeId);
      engine.applyOp({ t: 'edge:remove', graph: owner ?? graph, id: edgeId });
    }
    engine.applyOp({ t: 'node:remove', graph, id });
  }

  setAttr(graph: GraphId, id: NodeId, key: string, value: AttrValue | undefined): void {
    this.guard().applyOp({
      t: 'node:attr',
      graph,
      id,
      key,
      ...(value !== undefined ? { next: value } : {}),
    });
  }

  setDetail(graph: GraphId, id: NodeId, ref: GraphRef | undefined): void {
    this.guard().applyOp({
      t: 'node:detail',
      graph,
      id,
      ...(ref !== undefined ? { next: ref } : {}),
    });
  }

  addEdge(graph: GraphId, init: TxEdgeInit): void {
    this.guard().applyOp({
      t: 'edge:add',
      graph,
      edge: {
        id: init.id,
        src: init.src,
        dst: init.dst,
        kind: init.kind,
        ...(init.weight !== undefined ? { weight: init.weight } : {}),
        attrs: init.attrs ?? {},
        provenance: init.provenance,
      },
    });
  }

  removeEdge(graph: GraphId, id: EdgeId): void {
    this.guard().applyOp({ t: 'edge:remove', graph, id });
  }
}
