/**
 * IR → GraphDocument: the deterministic organization skeleton (ADR-0047).
 * Pins the manifest vocabulary and five-level chain, the org → team → role →
 * assignment → artifact containment with uniform depth (implicit `_direct`
 * team and `_system` instance), valid detail refs and a single derived root,
 * byte-identical output (I6), the portal rule for cross-team relationships
 * (via-attrs, U1 intact), node-attr-only temporal facts, and structure-only
 * ingest of a bare definition. Everything is driven through the public
 * `buildDocument`, gated by the real graph-core `decode` under the manifest's
 * own vocabulary.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { idFacade, vocabularyOf } from '@meridian/conformance-kit';
import { decode, encodeCanonical } from '@meridian/graph-core';
import {
  PLUGIN_API_VERSION,
  type GraphDocument,
  type PluginContext,
} from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import { buildDocument, manifest, parseOrgSource, SYSTEM_INSTANCE } from '../src/index.js';

const ctx: PluginContext = {
  apiVersion: PLUGIN_API_VERSION,
  ids: idFacade(),
  log: { info: () => undefined, warn: () => undefined },
};
const VERSION = '0.1.0';
const vocabulary = vocabularyOf(manifest);

type WireGraph = GraphDocument['graphs'][number];
type WireNode = WireGraph['nodes'][number];

const corpusDir = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../fixtures/corpora/org',
);

function buildFromFixture(name: string): GraphDocument {
  const uri = `fixtures/corpora/org/${name}`;
  const ir = parseOrgSource(readFileSync(resolve(corpusDir, name), 'utf8'), uri);
  return buildDocument(ctx, { uri }, ir, VERSION);
}

const graphById = (doc: GraphDocument, id: string): WireGraph => {
  const g = doc.graphs.find((x) => x.id === id);
  expect(g, `graph ${id} must exist`).toBeDefined();
  return g!;
};

function gateOk(doc: GraphDocument): void {
  const res = decode(doc, { vocabulary });
  expect(res.ok ? [] : res.errors, 'document must pass the IR gate').toEqual([]);
}

/** Depth of the containment forest: longest node chain through detail refs. */
function maxNodeDepth(doc: GraphDocument): number {
  const byId = new Map(doc.graphs.map((g) => [g.id, g]));
  const depthOfGraph = (graphId: string, depth: number): number => {
    const graph = byId.get(graphId);
    if (graph === undefined || graph.nodes.length === 0) return depth;
    let max = depth;
    for (const node of graph.nodes) {
      max = Math.max(max, depth + 1);
      if (node.detail !== undefined) {
        max = Math.max(max, depthOfGraph(node.detail.graph, depth + 1));
      }
    }
    return max;
  };
  expect(doc.roots).toHaveLength(1);
  return depthOfGraph(doc.roots[0]!, 0);
}

