import { describe, expect, it } from 'vitest';
import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  createGraphSpace,
  validate,
} from '../src/index.js';
import { demoSpace, SRC } from './helpers.js';

const gid = asGraphId;
const nid = asNodeId;
const eid = asEdgeId;

describe('constructors are pure with structural sharing (ADR-0001)', () => {
  it('never mutates the input space', () => {
    const s0 = createGraphSpace();
    const s1 = addGraph(s0, { id: gid('g1'), label: 'G', domain: 'demo', provenance: SRC });
    expect(s0.graphs.size).toBe(0);
    expect(s0.roots).toEqual([]);
    expect(s1.graphs.size).toBe(1);

    const s2 = addNode(s1, gid('g1'), {
      id: nid('n1'),
      kind: 'demo:step',
      label: 'x',
      provenance: SRC,
    });
    expect(s1.graphs.get(gid('g1'))!.nodes.size).toBe(0);
    expect(s2.graphs.get(gid('g1'))!.nodes.size).toBe(1);
  });

  it('shares untouched graphs by reference', () => {
    let s = createGraphSpace();
    s = addGraph(s, { id: gid('gA'), label: 'A', domain: 'demo', provenance: SRC });
    s = addGraph(s, { id: gid('gB'), label: 'B', domain: 'demo', provenance: SRC });
    const before = s.graphs.get(gid('gA'))!;
    const after = addNode(s, gid('gB'), {
      id: nid('n1'),
      kind: 'demo:step',
      label: 'x',
      provenance: SRC,
    });
    expect(after.graphs.get(gid('gA'))).toBe(before);
    expect(after.graphs.get(gid('gB'))).not.toBe(s.graphs.get(gid('gB')));
  });
});

