import { describe, expect, it } from 'vitest';
import {
  asEdgeId,
  asGraphId,
  asNodeId,
  validate,
  type GraphSpace,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
  type SourceRef,
} from '../src/index.js';
import { demoSpace, SRC } from './helpers.js';

// Raw-object construction on purpose: the validator must catch what the
// constructors make impossible (decoded documents, hand-built spaces).
const gid = asGraphId;
const nid = asNodeId;
const eid = asEdgeId;

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { id: nid(id), kind: 'demo:step', label: id, attrs: {}, provenance: SRC, ...extra };
}

function edge(id: string, src: string, dst: string, extra: Partial<SemanticEdge> = {}): SemanticEdge {
  return {
    id: eid(id),
    src: nid(src),
    dst: nid(dst),
    kind: 'core:references',
    attrs: {},
    provenance: SRC,
    ...extra,
  };
}

function graph(
  id: string,
  nodes: SemanticNode[],
  edges: SemanticEdge[] = [],
): SemanticGraph {
  return {
    id: gid(id),
    meta: { label: id, domain: 'demo', provenance: SRC },
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: new Map(edges.map((e) => [e.id, e])),
  };
}

function space(graphs: SemanticGraph[], roots: string[]): GraphSpace {
  return { graphs: new Map(graphs.map((g) => [g.id, g])), roots: roots.map(gid) };
}

function codes(result: ReturnType<typeof validate>): string[] {
  return result.errors.map((e) => e.code);
}

describe('validate: U1 referential integrity', () => {
  it('accepts a valid space with no errors', () => {
    const r = validate(demoSpace());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reports dangling edge endpoints', () => {
    const r = validate(space([graph('g1', [node('n1')], [edge('e1', 'n1', 'n-ghost')])], ['g1']));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('dangling-edge-endpoint');
  });

  it('names the other graph when an edge tries to cross graphs', () => {
    const r = validate(
      space(
        [graph('g1', [node('n1')], [edge('e1', 'n1', 'n2')]), graph('g2', [node('n2')])],
        ['g1', 'g2'],
      ),
    );
    expect(r.ok).toBe(false);
    const issue = r.errors.find((e) => e.code === 'dangling-edge-endpoint');
    expect(issue?.message).toContain('cross-graph edges are forbidden');
    expect(issue?.message).toContain('"g2"');
  });

  it('reports dangling detail references', () => {
    const r = validate(space([graph('g1', [node('n1', { detail: { graph: gid('g-ghost') } })])], ['g1']));
    expect(codes(r)).toContain('dangling-detail-ref');
  });
});

