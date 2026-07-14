/**
 * IR → GraphDocument: the deterministic conversation skeleton (§6, §7.2).
 * Pins the manifest vocabulary and level chain, the session → exchange →
 * message containment, valid detail refs and a single derived root, stable
 * coordinate-derived IDs and byte-identical output, source-only provenance on
 * every element, `conv:replies-to` intra-exchange only (branched & missing
 * parent), the absence of any AI-origin structure, and one-message/empty
 * behavior. Everything is driven through the public `buildDocument`, gated by
 * the real graph-core `decode` under the manifest's own vocabulary.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { idFacade, vocabularyOf } from '@meridian/conformance-kit';
import { decode, deriveGraphId, deriveNodeId, encodeCanonical } from '@meridian/graph-core';
import {
  PLUGIN_API_VERSION,
  type GraphDocument,
  type PluginContext,
} from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import { buildDocument, DOMAIN, manifest, parseExport } from '../src/index.js';
import type { RawConversation } from '../src/format/types.js';

const ctx: PluginContext = {
  apiVersion: PLUGIN_API_VERSION,
  ids: idFacade(),
  log: { info: () => undefined, warn: () => undefined },
};
const VERSION = '0.1.0';
const vocabulary = vocabularyOf(manifest);

type WireGraph = GraphDocument['graphs'][number];
type WireNode = WireGraph['nodes'][number];
type WireEdge = WireGraph['edges'][number];

function build(conversations: readonly RawConversation[], uri = 'conv.json'): GraphDocument {
  return buildDocument(ctx, { uri }, conversations, VERSION);
}

const corpusDir = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../fixtures/corpora/conversation',
);

function buildFromFixture(name: string): { doc: GraphDocument; uri: string } {
  const uri = `fixtures/corpora/conversation/${name}`;
  const convs = parseExport(readFileSync(resolve(corpusDir, name), 'utf8'), uri);
  return { doc: build(convs, uri), uri };
}

const graphById = (doc: GraphDocument, id: string): WireGraph => {
  const g = doc.graphs.find((x) => x.id === id);
  expect(g, `graph ${id} must exist`).toBeDefined();
  return g!;
};
const rootGraph = (doc: GraphDocument): WireGraph => {
  expect(doc.roots).toHaveLength(1);
  return graphById(doc, doc.roots[0]!);
};
const allGraphs = (doc: GraphDocument): WireGraph[] => doc.graphs;
const allNodes = (doc: GraphDocument): WireNode[] => doc.graphs.flatMap((g) => g.nodes);
const allEdges = (doc: GraphDocument): WireEdge[] => doc.graphs.flatMap((g) => g.edges);

function gateOk(doc: GraphDocument): void {
  const res = decode(doc, { vocabulary });
  expect(res.ok ? [] : res.errors, 'document must pass the IR gate').toEqual([]);
}

const REALISTIC = [
  'claude-basic.json',
  'chatgpt-basic.json',
  'claude-one-message.json',
  'claude-unicode-code.json',
  'claude-hand-edited.json',
  'chatgpt-branched.json',
  'chatgpt-missing-parent.json',
  'empty-conversation.json',
];

// ------------------------------------------------------------- manifest

describe('manifest — the whole Phase 9 conversation vocabulary', () => {
  it('declares the one domain-parser capability and its level chain', () => {
    expect(manifest.capabilities).toEqual([{ kind: 'domain-parser', id: DOMAIN }]);
    expect(manifest.levelChain).toEqual({
      domain: DOMAIN,
      levels: [{ name: 'session' }, { name: 'exchange' }, { name: 'message' }],
    });
  });

  it('declares the skeleton kinds and the reserved AI-enrichment kinds', () => {
    expect(new Set(manifest.kinds)).toEqual(
      new Set([
        'conv:session',
        'conv:topic',
        'conv:exchange',
        'conv:message',
        'conv:claim',
        'conv:replies-to',
        'conv:refers-back',
        'conv:about',
      ]),
    );
  });

  it('declares every conv:* attr with its value type', () => {
    expect(manifest.attrSchemas?.['conv:index']?.type).toBe('number');
    expect(manifest.attrSchemas?.['conv:role']?.type).toBe('string');
    expect(manifest.attrSchemas?.['conv:source-id']?.type).toBe('string');
    expect(manifest.attrSchemas?.['conv:timestamp']?.type).toBe('string');
  });
});

// ----------------------------------------------- gate, roots, level chain

describe('IR gate & containment', () => {
  for (const name of REALISTIC) {
    it(`"${name}" passes the IR gate under the manifest vocabulary`, () => {
      gateOk(buildFromFixture(name).doc);
    });
  }

  it('emits exactly one derived root, contained by no node', () => {
    const { doc } = buildFromFixture('claude-basic.json');
    const root = rootGraph(doc);
    const contained = new Set(
      allNodes(doc)
        .map((n) => n.detail?.graph)
        .filter((g): g is string => g !== undefined),
    );
    expect(contained.has(root.id)).toBe(false);
  });

  it('every detail reference resolves to a graph in the document', () => {
    const { doc } = buildFromFixture('chatgpt-basic.json');
    const ids = new Set(doc.graphs.map((g) => g.id));
    for (const n of allNodes(doc)) {
      if (n.detail) expect(ids.has(n.detail.graph)).toBe(true);
    }
  });

  it('walks session → exchange → message, leaves carry no detail', () => {
    const { doc } = buildFromFixture('claude-basic.json');
    const root = rootGraph(doc);
    expect(root.nodes.map((n) => n.kind)).toEqual(['conv:session']);
    const session = root.nodes[0]!;
    const sessionGraph = graphById(doc, session.detail!.graph);
    expect(new Set(sessionGraph.nodes.map((n) => n.kind))).toEqual(new Set(['conv:exchange']));
    for (const ex of sessionGraph.nodes) {
      const exGraph = graphById(doc, ex.detail!.graph);
      expect(new Set(exGraph.nodes.map((n) => n.kind))).toEqual(new Set(['conv:message']));
      for (const m of exGraph.nodes) expect(m.detail).toBeUndefined();
    }
  });

  it('orders elements within each graph with a 0-based conv:index', () => {
    const { doc } = buildFromFixture('claude-basic.json');
    const root = rootGraph(doc);
    const session = root.nodes[0]!;
    const sessionGraph = graphById(doc, session.detail!.graph);
    expect(sessionGraph.nodes.map((n) => n.attrs?.['conv:index'])).toEqual([0, 1]);
    const firstEx = graphById(doc, sessionGraph.nodes[0]!.detail!.graph);
    expect(firstEx.nodes.map((n) => n.attrs?.['conv:index'])).toEqual([0, 1]);
  });
});

// ------------------------------------------------------- identity & bytes

describe('identity & determinism', () => {
  it('derives IDs purely from (domain, source, path) coordinates', () => {
    const uri = 'conv.json';
    const doc = build([{ sourceId: 's1', title: 'T', messages: [] }], uri);
    const root = rootGraph(doc);
    expect(root.id).toBe(deriveGraphId({ domain: DOMAIN, source: uri, path: [] }));
    expect(root.nodes[0]!.id).toBe(
      deriveNodeId({ domain: DOMAIN, source: uri, path: ['s1'] }),
    );
  });

  it('produces byte-identical documents for identical input', () => {
    const convs = parseExport(readFileSync(resolve(corpusDir, 'chatgpt-basic.json'), 'utf8'), 'u');
    const a = build(convs, 'u');
    const b = build(convs, 'u');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const da = decode(a);
    const db = decode(b);
    expect(da.ok && db.ok).toBe(true);
    if (da.ok && db.ok) expect(encodeCanonical(db.space)).toBe(encodeCanonical(da.space));
  });

  it('keeps a session identity stable when a re-export reorders conversations', () => {
    const a: RawConversation = { sourceId: 's-a', title: 'A', messages: [] };
    const b: RawConversation = { sourceId: 's-b', title: 'B', messages: [] };
    const forward = rootGraph(build([a, b], 'u'));
    const reversed = rootGraph(build([b, a], 'u'));
    const idFor = (g: WireGraph, sid: string) =>
      g.nodes.find((n) => n.attrs?.['conv:source-id'] === sid)!.id;
    expect(idFor(forward, 's-a')).toBe(idFor(reversed, 's-a'));
    expect(idFor(forward, 's-b')).toBe(idFor(reversed, 's-b'));
  });

  it('disambiguates a colliding source id deterministically, without duplicate ids', () => {
    const dup: RawConversation = { sourceId: 'dup', messages: [] };
    const doc = build([dup, dup], 'u');
    const sessions = rootGraph(doc).nodes;
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((n) => n.id)).size).toBe(2);
    gateOk(doc); // decode would flag any duplicate-id collision
  });
});

// ------------------------------------------------------------ provenance

describe('provenance — source-only, everywhere', () => {
  for (const name of REALISTIC) {
    it(`"${name}" tags every graph, node, and edge with origin:'source' and the uri`, () => {
      const { doc, uri } = buildFromFixture(name);
      const provs = [
        ...allGraphs(doc).map((g) => g.meta.provenance),
        ...allNodes(doc).map((n) => n.provenance),
        ...allEdges(doc).map((e) => e.provenance),
      ];
      expect(provs.length).toBeGreaterThan(0);
      for (const p of provs) {
        expect(p.origin).toBe('source');
        expect(p.uri).toBe(uri);
      }
    });
  }

  it('never emits a derived or ai origin', () => {
    for (const name of REALISTIC) {
      const { doc } = buildFromFixture(name);
      for (const g of allGraphs(doc)) expect(g.meta.provenance.origin).toBe('source');
      for (const n of allNodes(doc)) expect(n.provenance.origin).toBe('source');
      for (const e of allEdges(doc)) expect(e.provenance.origin).toBe('source');
    }
  });
});

// -------------------------------------------------------- reply edges

/** Every conv:replies-to edge across the document, with its owning graph. */
function replyEdges(doc: GraphDocument): { graph: WireGraph; edge: WireEdge }[] {
  return doc.graphs.flatMap((graph) =>
    graph.edges
      .filter((e) => e.kind === 'conv:replies-to')
      .map((edge) => ({ graph, edge })),
  );
}