describe('constructor guards', () => {
  const base = () =>
    addGraph(createGraphSpace(), { id: gid('g1'), label: 'G', domain: 'demo', provenance: SRC });

  it('rejects duplicate IDs in the local scope', () => {
    expect(() =>
      addGraph(base(), { id: gid('g1'), label: 'G2', domain: 'demo', provenance: SRC }),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-id' }));
    let s = addNode(base(), gid('g1'), {
      id: nid('n1'),
      kind: 'demo:step',
      label: '',
      provenance: SRC,
    });
    expect(() =>
      addNode(s, gid('g1'), { id: nid('n1'), kind: 'demo:step', label: '', provenance: SRC }),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-id' }));
    s = addNode(s, gid('g1'), { id: nid('n2'), kind: 'demo:step', label: '', provenance: SRC });
    s = addEdge(s, gid('g1'), {
      id: eid('e1'),
      src: nid('n1'),
      dst: nid('n2'),
      kind: 'core:references',
      provenance: SRC,
    });
    expect(() =>
      addEdge(s, gid('g1'), {
        id: eid('e1'),
        src: nid('n2'),
        dst: nid('n1'),
        kind: 'core:references',
        provenance: SRC,
      }),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-id' }));
  });

  it('rejects unknown graphs, nodes, kinds, weights, provenance', () => {
    const s = base();
    expect(() =>
      addNode(s, gid('nope'), { id: nid('n1'), kind: 'demo:step', label: '', provenance: SRC }),
    ).toThrowError(expect.objectContaining({ code: 'unknown-graph' }));
    expect(() =>
      addNode(s, gid('g1'), { id: nid('n1'), kind: 'NotAKind', label: '', provenance: SRC }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-kind' }));
    expect(() =>
      addNode(s, gid('g1'), {
        id: nid('n1'),
        kind: 'demo:step',
        label: '',
        provenance: { origin: 'unknown' as never },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-provenance' }));
    expect(() =>
      addNode(s, gid('g1'), {
        id: nid('n1'),
        kind: 'demo:step',
        label: '',
        attrs: { 'demo:bad': { nested: true } as never },
        provenance: SRC,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-attr-value' }));

    const withNodes = addNode(
      addNode(base(), gid('g1'), { id: nid('n1'), kind: 'demo:step', label: '', provenance: SRC }),
      gid('g1'),
      { id: nid('n2'), kind: 'demo:step', label: '', provenance: SRC },
    );
    expect(() =>
      addEdge(withNodes, gid('g1'), {
        id: eid('e1'),
        src: nid('n1'),
        dst: nid('ghost'),
        kind: 'core:references',
        provenance: SRC,
      }),
    ).toThrowError(expect.objectContaining({ code: 'unknown-node' }));
    expect(() =>
      addEdge(withNodes, gid('g1'), {
        id: eid('e1'),
        src: nid('n1'),
        dst: nid('n2'),
        kind: 'core:references',
        weight: Infinity,
        provenance: SRC,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-weight' }));
  });
});

describe('detail wiring (U2, U3 at the constructor)', () => {
  it('attaching a graph removes it from roots', () => {
    const s = demoSpace();
    expect(s.roots).toEqual([gid('g-root')]);
    expect(validate(s).ok).toBe(true);
  });

  it('rejects detailing a graph that is already contained (U3)', () => {
    const s = demoSpace();
    expect(() =>
      addNode(s, gid('g-root'), {
        id: nid('n-second-owner'),
        kind: 'demo:module',
        label: '',
        detail: { graph: gid('g-leaf') },
        provenance: SRC,
      }),
    ).toThrowError(expect.objectContaining({ code: 'detail-not-root' }));
  });

  it('rejects self-containment and ancestor cycles (U2)', () => {
    let s = createGraphSpace();
    s = addGraph(s, { id: gid('g1'), label: '', domain: 'demo', provenance: SRC });
    expect(() =>
      addNode(s, gid('g1'), {
        id: nid('n1'),
        kind: 'demo:step',
        label: '',
        detail: { graph: gid('g1') },
        provenance: SRC,
      }),
    ).toThrowError(expect.objectContaining({ code: 'containment-cycle' }));

    s = addGraph(s, { id: gid('g2'), label: '', domain: 'demo', provenance: SRC });
    s = addNode(s, gid('g1'), {
      id: nid('n-holds-g2'),
      kind: 'demo:module',
      label: '',
      detail: { graph: gid('g2') },
      provenance: SRC,
    });
    // g1 is still a root, but making it the detail of a node in g2 closes a loop.
    expect(() =>
      addNode(s, gid('g2'), {
        id: nid('n-holds-g1'),
        kind: 'demo:module',
        label: '',
        detail: { graph: gid('g1') },
        provenance: SRC,
      }),
    ).toThrowError(expect.objectContaining({ code: 'containment-cycle' }));
  });

  it('rejects a detail reference to a graph that does not exist', () => {
    const s = demoSpace();
    expect(() =>
      addNode(s, gid('g-root'), {
        id: nid('n-x'),
        kind: 'demo:module',
        label: '',
        detail: { graph: gid('g-ghost') },
        provenance: SRC,
      }),
    ).toThrowError(expect.objectContaining({ code: 'unknown-detail-graph' }));
  });
});

describe('canonicalization at the constructor (ADR-0004)', () => {
  it('NFC-normalizes labels', () => {
    let s = createGraphSpace();
    s = addGraph(s, { id: gid('g1'), label: '', domain: 'demo', provenance: SRC });
    s = addNode(s, gid('g1'), {
      id: nid('n1'),
      kind: 'demo:step',
      label: 'café',
      provenance: SRC,
    });
    expect(s.graphs.get(gid('g1'))!.nodes.get(nid('n1'))!.label).toBe('café');
  });

  it('collapses -0 weights to 0', () => {
    let s = createGraphSpace();
    s = addGraph(s, { id: gid('g1'), label: '', domain: 'demo', provenance: SRC });
    s = addNode(s, gid('g1'), { id: nid('n1'), kind: 'demo:step', label: '', provenance: SRC });
    s = addNode(s, gid('g1'), { id: nid('n2'), kind: 'demo:step', label: '', provenance: SRC });
    s = addEdge(s, gid('g1'), {
      id: eid('e1'),
      src: nid('n1'),
      dst: nid('n2'),
      kind: 'core:references',
      weight: -0,
      provenance: SRC,
    });
    expect(Object.is(s.graphs.get(gid('g1'))!.edges.get(eid('e1'))!.weight, 0)).toBe(true);
  });
});