describe('org document skeleton', () => {
  it('a teamed bundle with runs yields the full five-level ladder, gate-clean', () => {
    const doc = buildFromFixture('bundle-teamed.json');
    gateOk(doc);
    // org(1) → team(2) → role(3) → assignment(4) → event/artifact(5)
    expect(maxNodeDepth(doc)).toBe(5);
    const kindsPresent = new Set(doc.graphs.flatMap((g) => g.nodes.map((n) => n.kind)));
    for (const kind of [
      'org:organization',
      'org:team',
      'org:role-instance',
      'org:assignment',
      'org:event',
    ]) {
      expect(kindsPresent.has(kind), kind).toBe(true);
    }
  });

  const canonical = (doc: GraphDocument): string => {
    const res = decode(doc, { vocabulary });
    expect(res.ok ? [] : res.errors).toEqual([]);
    if (!res.ok) throw new Error('unreachable');
    return encodeCanonical(res.space);
  };

  it('is deterministic: two builds produce byte-identical canonical output (I6)', () => {
    const a = canonical(buildFromFixture('bundle-teamed.json'));
    const b = canonical(buildFromFixture('bundle-teamed.json'));
    expect(a).toBe(b);
  });

  it('a changed definition changes the canonical bytes', () => {
    const uri = 'fixtures/corpora/org/bundle-teamed.json';
    const text = readFileSync(resolve(corpusDir, 'bundle-teamed.json'), 'utf8');
    const ir = parseOrgSource(text, uri);
    const changed = {
      ...ir,
      definition: { ...ir.definition, orgVersion: '9.9.9' },
    };
    const a = canonical(buildDocument(ctx, { uri }, ir, VERSION));
    const b = canonical(buildDocument(ctx, { uri }, changed, VERSION));
    expect(a).not.toBe(b);
  });

  it('teamless instances dock under the implicit _direct team, marked implicit', () => {
    const doc = buildFromFixture('bundle-teamed.json');
    const orgGraphId = doc.graphs
      .flatMap((g) => g.nodes)
      .find((n) => n.kind === 'org:organization')!.detail!.graph;
    const orgGraph = graphById(doc, orgGraphId);
    const direct = orgGraph.nodes.find((n) => n.label === 'Direct');
    expect(direct).toBeDefined();
    expect(direct!.attrs!['org:implicit']).toBe(true);
    const directGraph = graphById(doc, direct!.detail!.graph);
    const members = directGraph.nodes.filter((n) => n.kind === 'org:role-instance');
    expect(members.map((n) => n.label)).toContain('pm');
    // events whose role names no instance route to the implicit _system instance
    expect(members.map((n) => n.label)).toContain(SYSTEM_INSTANCE);
    const teamed = orgGraph.nodes.find((n) => n.label === 'impl');
    expect(teamed).toBeDefined();
    expect(teamed!.attrs!['org:implicit']).toBeUndefined();
  });

  it('cross-team relationships rebase to the org graph with via-attrs (portal rule)', () => {
    const doc = buildFromFixture('bundle-teamed.json');
    const orgGraphId = doc.graphs
      .flatMap((g) => g.nodes)
      .find((n) => n.kind === 'org:organization')!.detail!.graph;
    const orgGraph = graphById(doc, orgGraphId);
    const portalEdges = orgGraph.edges.filter(
      (e) => e.attrs?.['org:via-src'] !== undefined || e.attrs?.['org:via-dst'] !== undefined,
    );
    expect(portalEdges.length).toBeGreaterThan(0);
    const nodeIds = new Set(orgGraph.nodes.map((n) => n.id));
    for (const edge of portalEdges) {
      expect(nodeIds.has(edge.src), 'portal src is a same-graph team node').toBe(true);
      expect(nodeIds.has(edge.dst), 'portal dst is a same-graph team node').toBe(true);
    }
  });

  it('temporal facts are node attrs matching the declared presentation hints', () => {
    const doc = buildFromFixture('bundle-teamed.json');
    const temporal = manifest.presentation?.temporal;
    expect(temporal).toBeDefined();
    const assignments = doc.graphs
      .flatMap((g) => g.nodes)
      .filter((n) => n.kind === 'org:assignment');
    expect(assignments.length).toBeGreaterThan(0);
    for (const node of assignments) {
      expect(node.attrs![temporal!.startAttribute]).toBeTypeOf('string');
      expect(node.attrs![temporal!.endAttribute!]).toBeTypeOf('string');
      expect(node.attrs![temporal!.laneAttribute!]).toBeTypeOf('string');
    }
    const events = doc.graphs.flatMap((g) => g.nodes).filter((n) => n.kind === 'org:event');
    for (const node of events) {
      expect(node.attrs![temporal!.startAttribute]).toBeTypeOf('string');
    }
  });

  it('a bare definition ingests structure-only: three levels, no assignments', () => {
    const doc = buildFromFixture('definition-minimal.json');
    gateOk(doc);
    expect(maxNodeDepth(doc)).toBe(3);
    const kinds = new Set(doc.graphs.flatMap((g) => g.nodes.map((n) => n.kind)));
    expect(kinds.has('org:assignment')).toBe(false);
    expect(kinds.has('org:event')).toBe(false);
  });

  it('a declared team in a bare definition is an opaque box with its template ref', () => {
    const doc = buildFromFixture('definition-nested-teams.json');
    gateOk(doc);
    const teams = doc.graphs
      .flatMap((g) => g.nodes)
      .filter((n) => n.kind === 'org:team' && n.attrs!['org:implicit'] === undefined);
    expect(teams.length).toBeGreaterThan(0);
    for (const team of teams) {
      expect(team.attrs!['org:template-ref']).toBeTypeOf('string');
    }
  });

  it('workflow handoff into a team boundary resolves to the team node', () => {
    const doc = buildFromFixture('bundle-teamed.json');
    const orgGraphId = doc.graphs
      .flatMap((g) => g.nodes)
      .find((n) => n.kind === 'org:organization')!.detail!.graph;
    const orgGraph = graphById(doc, orgGraphId);
    const impl = orgGraph.nodes.find((n) => n.label === 'impl');
    expect(impl).toBeDefined();
    const handoff = orgGraph.edges.filter((e) => e.kind === 'org:then' && e.dst === impl!.id);
    expect(handoff.length).toBeGreaterThan(0);
  });

  it('every element carries source-only provenance and no AI-origin structure', () => {
    const doc = buildFromFixture('bundle-teamed.json');
    const check = (p: WireNode['provenance']): void => {
      expect(p.origin).toBe('source');
    };
    for (const graph of doc.graphs) {
      check(graph.meta.provenance);
      for (const node of graph.nodes) check(node.provenance);
      for (const edge of graph.edges) check(edge.provenance);
    }
  });
});
