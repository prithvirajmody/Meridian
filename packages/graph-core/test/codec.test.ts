import { describe, expect, it } from 'vitest';
import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  createGraphSpace,
  CURRENT_FORMAT_VERSION,
  decode,
  encode,
  encodeCanonical,
  encodePretty,
} from '../src/index.js';
import { demoSpace, SRC } from './helpers.js';

const gid = asGraphId;
const nid = asNodeId;
const eid = asEdgeId;

const minimalDoc = () => ({
  formatVersion: 1,
  producer: { name: 'test', version: '1' },
  roots: ['g1'],
  graphs: [
    {
      id: 'g1',
      meta: { label: 'G', domain: 'demo', provenance: { origin: 'source' } },
      nodes: [
        { id: 'n1', kind: 'demo:step', label: 'one', provenance: { origin: 'source' } },
        { id: 'n2', kind: 'demo:step', label: 'two', provenance: { origin: 'source' } },
      ],
      edges: [
        {
          id: 'e1',
          src: 'n1',
          dst: 'n2',
          kind: 'core:precedes',
          provenance: { origin: 'derived' },
        },
      ],
    },
  ],
});

describe('decode (ADR-0004 gate)', () => {
  it('decodes a valid document object and its JSON text identically', () => {
    const fromObject = decode(minimalDoc());
    const fromText = decode(JSON.stringify(minimalDoc()));
    expect(fromObject.ok).toBe(true);
    expect(fromText.ok).toBe(true);
    if (fromObject.ok && fromText.ok) {
      expect(encodeCanonical(fromText.space)).toBe(encodeCanonical(fromObject.space));
    }
  });

  it('ignores and drops unknown keys at the supported version', () => {
    const doc = minimalDoc() as Record<string, unknown>;
    doc.futureField = { anything: true };
    (doc.graphs as Record<string, unknown>[])[0]!.futureGraphField = 1;
    const r = decode(doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(encodeCanonical(r.space)).not.toContain('futureField');
    }
  });

  it('NFC-normalizes all strings on the way in', () => {
    const doc = minimalDoc();
    doc.graphs[0]!.nodes[0]!.label = 'café';
    const r = decode(doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.space.graphs.get(gid('g1'))!.nodes.get(nid('n1'))!.label).toBe('café');
    }
  });

  it('collapses -0 weights so round-trips are exact', () => {
    const r = decode(JSON.stringify(minimalDoc()).replace('"provenance":{"origin":"derived"}', '"weight":-0,"provenance":{"origin":"derived"}'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.space.graphs.get(gid('g1'))!.edges.get(eid('e1'))!.weight;
      expect(Object.is(w, 0)).toBe(true);
    }
  });

  it('reports duplicate elements inside one document collection', () => {
    const doc = minimalDoc();
    doc.graphs[0]!.nodes.push({ ...doc.graphs[0]!.nodes[0]! });
    const r = decode(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('duplicate-id');
  });

  it('locates structural errors with a JSON path', () => {
    const doc = minimalDoc() as { graphs: { nodes: Record<string, unknown>[] }[] };
    delete doc.graphs[0]!.nodes[0]!.provenance;
    const r = decode(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.errors.find((e) => e.code === 'structural');
      expect(issue?.path).toBe('graphs.0.nodes.0.provenance');
    }
  });

  it('aggregates all errors rather than stopping at the first', () => {
    const doc = minimalDoc();
    doc.graphs[0]!.edges.push(
      {
        id: 'e-bad1',
        src: 'ghost-a',
        dst: 'n1',
        kind: 'core:references',
        provenance: { origin: 'source' },
      },
      {
        id: 'e-bad2',
        src: 'n1',
        dst: 'ghost-b',
        kind: 'core:references',
        provenance: { origin: 'source' },
      },
    );
    const r = decode(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.filter((e) => e.code === 'dangling-edge-endpoint')).toHaveLength(2);
    }
  });
});

describe('decode: version policy (ADR-0004)', () => {
  it('rejects a document without formatVersion', () => {
    const doc = minimalDoc() as Record<string, unknown>;
    delete doc.formatVersion;
    const r = decode(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe('missing-format-version');
  });

  it('refuses newer versions rather than guessing', () => {
    const doc = { ...minimalDoc(), formatVersion: CURRENT_FORMAT_VERSION + 1 };
    const r = decode(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.code).toBe('unsupported-version');
      expect(r.errors[0]!.message).toContain('newer than this build');
    }
  });

  it('rejects non-integer and sub-1 versions', () => {
    for (const fv of [0, 1.5, '1', null]) {
      const doc = { ...minimalDoc(), formatVersion: fv };
      const r = decode(doc);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]!.code).toBe('invalid-format-version');
    }
  });
});

describe('encode: deterministic canonical form (I6)', () => {
  it('is insensitive to construction order', () => {
    const build = (flip: boolean) => {
      let s = createGraphSpace();
      const ids = flip ? ['gB', 'gA'] : ['gA', 'gB'];
      for (const id of ids) {
        s = addGraph(s, { id: gid(id), label: id, domain: 'demo', provenance: SRC });
      }
      const nodeIds = flip ? ['n2', 'n1'] : ['n1', 'n2'];
      for (const id of nodeIds) {
        s = addNode(s, gid('gA'), {
          id: nid(id),
          kind: 'demo:step',
          label: id,
          attrs: flip ? { 'demo:b': 1, 'demo:a': 2 } : { 'demo:a': 2, 'demo:b': 1 },
          provenance: SRC,
        });
      }
      s = addEdge(s, gid('gA'), {
        id: eid('e1'),
        src: nid('n1'),
        dst: nid('n2'),
        kind: 'core:references',
        provenance: SRC,
      });
      return s;
    };
    expect(encodeCanonical(build(false))).toBe(encodeCanonical(build(true)));
  });

  it('sorts graphs, nodes, edges, roots, and attr keys', () => {
    const doc = encode(demoSpace());
    expect(doc.graphs.map((g) => g.id)).toEqual(['g-leaf', 'g-mid', 'g-root']);
    const root = doc.graphs.find((g) => g.id === 'g-root')!;
    expect(root.nodes.map((n) => n.id)).toEqual(['n-a', 'n-b']);
  });

  it('pretty and canonical renderings agree on content', () => {
    const s = demoSpace();
    expect(JSON.parse(encodePretty(s))).toEqual(JSON.parse(encodeCanonical(s)));
    expect(encodePretty(s).endsWith('\n')).toBe(true);
  });

  it('omits empty attr bags and stamps the current formatVersion', () => {
    const doc = encode(demoSpace());
    expect(doc.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    const anyNode = doc.graphs[0]!.nodes[0]!;
    expect('attrs' in anyNode).toBe(false);
  });
});

describe('round-trip (I3)', () => {
  it('decode(encode(space)) is the same space', () => {
    const s = demoSpace();
    const r = decode(encodeCanonical(s));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.space.graphs).toEqual(s.graphs);
      expect([...r.space.roots].sort()).toEqual([...s.roots].sort());
      expect(encodeCanonical(r.space)).toBe(encodeCanonical(s));
    }
  });
});