describe('conv:replies-to — intra-exchange only, honestly omitted otherwise', () => {
  it('emits a reply edge only within one exchange graph (never across graphs)', () => {
    const { doc } = buildFromFixture('claude-basic.json');
    const replies = replyEdges(doc);
    expect(replies).toHaveLength(2); // one assistant→user per exchange
    for (const { graph, edge } of replies) {
      const ids = new Set(graph.nodes.map((n) => n.id));
      expect(ids.has(edge.src)).toBe(true);
      expect(ids.has(edge.dst)).toBe(true);
    }
  });

  it('a cross-exchange parent pointer induces no edge', () => {
    // claude-basic message m-3 (user) has parent m-2 in the previous exchange.
    const { doc } = buildFromFixture('claude-basic.json');
    // Only the two same-exchange assistant→user replies exist; the two
    // cross-exchange user→assistant pointers are omitted.
    expect(replyEdges(doc)).toHaveLength(2);
  });

  it('branched regenerations point both sibling replies at the one prompt', () => {
    const { doc } = buildFromFixture('chatgpt-branched.json');
    const replies = replyEdges(doc);
    expect(replies).toHaveLength(2);
    const dsts = new Set(replies.map((r) => r.edge.dst));
    expect(dsts.size).toBe(1); // both replies resolve to the same prompt node
    for (const { graph, edge } of replies) {
      const ids = new Set(graph.nodes.map((n) => n.id));
      expect(ids.has(edge.src) && ids.has(edge.dst)).toBe(true);
    }
  });

  it('a missing parent yields no edge, but a resolvable sibling still does', () => {
    const { doc } = buildFromFixture('chatgpt-missing-parent.json');
    // c1's parent (missing-ancestor) is absent → no edge; c2→c1 resolves → one.
    expect(replyEdges(doc)).toHaveLength(1);
  });

  it('no edge is ever a self-loop', () => {
    for (const name of REALISTIC) {
      for (const { edge } of replyEdges(buildFromFixture(name).doc)) {
        expect(edge.src).not.toBe(edge.dst);
      }
    }
  });
});