describe('validate: U2/U3 containment', () => {
  it('reports containment cycles', () => {
    const r = validate(
      space(
        [
          graph('g1', [node('n1', { detail: { graph: gid('g2') } })]),
          graph('g2', [node('n2', { detail: { graph: gid('g1') } })]),
        ],
        [],
      ),
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('containment-cycle');
  });

  it('reports self-containment', () => {
    const r = validate(space([graph('g1', [node('n1', { detail: { graph: gid('g1') } })])], []));
    expect(codes(r)).toContain('containment-cycle');
  });

  it('reports a graph detailed by two nodes (U3)', () => {
    const r = validate(
      space(
        [
          graph('g1', [
            node('n1', { detail: { graph: gid('g-shared') } }),
            node('n2', { detail: { graph: gid('g-shared') } }),
          ]),
          graph('g-shared', [node('n3')]),
        ],
        ['g1'],
      ),
    );
    expect(codes(r)).toContain('multiple-containment');
  });
});

describe('validate: roots are derived, never trusted', () => {
  it('rejects a contained graph listed as root', () => {
    const s = demoSpace();
    const r = validate({ ...s, roots: [...s.roots, gid('g-mid')] });
    expect(codes(r)).toContain('root-mismatch');
  });

  it('rejects a missing root', () => {
    const s = demoSpace();
    const r = validate({ ...s, roots: [] });
    expect(codes(r)).toContain('root-mismatch');
  });

  it('rejects nonexistent and duplicated root entries', () => {
    const s = demoSpace();
    expect(codes(validate({ ...s, roots: [...s.roots, gid('g-ghost')] }))).toContain(
      'root-mismatch',
    );
    expect(codes(validate({ ...s, roots: [gid('g-root'), gid('g-root')] }))).toContain(
      'root-mismatch',
    );
  });
});

describe('validate: identity discipline (ADR-0002)', () => {
  it('rejects duplicate IDs across graphs and across element kinds', () => {
    const r = validate(space([graph('g1', [node('dup')]), graph('g2', [node('dup')])], ['g1', 'g2']));
    expect(codes(r)).toContain('duplicate-id');
    const r2 = validate(space([graph('same', [node('same')])], ['same']));
    expect(codes(r2)).toContain('duplicate-id');
  });

  it('rejects a map key that disagrees with the element id', () => {
    const g = graph('g1', []);
    const mismatched: SemanticGraph = {
      ...g,
      nodes: new Map([[nid('n-key'), node('n-actual')]]),
    };
    const r = validate(space([mismatched], ['g1']));
    expect(codes(r)).toContain('invalid-id');
  });
});

describe('validate: provenance (U7) and attributes (ADR-0003)', () => {
  it('rejects unknown origins', () => {
    const bad = { origin: 'unknown' } as unknown as SourceRef;
    const r = validate(space([graph('g1', [node('n1', { provenance: bad })])], ['g1']));
    expect(codes(r)).toContain('invalid-provenance');
  });

  it('rejects out-of-range confidence and malformed spans', () => {
    const r = validate(
      space(
        [
          graph('g1', [
            node('n1', { provenance: { origin: 'ai', confidence: 1.5 } }),
            node('n2', { provenance: { origin: 'source', span: [5, 2] } }),
          ]),
        ],
        ['g1'],
      ),
    );
    expect(r.errors.filter((e) => e.code === 'invalid-provenance')).toHaveLength(2);
  });

  it('rejects core attr keys; warns on unregistered namespaces', () => {
    const r = validate(
      space(
        [
          graph('g1', [
            node('n1', { attrs: { 'core:salience': 0.5 } }),
            node('n2', { attrs: { 'core:zap': 1 } }),
            node('n3', { attrs: { 'demo:count': 3 } }),
          ]),
        ],
        ['g1'],
      ),
    );
    expect(r.errors.filter((e) => e.code === 'reserved-core-key')).toHaveLength(2);
    expect(r.warnings.map((w) => w.code)).toContain('unregistered-namespace');
    // The warning alone must not fail validation.
    const okr = validate(space([graph('g1', [node('n1', { attrs: { 'demo:count': 3 } })])], ['g1']));
    expect(okr.ok).toBe(true);
    expect(okr.warnings).toHaveLength(1);
  });

  it('rejects malformed attr keys and heterogeneous or non-finite values', () => {
    const r = validate(
      space(
        [
          graph('g1', [
            node('n1', { attrs: { BadKey: 1 } as never }),
            node('n2', { attrs: { 'demo:mixed': ['a', 1] } as never }),
            node('n3', { attrs: { 'demo:nan': NaN } as never }),
            node('n4', { attrs: { 'demo:nested': { a: 1 } } as never }),
          ]),
        ],
        ['g1'],
      ),
    );
    expect(codes(r)).toContain('invalid-attr-key');
    expect(r.errors.filter((e) => e.code === 'invalid-attr-value')).toHaveLength(3);
  });

  it('rejects malformed kinds and non-finite weights', () => {
    const r = validate(
      space(
        [
          graph(
            'g1',
            [node('n1', { kind: 'nocolon' }), node('n2')],
            [edge('e1', 'n1', 'n2', { weight: Infinity })],
          ),
        ],
        ['g1'],
      ),
    );
    expect(codes(r)).toContain('invalid-kind');
    expect(codes(r)).toContain('invalid-weight');
  });

  it('rejects non-NFC strings in hand-built spaces', () => {
    const r = validate(space([graph('g1', [node('n1', { label: 'café' })])], ['g1']));
    expect(codes(r)).toContain('string-not-nfc');
  });
});

describe('validate: issues are located and aggregated', () => {
  it('reports every error, each carrying its graph and element', () => {
    const r = validate(
      space(
        [
          graph(
            'g1',
            [node('n1', { kind: 'bad' })],
            [edge('e1', 'n1', 'n-ghost'), edge('e2', 'n-ghost', 'n1')],
          ),
        ],
        ['g1'],
      ),
    );
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
    for (const issue of r.errors) {
      expect(issue.graphId).toBe('g1');
      expect(issue.elementId).toBeDefined();
    }
  });
});
