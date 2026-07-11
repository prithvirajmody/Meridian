/**
 * The default-provider heuristic (ADR-0018; subphase 4E). A **pure,
 * deterministic** classifier over `(cut, inducedEdges)` that picks a layout
 * provider by view shape — "layered for DAG-ish cuts, force for cluster-ish"
 * (ROADMAP §8) — when the caller does not name one. An explicit provider
 * selection bypasses it entirely.
 *
 * The function is a pure map from its two inputs to a provider id (I6): every
 * traversal (component union-find, DFS start order, clustering iteration) and
 * every tie-break resolves by **ascending `NodeId`**, so identical input yields
 * an identical choice — a **test** (`test/choose-provider.test.ts`). It runs on
 * the main thread before dispatch (ADR-0017), so it is O(V + E) with one guarded
 * exception: the clustering coefficient `C` (O(Σdeg²)) is **skipped** above
 * {@link V_MAX} to stay inside the 4ms budget.
 *
 * Signals and thresholds are ADR-0018's, frozen as *mechanism* (re-tuned in 4E
 * against real corpus SVGs). No DOM, no domain, no AI — core-law.
 */
import type { Cut, InducedEdge } from '@meridian/abstraction';
import type { NodeId } from '@meridian/graph-core';
import { connectedComponents } from './components.js';

/** The four provider ids the heuristic chooses among (ADR-0018). */
export type ProviderChoice = 'grid' | 'tree' | 'elk-layered' | 'd3-force';

/** Max `backRatio` (directed DFS back-edge fraction) to count as "acyclic
 * enough" for layering (ADR-0018 `β`). */
export const BETA = 0.05;
/** `avgDeg` boundary between "sparse/layerable" and "dense/tangled"
 * (ADR-0018 `δ`). */
export const DELTA = 6;
/** Average clustering-coefficient boundary above which a graph is
 * "cluster-ish" (ADR-0018 `γ`). */
export const GAMMA = 0.35;
/** Above this member count the O(Σdeg²) clustering coefficient `C` is skipped
 * (ADR-0018 cost guard, tied to ADR-0014's node budget). */
export const V_MAX = 5000;

/**
 * The undirected simple graph over members: an induced edge and its reverse,
 * and parallel kinds, collapse to one member-pair; self-loops are dropped.
 * Returns per-member neighbour sets keyed by member index, and the distinct
 * undirected pair count `E`.
 */
function undirectedGraph(index: ReadonlyMap<NodeId, number>, edges: readonly InducedEdge[]): {
  adj: Set<number>[];
  E: number;
} {
  const V = index.size;
  const adj: Set<number>[] = Array.from({ length: V }, () => new Set<number>());
  let E = 0;
  for (const e of edges) {
    const a = index.get(e.src);
    const b = index.get(e.dst);
    if (a === undefined || b === undefined || a === b) continue;
    if (!adj[a]!.has(b)) {
      adj[a]!.add(b);
      adj[b]!.add(a);
      E++;
    }
  }
  return { adj, E };
}

/**
 * Directed DFS back-edge fraction (ADR-0018 `backRatio`). DFS from members in
 * ascending `NodeId` (= ascending index) order over the directed induced
 * multigraph; a back edge is one whose target is on the active recursion stack.
 * `backRatio = 0 ⟺ acyclic`. Self-loops are excluded from both count and
 * numerator. Iterative to stay total on deep/large cuts.
 */
function backRatio(index: ReadonlyMap<NodeId, number>, edges: readonly InducedEdge[]): number {
  const V = index.size;
  const out: number[][] = Array.from({ length: V }, () => []);
  let directed = 0;
  for (const e of edges) {
    const a = index.get(e.src);
    const b = index.get(e.dst);
    if (a === undefined || b === undefined || a === b) continue;
    out[a]!.push(b);
    directed++;
  }
  if (directed === 0) return 0;

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Uint8Array(V);
  let back = 0;

  // Iterative DFS with an explicit stack; `cursor` tracks the next out-edge to
  // examine for each frame, so each directed edge is inspected exactly once.
  for (let s = 0; s < V; s++) {
    if (color[s] !== WHITE) continue;
    const stack: number[] = [s];
    const cursor: number[] = [0];
    color[s] = GRAY;
    while (stack.length > 0) {
      const u = stack[stack.length - 1]!;
      const c = cursor[cursor.length - 1]!;
      const neighbours = out[u]!;
      if (c < neighbours.length) {
        cursor[cursor.length - 1] = c + 1;
        const v = neighbours[c]!;
        if (color[v] === GRAY) {
          back++; // target on the active stack → back edge
        } else if (color[v] === WHITE) {
          color[v] = GRAY;
          stack.push(v);
          cursor.push(0);
        }
        // color[v] === BLACK → forward/cross edge, ignored
      } else {
        color[u] = BLACK;
        stack.pop();
        cursor.pop();
      }
    }
  }
  return back / directed;
}

/**
 * Average local clustering coefficient (ADR-0018 `C`): the fraction of a node's
 * neighbour-pairs that are themselves adjacent, averaged over nodes with degree
 * ≥ 2. In `[0, 1]`; `0` when no node has degree ≥ 2.
 */
function clusteringCoefficient(adj: readonly Set<number>[]): number {
  let sum = 0;
  let counted = 0;
  for (let u = 0; u < adj.length; u++) {
    const nbrs = [...adj[u]!];
    const deg = nbrs.length;
    if (deg < 2) continue;
    let linked = 0;
    for (let i = 0; i < deg; i++) {
      for (let j = i + 1; j < deg; j++) {
        if (adj[nbrs[i]!]!.has(nbrs[j]!)) linked++;
      }
    }
    sum += linked / ((deg * (deg - 1)) / 2);
    counted++;
  }
  return counted === 0 ? 0 : sum / counted;
}

/**
 * Choose the default layout provider for a cut by view shape (ADR-0018). Pure
 * and deterministic. First matching rule wins:
 *
 * 1. `V ≤ 1` → `grid` (nothing to relate).
 * 2. `E == 0` → `grid` (node-soup / fully disconnected).
 * 3. induced graph is a forest (`E == V − comp`) → `tree` (containment-shaped).
 * 4. DAG-ish (`backRatio ≤ β` and `avgDeg ≤ δ`) → `elk-layered`.
 * 5. cluster-ish (`C ≥ γ` or `avgDeg > δ`) → `d3-force`.
 * 6. otherwise (sparse-but-cyclic messy middle) → `d3-force`.
 *
 * The `C ≥ γ` disjunct in rule 5 is dropped above {@link V_MAX} (cost guard).
 */
export function chooseProvider(cut: Cut, edges: readonly InducedEdge[]): ProviderChoice {
  const members = cut.members;
  const V = members.length;
  if (V <= 1) return 'grid'; // rule 1

  const index = new Map<NodeId, number>();
  members.forEach((m, i) => index.set(m, i));

  const { adj, E } = undirectedGraph(index, edges);
  if (E === 0) return 'grid'; // rule 2

  const comp = connectedComponents(members, edges).length;
  if (E === V - comp) return 'tree'; // rule 3 (forest ⟺ E == V − comp for a simple graph)

  const avgDeg = (2 * E) / V;
  const br = backRatio(index, edges);
  if (br <= BETA && avgDeg <= DELTA) return 'elk-layered'; // rule 4

  // rule 5 (cluster-ish). `C` skipped above the cost guard (ADR-0018).
  const clusterish = V <= V_MAX ? clusteringCoefficient(adj) >= GAMMA : false;
  if (clusterish || avgDeg > DELTA) return 'd3-force';

  return 'd3-force'; // rule 6 (messy middle)
}
