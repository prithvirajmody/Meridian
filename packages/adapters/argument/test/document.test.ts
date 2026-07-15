/**
 * IR builder (9D skeleton): essay → paragraph → sentence containment, stable
 * ids from (domain, source, path) coordinates, source provenance with spans,
 * arg:index ordering, no edges, and the gate accepts the output.
 */
import { idFacade, vocabularyOf } from '@meridian/conformance-kit';
import { decode } from '@meridian/graph-core';
import {
  PLUGIN_API_VERSION,
  type GraphDocument,
  type PluginContext,
  type SourceDescriptor,
} from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import { buildDocument, manifest, parseEssay } from '../src/index.js';

const ctx: PluginContext = {
  apiVersion: PLUGIN_API_VERSION,
  ids: idFacade(),
  log: { info: () => undefined, warn: () => undefined },
};

const SRC: SourceDescriptor = { uri: 'test://essay.md', text: '' };

function build(text: string): GraphDocument {
  return buildDocument(ctx, { ...SRC, text }, parseEssay(text, SRC.uri), '0.0.0');
}

const TWO_PARAS = '# Title\n\nOne two. Three four.\n\nFive six! Seven eight?';

describe('buildDocument — structure', () => {
  it('root graph holds one arg:essay node whose chain bottoms out in sentences', () => {
    const doc = build(TWO_PARAS);
    const root = doc.graphs.find((g) => g.id === doc.roots[0])!;
    expect(root.nodes).toHaveLength(1);
    const essay = root.nodes[0]!;
    expect(essay.kind).toBe('arg:essay');
    expect(essay.label).toBe('Title');
    const essayGraph = doc.graphs.find((g) => g.id === essay.detail?.graph)!;
    // The heading line is itself a paragraph (content, not structure) + two prose paragraphs.
    const paragraphs = essayGraph.nodes.filter((n) => n.kind === 'arg:paragraph');
    expect(paragraphs).toHaveLength(3);
    for (const [pi, p] of paragraphs.entries()) {
      expect(p.attrs?.['arg:index']).toBe(pi);
      const pg = doc.graphs.find((g) => g.id === p.detail?.graph)!;
      expect(pg.nodes.length).toBeGreaterThan(0);
      for (const s of pg.nodes) expect(s.kind).toBe('arg:sentence');
    }
  });

  it('emits no edges — the skeleton states only what character positions prove', () => {
    const doc = build(TWO_PARAS);
    for (const g of doc.graphs) expect(g.edges).toHaveLength(0);
  });

  it('an empty essay is essay-only (no detail graph)', () => {
    const doc = build('');
    const root = doc.graphs.find((g) => g.id === doc.roots[0])!;
    expect(root.nodes).toHaveLength(1);
    expect(root.nodes[0]!.detail).toBeUndefined();
    expect(doc.graphs).toHaveLength(1);
  });
});

describe('buildDocument — provenance & determinism', () => {
  it('every element is source-origin with the source uri; segments carry spans', () => {
    const doc = build(TWO_PARAS);
    for (const g of doc.graphs) {
      for (const n of g.nodes) {
        expect(n.provenance.origin).toBe('source');
        expect(n.provenance.uri).toBe(SRC.uri);
        if (n.kind !== 'arg:essay') expect(n.provenance.span).toBeDefined();
      }
    }
  });

  it('is byte-deterministic and passes the IR gate under the manifest vocabulary', () => {
    const a = JSON.stringify(build(TWO_PARAS));
    const b = JSON.stringify(build(TWO_PARAS));
    expect(a).toBe(b);
    const gated = decode(a, { vocabulary: vocabularyOf(manifest) });
    expect(gated.ok, JSON.stringify(!gated.ok ? gated.errors : [])).toBe(true);
  });

  it('ids are pure functions of coordinates: a re-parse keeps every id', () => {
    const first = build(TWO_PARAS);
    const again = build(TWO_PARAS);
    const idsOf = (d: GraphDocument) => d.graphs.flatMap((g) => [g.id, ...g.nodes.map((n) => n.id)]).sort();
    expect(idsOf(again)).toEqual(idsOf(first));
  });
});
