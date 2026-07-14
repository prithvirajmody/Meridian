/**
 * Deterministic built-in `AbstractionProvider`s (ROADMAP Phase 3 §3, §5). A
 * provider proposes grouping over a graph with little or no containment,
 * turning a flat region into hierarchy (§3.1 Cluster). These two are the
 * deterministic v1 pair; AI-backed providers arrive in P8 implementing the
 * same seam.
 *
 * The provider contract lives in `@meridian/plugin-api` (the `abstraction-
 * provider` capability, added in 3B). The dependency law (§20) forbids
 * abstraction from importing plugin-api, so — exactly as `level-chain.ts` does
 * for `LevelChainSpec` — the types below are **structural twins** of the
 * plugin-api ones (`GraphDocument` itself comes from graph-core, so it is
 * shared verbatim). A conformance test asserts assignability to the real
 * contract. Proposals are *suggestions*: {@link applyProposal} turns them into
 * ordinary tagged P1 deltas, never a second write path (§8.1).
 *
 * Both providers are pure functions of their input `GraphDocument` (I6): no
 * `Date.now`, no randomness. Interpretation notes (deliberate v1 choices, since
 * the roadmap phrases the two providers without fixing an algorithm):
 * - **containment rollup** groups each flat graph's weakly-connected
 *   components (its own edge structure is the containment signal).
 * - **degree/size collapse** gathers low-degree satellites around their hub.
 */
import { deriveNodeId, type AttrValue, type GraphDocument } from '@meridian/graph-core';

// ---------------------------------------------- structural twins of plugin-api

/** Structural twin of plugin-api's `ProposedGroup`. The optional fields after
 * `confidence` are additive AI carriers (P8, ADR-0031); deterministic
 * providers omit them all. */
export interface ProposedGroup {
  readonly id: string;
  readonly label: string;
  readonly members: readonly string[];
  readonly rationale: string;
  readonly confidence?: number;
  readonly summary?: string;
  readonly attrs?: Readonly<Record<string, AttrValue>>;
  readonly providerId?: string;
  readonly model?: string;
  readonly promptVersion?: string;
  readonly inputHash?: string;
}

/** Structural twin of plugin-api's `AbstractionProposal`. */
export interface AbstractionProposal {
  readonly groups: readonly ProposedGroup[];
}

/** Structural twin of plugin-api's `PluginLogger`. */
export interface ProviderLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Structural twin of plugin-api's `AbstractionContext`. */
export interface AbstractionContext {
  readonly apiVersion: string;
  readonly log: ProviderLogger;
  readonly budget?: { readonly maxGroups?: number };
}

/** Structural twin of plugin-api's `AbstractionProvider`. */
export interface AbstractionProvider {
  readonly id: string;
  propose(graph: GraphDocument, ctx: AbstractionContext): Promise<AbstractionProposal>;
}

// ------------------------------------------------------------------- helpers

interface FlatGraph {
  readonly domain: string;
  readonly nodeIds: readonly string[];
  /** Undirected adjacency (node → neighbor set), self-loops ignored. */
  readonly adj: ReadonlyMap<string, Set<string>>;
  readonly degree: ReadonlyMap<string, number>;
}

/** True when no node in the graph declares a `detail` (it is flat). */
function isFlat(graph: GraphDocument['graphs'][number]): boolean {
  return graph.nodes.every((n) => n.detail === undefined);
}

