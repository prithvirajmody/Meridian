/**
 * IR → GraphDocument: the deterministic conversation skeleton (§6, §7.2). The
 * containment is a three-level chain under one corpus root graph:
 *
 *   root graph                         (the export; holds one node per chat)
 *     └─ conv:session  → detail graph  (a conversation; holds its exchanges)
 *          └─ conv:exchange → detail   (a prompt + its replies; holds messages)
 *               └─ conv:message        (a leaf; its text is the node label)
 *
 * so a cut at the coarsest level shows sessions, the next shows exchanges, the
 * finest shows messages — the level chain `[session, exchange, message]` the
 * manifest declares. Every element carries **source-only** provenance; IDs are
 * derived purely through `ctx.ids` from stable `(domain, source, path)`
 * coordinates (ADR-0002), never from AI or wall-clock. Role, order, source id,
 * and timestamp survive only as declared `conv:*` attrs; message text survives
 * as the node label.
 *
 * `conv:replies-to` is the only skeleton edge. A reply's parent may, after
 * grouping, sit in a different exchange graph; U1 forbids an edge across graphs
 * (SemanticEdge is intra-graph), so we emit the edge **only when both endpoints
 * share the exchange graph** and honestly omit it otherwise (ADR-0034 — the
 * skeleton states only what it can prove). Topic/claim nodes and
 * `conv:about|refers-back` edges are AI enrichment, declared in the vocabulary
 * but never produced here.
 */
import type { GraphDocument, PluginContext, SourceDescriptor } from '@meridian/plugin-api';
import { groupExchanges } from './exchanges.js';
import type { RawConversation, RawMessage } from './format/types.js';

export const DOMAIN = 'conversation';

type WireGraph = GraphDocument['graphs'][number];
type WireNode = WireGraph['nodes'][number];
type WireEdge = WireGraph['edges'][number];
type Provenance = WireNode['provenance'];

interface MutableGraph {
  readonly id: string;
  readonly meta: WireGraph['meta'];
  readonly nodes: WireNode[];
  readonly edges: WireEdge[];
}

const PRODUCER = '@meridian/adapter-conversation';

export function buildDocument(
  ctx: PluginContext,
  src: SourceDescriptor,
  conversations: readonly RawConversation[],
  producerVersion: string,
): GraphDocument {
  const provenance: Provenance = { origin: 'source', uri: src.uri };
  const coords = (path: readonly string[]) => ({ domain: DOMAIN, source: src.uri, path: [...path] });

  const graphs: MutableGraph[] = [];
  const newGraph = (id: string, label: string): MutableGraph => {
    const graph: MutableGraph = {
      id,
      meta: { label, domain: DOMAIN, provenance },
      nodes: [],
      edges: [],
    };
    graphs.push(graph);
    return graph;
  };

  const rootGraphId = ctx.ids.graphId(coords([]));
  const rootLabel =
    conversations.length === 1 ? (conversations[0]?.title ?? src.uri) : src.uri;
  const root = newGraph(rootGraphId, rootLabel);

  const usedConvSegs = new Set<string>();
  conversations.forEach((conv, ci) => {
    // Prefer the conversation's own stable id as its coordinate segment so
    // sessions keep identity across a re-export that reorders them; fall back
    // to position, and disambiguate an id collision deterministically.
    let convSeg = conv.sourceId !== undefined && conv.sourceId.length > 0 ? conv.sourceId : `conv-${ci}`;
    if (usedConvSegs.has(convSeg)) convSeg = `${convSeg}#${ci}`;
    usedConvSegs.add(convSeg);

    const sessionPath = [convSeg];
    const sessionNodeId = ctx.ids.nodeId(coords(sessionPath));
    const sessionDetailId = ctx.ids.graphId(coords(sessionPath));
    const exchanges = groupExchanges(conv.messages);
    const sessionLabel = conv.title ?? convSeg;

    root.nodes.push({
      id: sessionNodeId,
      kind: 'conv:session',
      label: sessionLabel,
      ...(exchanges.length > 0 ? { detail: { graph: sessionDetailId } } : {}),
      attrs: {
        'conv:index': ci,
        ...(conv.sourceId !== undefined ? { 'conv:source-id': conv.sourceId } : {}),
        ...(conv.createdAt !== undefined ? { 'conv:timestamp': conv.createdAt } : {}),
      },
      provenance,
    });
    if (exchanges.length === 0) return; // an empty conversation is session-only

    const sessionGraph = newGraph(sessionDetailId, sessionLabel);
    exchanges.forEach((group, ei) => {
      const exSeg = `ex-${ei}`;
      const exPath = [convSeg, exSeg];
      const exNodeId = ctx.ids.nodeId(coords(exPath));
      const exDetailId = ctx.ids.graphId(coords(exPath));
      const exLabel = `Exchange ${ei + 1}`;

      sessionGraph.nodes.push({
        id: exNodeId,
        kind: 'conv:exchange',
        label: exLabel,
        detail: { graph: exDetailId }, // a group always holds ≥ 1 message
        attrs: { 'conv:index': ei },
        provenance,
      });

      const exGraph = newGraph(exDetailId, exLabel);
      const emitted: { readonly nodeId: string; readonly message: RawMessage }[] = [];
      const refToNodeId = new Map<string, string>();
      group.forEach((message, mi) => {
        const msgNodeId = ctx.ids.nodeId(coords([convSeg, exSeg, `m-${mi}`]));
        exGraph.nodes.push({
          id: msgNodeId,
          kind: 'conv:message',
          label: message.text,
          attrs: {
            'conv:index': mi,
            'conv:role': message.role,
            ...(message.sourceId !== undefined ? { 'conv:source-id': message.sourceId } : {}),
            ...(message.createdAt !== undefined ? { 'conv:timestamp': message.createdAt } : {}),
          },
          provenance,
        });
        emitted.push({ nodeId: msgNodeId, message });
        if (message.refId !== undefined && !refToNodeId.has(message.refId)) {
          refToNodeId.set(message.refId, msgNodeId);
        }
      });

      // Reply edges: intra-graph only (U1). Built after every node exists so a
      // parent that appears later in the group still resolves.
      for (const { nodeId, message } of emitted) {
        if (message.parentRef === undefined) continue;
        const parentNodeId = refToNodeId.get(message.parentRef);
        if (parentNodeId === undefined || parentNodeId === nodeId) continue; // omit honestly
        exGraph.edges.push({
          id: ctx.ids.edgeId({
            graph: exDetailId,
            kind: 'conv:replies-to',
            src: nodeId,
            dst: parentNodeId,
          }),
          src: nodeId,
          dst: parentNodeId,
          kind: 'conv:replies-to',
          provenance,
        });
      }
    });
  });

  return {
    formatVersion: 1,
    producer: { name: PRODUCER, version: producerVersion },
    roots: [rootGraphId],
    graphs,
  };
}
