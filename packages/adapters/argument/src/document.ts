/**
 * IR → GraphDocument: the deterministic argument skeleton (§6, §7.3). The
 * containment is a three-level chain under one root graph:
 *
 *   root graph                          (the source; holds one essay node)
 *     └─ arg:essay    → detail graph    (holds the paragraphs)
 *          └─ arg:paragraph → detail    (holds its sentences)
 *               └─ arg:sentence         (a leaf; its text is the node label)
 *
 * matching the manifest's `[essay, paragraph, sentence]` level chain. Every
 * element carries **source-only** provenance with its character span into the
 * source text (P10); IDs derive purely through `ctx.ids` from stable
 * `(domain, source, path)` coordinates (ADR-0002) — never from AI or
 * wall-clock. Order survives as the declared `arg:index` attr.
 *
 * The skeleton emits **no edges**: prose order and containment are the only
 * relations character positions can prove. Claims, premises, objections and
 * the typed `arg:supports|rebuts|assumes|cites` relations are AI enrichment —
 * declared in the vocabulary, produced only by the composition-root pass
 * (ADR-0034), never here.
 */
import type { GraphDocument, PluginContext, SourceDescriptor } from '@meridian/plugin-api';
import type { ParsedEssay } from './parse.js';

export const DOMAIN = 'argument';

type WireGraph = GraphDocument['graphs'][number];
type WireNode = WireGraph['nodes'][number];
type Provenance = WireNode['provenance'];

interface MutableGraph {
  readonly id: string;
  readonly meta: WireGraph['meta'];
  readonly nodes: WireNode[];
  readonly edges: WireGraph['edges'][number][];
}

const PRODUCER = '@meridian/adapter-argument';

export function buildDocument(
  ctx: PluginContext,
  src: SourceDescriptor,
  essay: ParsedEssay,
  producerVersion: string,
): GraphDocument {
  const at = (span?: readonly [number, number]): Provenance => ({
    origin: 'source',
    uri: src.uri,
    ...(span !== undefined ? { span: [span[0], span[1]] } : {}),
  });
  const coords = (path: readonly string[]) => ({ domain: DOMAIN, source: src.uri, path: [...path] });

  const graphs: MutableGraph[] = [];
  const newGraph = (id: string, label: string, provenance: Provenance): MutableGraph => {
    const graph: MutableGraph = {
      id,
      meta: { label, domain: DOMAIN, provenance },
      nodes: [],
      edges: [],
    };
    graphs.push(graph);
    return graph;
  };

  const label = essay.title ?? src.uri;
  const rootGraphId = ctx.ids.graphId(coords([]));
  const root = newGraph(rootGraphId, label, at());

  const essayNodeId = ctx.ids.nodeId(coords(['essay']));
  const essayDetailId = ctx.ids.graphId(coords(['essay']));
  root.nodes.push({
    id: essayNodeId,
    kind: 'arg:essay',
    label,
    ...(essay.paragraphs.length > 0 ? { detail: { graph: essayDetailId } } : {}),
    attrs: { 'arg:index': 0 },
    provenance: at(),
  });
  if (essay.paragraphs.length === 0) return finish(); // an empty essay is essay-only

  const essayGraph = newGraph(essayDetailId, label, at());
  essay.paragraphs.forEach((paragraph, pi) => {
    const pSeg = `p-${pi}`;
    const pNodeId = ctx.ids.nodeId(coords(['essay', pSeg]));
    const pDetailId = ctx.ids.graphId(coords(['essay', pSeg]));
    essayGraph.nodes.push({
      id: pNodeId,
      kind: 'arg:paragraph',
      label: paragraph.text,
      detail: { graph: pDetailId }, // a paragraph always holds ≥ 1 sentence
      attrs: { 'arg:index': pi },
      provenance: at(paragraph.span),
    });
    const pGraph = newGraph(pDetailId, `Paragraph ${pi + 1}`, at(paragraph.span));
    paragraph.sentences.forEach((sentence, si) => {
      pGraph.nodes.push({
        id: ctx.ids.nodeId(coords(['essay', pSeg, `s-${si}`])),
        kind: 'arg:sentence',
        label: sentence.text,
        attrs: { 'arg:index': si },
        provenance: at(sentence.span),
      });
    });
  });
  return finish();

  function finish(): GraphDocument {
    return {
      formatVersion: 1,
      producer: { name: PRODUCER, version: producerVersion },
      roots: [rootGraphId],
      graphs,
    };
  }
}