// ------------------------------------------------------- no AI structure

describe('AI-free skeleton', () => {
  const AI_KINDS = new Set(['conv:topic', 'conv:claim', 'conv:about', 'conv:refers-back']);
  it('produces none of the reserved AI-enrichment kinds', () => {
    for (const name of REALISTIC) {
      const { doc } = buildFromFixture(name);
      for (const n of allNodes(doc)) expect(AI_KINDS.has(n.kind)).toBe(false);
      for (const e of allEdges(doc)) expect(AI_KINDS.has(e.kind)).toBe(false);
    }
  });
});

// -------------------------------------------------- one-message & empty

describe('one-message & empty behavior', () => {
  it('one message → one session, one exchange, one leaf message (verbatim label)', () => {
    const { doc } = buildFromFixture('claude-one-message.json');
    const root = rootGraph(doc);
    expect(root.nodes).toHaveLength(1);
    const session = root.nodes[0]!;
    expect(session.label).toBe('Quick question');
    const sessionGraph = graphById(doc, session.detail!.graph);
    expect(sessionGraph.nodes).toHaveLength(1);
    const exGraph = graphById(doc, sessionGraph.nodes[0]!.detail!.graph);
    expect(exGraph.nodes).toHaveLength(1);
    expect(exGraph.nodes[0]!.label).toBe('Hello there — is anyone home?');
    expect(exGraph.edges).toEqual([]);
  });

  it('an empty conversation is session-only: a node with no detail graph', () => {
    const { doc } = buildFromFixture('empty-conversation.json');
    expect(doc.graphs).toHaveLength(1);
    const session = rootGraph(doc).nodes[0]!;
    expect(session.kind).toBe('conv:session');
    expect(session.detail).toBeUndefined();
    expect(session.attrs?.['conv:source-id']).toBe('empty-conv');
    gateOk(doc);
  });

  it('an empty export is one empty root graph that still gates clean', () => {
    const doc = build(parseExport('[]', 'empty.json'), 'empty.json');
    expect(doc.graphs).toHaveLength(1);
    expect(rootGraph(doc).nodes).toEqual([]);
    gateOk(doc);
  });

  it('labels the root by the sole conversation title, else by the source uri', () => {
    const single = build([{ title: 'Only One', messages: [] }], 'u');
    expect(rootGraph(single).meta.label).toBe('Only One');
    const many = build([{ title: 'A', messages: [] }, { title: 'B', messages: [] }], 'src.json');
    expect(rootGraph(many).meta.label).toBe('src.json');
  });
});

// ------------------------------------------------------------- verbatim

describe('verbatim message text as node label', () => {
  it('carries unicode, emoji, and fenced code through unchanged', () => {
    const { doc } = buildFromFixture('claude-unicode-code.json');
    const labels = allNodes(doc)
      .filter((n) => n.kind === 'conv:message')
      .map((n) => n.label);
    expect(labels).toContain("```python\nprint('Héllo, 世界! 🌍')\n```");
  });

  it('records role, source id, and timestamp as declared attrs', () => {
    const { doc } = buildFromFixture('claude-basic.json');
    const messages = allNodes(doc).filter((n) => n.kind === 'conv:message');
    const first = messages[0]!;
    expect(first.attrs?.['conv:role']).toBe('user');
    expect(first.attrs?.['conv:source-id']).toBe('m-1');
    expect(first.attrs?.['conv:timestamp']).toBe('2026-05-01T10:00:01Z');
  });
});
