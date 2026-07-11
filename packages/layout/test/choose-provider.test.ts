/**
 * The default-provider heuristic (ADR-0018; subphase 4E). Each rule is pinned
 * against a hand-built `(cut, edges)` whose shape triggers exactly that rule,
 * plus determinism (same input → same choice) and the `V_MAX` cost guard
 * (above the bound, the clustering coefficient is skipped and the decision uses
 * `backRatio` + `avgDeg` only). The classifier is a pure function of its two
 * inputs — no store, no I/O.
 */
import { describe, expect, it } from 'vitest';
import { BETA, chooseProvider, DELTA, GAMMA, V_MAX } from '../src/index.js';
import { cutOf, edge } from './helpers.js';

describe('chooseProvider — ADR-0018 rules, first match wins', () => {
  it('rule 1 — V ≤ 1 → grid (empty, single node)', () => {
    expect(chooseProvider(cutOf(), [])).toBe('grid');
    expect(chooseProvider(cutOf('a'), [])).toBe('grid');
    // a self-loop on the single member does not create a relation
    expect(chooseProvider(cutOf('a'), [edge('a', 'a')])).toBe('grid');
  });

  it('rule 2 — E == 0 → grid (node-soup / fully disconnected)', () => {
    expect(chooseProvider(cutOf('a', 'b', 'c', 'd'), [])).toBe('grid');
    // self-loops only ⇒ still no member-pair ⇒ E == 0
    expect(chooseProvider(cutOf('a', 'b'), [edge('a', 'a'), edge('b', 'b')])).toBe('grid');
  });

  it('rule 3 — a forest (E == V − comp) → tree', () => {
    // one tree: root → c1, c2; c1 → g1, g2  (5 nodes, 4 edges, 1 comp) forest
    const forest = chooseProvider(cutOf('root', 'c1', 'c2', 'g1', 'g2'), [
      edge('root', 'c1'),
      edge('root', 'c2'),
      edge('c1', 'g1'),
      edge('c1', 'g2'),
    ]);
    expect(forest).toBe('tree');
    // two disjoint trees (a forest with comp = 2): still tree
    const twoTrees = chooseProvider(cutOf('a', 'b', 'c', 'x', 'y', 'z'), [
      edge('a', 'b'),
      edge('a', 'c'),
      edge('x', 'y'),
      edge('x', 'z'),
    ]);
    expect(twoTrees).toBe('tree');
  });

  it('rule 4 — DAG-ish (acyclic, sparse) → elk-layered', () => {
    // a small DAG with a cross edge (so E ≠ V − comp, not a forest), acyclic,
    // avgDeg ≤ δ: backRatio == 0 ≤ β and avgDeg ≤ 6 → layered.
    const dag = chooseProvider(cutOf('a', 'b', 'c', 'd'), [
      edge('a', 'b'),
      edge('a', 'c'),
      edge('b', 'd'),
      edge('c', 'd'), // the extra cross edge → not a forest (E=4, V−comp=3)
    ]);
    expect(dag).toBe('elk-layered');
  });

  it('rule 5 — cluster-ish via high clustering coefficient (C ≥ γ) → d3-force', () => {
    // K4's undirected graph (C = 1 ≥ γ, avgDeg = 3 ≤ δ) but directed as a cycle
    // with diagonals so it is *cyclic* (backRatio > β) — rule 4 fails, and the
    // clustering disjunct of rule 5 catches it. (A transitively-oriented K4 is
    // acyclic and would fall to rule 4 → elk; the cycle is what isolates C.)
    const k4cyclic = chooseProvider(cutOf('a', 'b', 'c', 'd'), [
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'd'),
      edge('d', 'a'), // the back edge → cyclic
      edge('a', 'c'),
      edge('b', 'd'),
    ]);
    expect(k4cyclic).toBe('d3-force');
  });

  it('rule 5 — cluster-ish via high density (avgDeg > δ) → d3-force', () => {
    // 8 nodes, dense (avgDeg > 6): a near-complete graph.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const edges = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) edges.push(edge(ids[i]!, ids[j]!));
    }
    expect(chooseProvider(cutOf(...ids), edges)).toBe('d3-force');
  });

  it('rule 6 — sparse-but-cyclic messy middle (low C) → d3-force', () => {
    // a long directed cycle: sparse (avgDeg = 2), cyclic (backRatio > β), and
    // triangle-free (C = 0 < γ) → neither layerable nor clustered → force.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const ring = ids.map((id, i) => edge(id, ids[(i + 1) % ids.length]!));
    expect(chooseProvider(cutOf(...ids), ring)).toBe('d3-force');
  });

  it('is deterministic — identical input yields an identical choice', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
    const first = chooseProvider(cutOf(...ids), edges);
    for (let i = 0; i < 20; i++) expect(chooseProvider(cutOf(...ids), edges)).toBe(first);
  });

  it('the thresholds are the ADR-0018 constants', () => {
    expect(BETA).toBe(0.05);
    expect(DELTA).toBe(6);
    expect(GAMMA).toBe(0.35);
    expect(V_MAX).toBe(5000);
  });

  it('cost guard — above V_MAX the classifier stays fast and correct (C skipped)', () => {
    // Above V_MAX the O(Σdeg²) clustering coefficient is skipped. This is *safe*
    // by construction: rules 5 and 6 both return d3-force, so the `C ≥ γ`
    // disjunct never changes the return value — it only saves work. We assert
    // the large-graph choices are still driven by backRatio + avgDeg, and fast.
    const N = V_MAX + 300;
    const ids = Array.from({ length: N }, (_, i) => `n${String(i).padStart(5, '0')}`);

    // Sparse, acyclic, non-forest (triangles i→i+1, i→i+2, i+1→i+2 per triple,
    // all forward ⇒ acyclic; the third edge breaks the forest) → rule 4 → elk.
    const acyclic = [];
    for (let i = 0; i + 2 < N; i += 3) {
      acyclic.push(edge(ids[i]!, ids[i + 1]!), edge(ids[i]!, ids[i + 2]!), edge(ids[i + 1]!, ids[i + 2]!));
    }
    const t0 = Date.now();
    expect(chooseProvider(cutOf(...ids), acyclic)).toBe('elk-layered');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // O(V+E) at V_MAX scale, ample headroom

    // A large clustered *cyclic* sparse graph: with C it is rule 5 (C ≥ γ),
    // without C it is rule 6 — both d3-force, so the skip cannot change it.
    const rings = [];
    for (let i = 0; i + 2 < N; i += 3) {
      // a directed triangle a→b→c→a: cyclic (backRatio > β), clustered (C = 1)
      rings.push(edge(ids[i]!, ids[i + 1]!), edge(ids[i + 1]!, ids[i + 2]!), edge(ids[i + 2]!, ids[i]!));
    }
    expect(chooseProvider(cutOf(...ids), rings)).toBe('d3-force');

    // Dense wiring (avgDeg > δ) → rule 5's avgDeg disjunct → d3-force.
    const dense = [];
    for (let i = 0; i < N; i++) {
      for (let k = 1; k <= 4; k++) dense.push(edge(ids[i]!, ids[(i + k) % N]!));
    }
    expect(chooseProvider(cutOf(...ids), dense)).toBe('d3-force');
  });
});
