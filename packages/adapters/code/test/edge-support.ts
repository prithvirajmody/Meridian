/**
 * Shared scaffolding for the 7E import/call-edge tests: ingest an inline
 * multi-file bundle through the real plugin (as a host does), gate it, and
 * expose small query helpers so each test reads as hand-drawn truth
 * (which edge between which labels; a function's counters).
 */
import {
  decode,
  type GraphDocument,
  type GraphSpace,
  type SemanticEdge,
  type SemanticNode,
} from '@meridian/graph-core';
import {
  CODE_PROJECT_MEDIA_TYPE,
  codeManifest,
  createCodePlugin,
  encodeProjectBundle,
  type CodeMapper,
} from '../src/index.js';
import { testContext } from './support.js';

const vocabulary = {
  attrs: new Map(Object.entries(codeManifest.attrSchemas ?? {}).map(([k, s]) => [k, s.type])),
  kinds: new Set(codeManifest.kinds ?? []),
};

export interface Counters {
  readonly resolved: number;
  readonly unresolved: number;
  readonly external: number;
}

export interface Ingested {
  readonly space: GraphSpace;
  readonly edges: readonly SemanticEdge[];
  readonly nodes: ReadonlyMap<string, SemanticNode>;
  label(id: string): string;
  /** All edges of `kind` whose endpoints' labels match (src, dst). */
  edgesBetween(kind: string, srcLabel: string, dstLabel: string): SemanticEdge[];
  /** Counters of every function/method with the given label. */
  countersOf(label: string): Counters[];
  /** The one node with this label (throws if not exactly one). */
  nodeByLabel(label: string): SemanticNode;
}

export async function ingestBundle(
  mapper: CodeMapper,
  files: readonly { path: string; text: string }[],
  root = 'proj',
): Promise<Ingested> {
  const plugin = createCodePlugin({ mapper });
  const parser = plugin.activate(testContext()).parsers![0]!;
  const docs: GraphDocument[] = [];
  await parser.ingest(
    { uri: root, mediaType: CODE_PROJECT_MEDIA_TYPE, text: encodeProjectBundle({ root, files: [...files] }) },
    { emitDocument: (d) => docs.push(d), emitDelta: () => undefined, progress: () => undefined },
  );
  const gate = decode(docs[0]!, { vocabulary });
  if (!gate.ok) {
    throw new Error(`gate rejected: ${gate.errors.map((e) => e.message).join('; ')}`);
  }
  const space = gate.space;
  const nodes = new Map<string, SemanticNode>();
  const edges: SemanticEdge[] = [];
  for (const g of space.graphs.values()) {
    for (const n of g.nodes.values()) nodes.set(n.id, n);
    for (const e of g.edges.values()) edges.push(e);
  }
  const label = (id: string): string => nodes.get(id)?.label ?? '(?)';
  return {
    space,
    edges,
    nodes,
    label,
    edgesBetween: (kind, srcLabel, dstLabel) =>
      edges.filter((e) => e.kind === kind && label(e.src) === srcLabel && label(e.dst) === dstLabel),
    countersOf: (l) =>
      [...nodes.values()]
        .filter((n) => (n.kind === 'code:function' || n.kind === 'code:method') && n.label === l)
        .map((n) => ({
          resolved: n.attrs['code:calls-resolved'] as number,
          unresolved: n.attrs['code:calls-unresolved'] as number,
          external: n.attrs['code:calls-external'] as number,
        })),
    nodeByLabel: (l) => {
      const hits = [...nodes.values()].filter((n) => n.label === l);
      if (hits.length !== 1) throw new Error(`expected exactly one node labelled "${l}", got ${hits.length}`);
      return hits[0]!;
    },
  };
}
