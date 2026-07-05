/**
 * Outline → GraphDocument (the IR, §6). The recursion: a section with
 * children becomes a node whose `detail` references the graph of its
 * children. Internal anchor links become `doc:links-to` edges placed by the
 * portal rule (ADR-0001 / §4.3): an edge between elements of different
 * graphs is recorded in their lowest common graph, between their ancestors
 * there, weighted by multiplicity.
 */
import type { GraphDocument, PluginContext, SourceDescriptor } from '@meridian/plugin-api';
import type { Outline, OutlineChild } from './outline.js';

export const DOMAIN = 'markdown';

const KIND_BY_BLOCK = {
  paragraph: 'doc:paragraph',
  code: 'doc:code',
  list: 'doc:list',
  quote: 'doc:quote',
  html: 'doc:html',
  break: 'doc:break',
} as const;

type WireGraph = GraphDocument['graphs'][number];
type WireNode = WireGraph['nodes'][number];
type WireEdge = WireGraph['edges'][number];
type Provenance = WireNode['provenance'];

/** Where an element sits: ancestor node per graph along its chain;
 * `address[i]` is the (ancestor) node in `graphs[i]`, last entry = itself. */
interface ElementAddress {
  readonly graphs: readonly string[];
  readonly address: readonly string[];
}

interface LinkOccurrence {
  readonly from: ElementAddress;
  readonly anchor: string;
  readonly provenance: Provenance;
}

export function buildDocument(
  ctx: PluginContext,
  src: SourceDescriptor,
  outline: Outline,
  producerVersion: string,
): GraphDocument {
  const text = src.text ?? '';
  const coords = (path: readonly string[]) => ({
    domain: DOMAIN,
    source: src.uri,
    path: [...path],
  });
  const provenance = (span?: readonly [number, number]): Provenance => ({
    origin: 'source',
    uri: src.uri,
    ...(span !== undefined ? { span: [span[0], span[1]] as [number, number] } : {}),
  });

  const rootGraphId = ctx.ids.graphId(coords([]));
  const graphs: (Omit<WireGraph, 'edges'> & { edges: WireEdge[] })[] = [];
  const edgesByGraph = new Map<string, WireEdge[]>();
  const sectionByAnchor = new Map<string, ElementAddress>();
  const links: LinkOccurrence[] = [];

  const newGraph = (id: string, label: string, span?: readonly [number, number]): WireNode[] => {
    const nodes: WireNode[] = [];
    const edges: WireEdge[] = [];
    graphs.push({
      id,
      meta: { label, domain: DOMAIN, provenance: provenance(span) },
      nodes,
      edges,
    });
    edgesByGraph.set(id, edges);
    return nodes;
  };

  const rootNodes = newGraph(
    rootGraphId,
    outline.title ?? src.uri,
    text.length > 0 ? [0, text.length] : undefined,
  );

  /**
   * Walk one sibling list into `graphId`. `path` are the ID segments of the
   * owning section; `graphChain`/`nodeChain` address every ancestor so link
   * endpoints can be re-based at any common graph (portal rule).
   */
  const walk = (
    children: readonly OutlineChild[],
    graphId: string,
    nodes: WireNode[],
    path: readonly string[],
    graphChain: readonly string[],
    nodeChain: readonly string[],
  ): void => {
    const blockOrdinals = new Map<string, number>();
    let index = 0;
    for (const child of children) {
      if (child.kind === 'section') {
        const childPath = [...path, child.segment];
        const nodeId = ctx.ids.nodeId(coords(childPath));
        const here: ElementAddress = {
          graphs: [...graphChain, graphId],
          address: [...nodeChain, nodeId],
        };
        sectionByAnchor.set(child.anchor, here);
        for (const anchor of child.anchors) {
          links.push({ from: here, anchor, provenance: provenance(child.span) });
        }
        const hasChildren = child.children.length > 0;
        const detailGraphId = ctx.ids.graphId(coords(childPath));
        nodes.push({
          id: nodeId,
          kind: 'doc:section',
          label: child.title,
          ...(hasChildren ? { detail: { graph: detailGraphId } } : {}),
          attrs: { 'doc:index': index, 'doc:level': child.depth },
          provenance: provenance(child.span),
        });
        if (hasChildren) {
          const detailNodes = newGraph(detailGraphId, child.title, child.span);
          walk(child.children, detailGraphId, detailNodes, childPath, here.graphs, here.address);
        }
      } else {
        const ordinal = blockOrdinals.get(child.type) ?? 0;
        blockOrdinals.set(child.type, ordinal + 1);
        const childPath = [...path, `${child.type}-${ordinal}`];
        const nodeId = ctx.ids.nodeId(coords(childPath));
        nodes.push({
          id: nodeId,
          kind: KIND_BY_BLOCK[child.type],
          label: child.label,
          attrs: { 'doc:index': index, ...child.attrs },
          provenance: provenance(child.span),
        });
        for (const anchor of child.anchors) {
          links.push({
            from: { graphs: [...graphChain, graphId], address: [...nodeChain, nodeId] },
            anchor,
            provenance: provenance(child.span),
          });
        }
      }
      index += 1;
    }
  };

  walk(outline.children, rootGraphId, rootNodes, [], [], []);

  // Portal rule: rebase each resolved link at the lowest common graph and
  // aggregate multiplicity into edge weight.
  const aggregated = new Map<
    string,
    { graph: string; src: string; dst: string; weight: number; provenance: Provenance }
  >();
  for (const link of links) {
    const target = sectionByAnchor.get(link.anchor);
    if (target === undefined) continue; // unresolved anchors are not edges
    let common = 0;
    while (
      common < link.from.graphs.length - 1 &&
      common < target.graphs.length - 1 &&
      link.from.graphs[common + 1] === target.graphs[common + 1]
    ) {
      common += 1;
    }
    const graph = link.from.graphs[common]!;
    const srcNode = link.from.address[common]!;
    const dstNode = target.address[common]!;
    if (srcNode === dstNode) continue; // a link to its own ancestor induces nothing
    const key = `${graph}\n${srcNode}\n${dstNode}`;
    const prior = aggregated.get(key);
    if (prior !== undefined) prior.weight += 1;
    else aggregated.set(key, { graph, src: srcNode, dst: dstNode, weight: 1, provenance: link.provenance });
  }
  for (const edge of aggregated.values()) {
    edgesByGraph.get(edge.graph)!.push({
      id: ctx.ids.edgeId({
        graph: edge.graph,
        kind: 'doc:links-to',
        src: edge.src,
        dst: edge.dst,
      }),
      src: edge.src,
      dst: edge.dst,
      kind: 'doc:links-to',
      weight: edge.weight,
      provenance: edge.provenance,
    });
  }

  return {
    formatVersion: 1,
    producer: { name: '@meridian/adapter-markdown', version: producerVersion },
    roots: [rootGraphId],
    graphs,
  };
}