function readFlatGraph(graph: GraphDocument['graphs'][number]): FlatGraph {
  const nodeIds = graph.nodes.map((n) => n.id);
  const present = new Set(nodeIds);
  const adj = new Map<string, Set<string>>();
  const degree = new Map<string, number>();
  for (const id of nodeIds) {
    adj.set(id, new Set());
    degree.set(id, 0);
  }
  for (const e of graph.edges) {
    if (e.src === e.dst || !present.has(e.src) || !present.has(e.dst)) continue;
    adj.get(e.src)!.add(e.dst);
    adj.get(e.dst)!.add(e.src);
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  return { domain: graph.meta.domain, nodeIds, adj, degree };
}

/** Deterministic group-node id from the source provider and its sorted
 * members (ADR-0002): stable across runs, unique per membership set. */
function groupId(domain: string, provider: string, members: readonly string[]): string {
  return deriveNodeId({ domain, source: provider, path: [...members].sort()});
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --------------------------------------------------- containment-rollup

export const CONTAINMENT_ROLLUP_ID = 'core:containment-rollup';

/** Weakly-connected components via union-find; each component's sorted member
 * list, components ordered by their smallest member (deterministic). */
function components(g: FlatGraph): string[][] {
  const parent = new Map<string, string>();
  for (const id of g.nodeIds) parent.set(id, id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const [node, neighbors] of g.adj) for (const nb of neighbors) union(node, nb);

  const byRoot = new Map<string, string[]>();
  for (const id of g.nodeIds) {
    const root = find(id);
    (byRoot.get(root) ?? byRoot.set(root, []).get(root)!).push(id);
  }
  const out = [...byRoot.values()].map((m) => m.sort(compareStr));
  out.sort((a, b) => compareStr(a[0]!, b[0]!));
  return out;
}

/** Groups each flat graph's weakly-connected components of size ≥ 2. */
export const containmentRollupProvider: AbstractionProvider = {
  id: CONTAINMENT_ROLLUP_ID,
  propose(doc: GraphDocument): Promise<AbstractionProposal> {
    const groups: ProposedGroup[] = [];
    for (const graph of doc.graphs) {
      if (!isFlat(graph)) continue;
      const g = readFlatGraph(graph);
      for (const members of components(g)) {
        if (members.length < 2) continue;
        groups.push({
          id: groupId(g.domain, CONTAINMENT_ROLLUP_ID, members),
          label: `Group of ${members.length}`,
          members,
          rationale: `${members.length} nodes form a connected component`,
        });
      }
    }
    groups.sort((a, b) => compareStr(a.id, b.id));
    return Promise.resolve({ groups });
  },
};

// ------------------------------------------------- degree/size collapse

export const DEGREE_COLLAPSE_ID = 'core:degree-collapse';

/**
 * Gather low-degree satellites (degree ≤ 1) around their single hub neighbor
 * (degree ≥ 2). Each hub with at least one satellite yields a group of the hub
 * plus its satellites. Degree-0 nodes and hub-to-hub structure are left as-is.
 */
export const degreeSizeCollapseProvider: AbstractionProvider = {
  id: DEGREE_COLLAPSE_ID,
  propose(doc: GraphDocument): Promise<AbstractionProposal> {
    const groups: ProposedGroup[] = [];
    for (const graph of doc.graphs) {
      if (!isFlat(graph)) continue;
      const g = readFlatGraph(graph);
      const satellitesOf = new Map<string, string[]>();
      for (const id of g.nodeIds) {
        if ((g.degree.get(id) ?? 0) > 1) continue; // hubs are not satellites
        const neighbors = [...(g.adj.get(id) ?? [])];
        if (neighbors.length !== 1) continue; // degree-0 or self-only
        const hub = neighbors[0]!;
        if ((g.degree.get(hub) ?? 0) <= 1) continue; // neighbor is not a hub
        (satellitesOf.get(hub) ?? satellitesOf.set(hub, []).get(hub)!).push(id);
      }
      for (const [hub, satellites] of satellitesOf) {
        const members = [hub, ...satellites].sort(compareStr);
        groups.push({
          id: groupId(g.domain, DEGREE_COLLAPSE_ID, members),
          label: `Hub ${hub} + ${satellites.length}`,
          members,
          rationale: `hub "${hub}" with ${satellites.length} low-degree satellite(s)`,
        });
      }
    }
    groups.sort((a, b) => compareStr(a.id, b.id));
    return Promise.resolve({ groups });
  },
};

/** The deterministic providers shipped in P3. */
export const BUILTIN_ABSTRACTION_PROVIDERS: readonly AbstractionProvider[] = [
  containmentRollupProvider,
  degreeSizeCollapseProvider,
];
