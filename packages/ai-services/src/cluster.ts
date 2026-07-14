/**
 * `EmbeddingClusterer` / `clusterNodes` (subphase 8E): turn a flat node soup
 * into labeled groups. Embeddings come from the gateway's independent embedding
 * route (a *pluggable* provider — the core needs only vectors, ADR-0029); the
 * clustering itself is a pure, fully deterministic function of those vectors, so
 * the same soup always yields the same groups (I6) and replay is byte-stable.
 *
 * Determinism strategy: unit-normalize vectors, seed centroids by farthest-first
 * traversal (Gonzalez — no RNG needed), then Lloyd iterations to convergence.
 * Every tie is broken by ascending index, and sums run in fixed order, so there
 * is no floating-point or ordering nondeterminism. Clusters are AI-derived
 * (their vectors came from a model), so each carries the embedding call's
 * provenance and enters the graph only as a proposal (ADR-0031).
 */
import { type AiSession, type BudgetState } from '@meridian/ai';
import { deriveNodeId } from '@meridian/graph-core';
import type { ProposedGroup } from '@meridian/plugin-api';
import { type AiProvenance, provenanceOfEmbed } from './provenance.js';

/** One node in the soup to be clustered. */
export interface ClusterNodeInput {
  readonly id: string;
  /** The text embedded for this node (label + salient content). */
  readonly text: string;
  readonly kind?: string;
  readonly label?: string;
}

/** One resulting cluster. */
export interface Cluster {
  /** Deterministic, content-addressed group id (from its sorted members). */
  readonly id: string;
  readonly label: string;
  readonly members: readonly string[];
  /** Cohesion in [0,1] (1 = members identical in embedding space). */
  readonly confidence: number;
  /** The embedding call that produced this cluster's vectors (ADR-0031). */
  readonly provenance: AiProvenance;
}

export interface ClusterResult {
  readonly clusters: readonly Cluster[];
  readonly budget: BudgetState;
}

export interface ClusterNodesOptions {
  readonly signal?: AbortSignal;
  /** Cluster count. Defaults to a stable √(n/2) heuristic, clamped to [1, n]. */
  readonly k?: number;
  /** Domain used to namespace cluster ids. Default `core`. */
  readonly domain?: string;
  /** Max Lloyd iterations. Default 50. */
  readonly maxIterations?: number;
}

const CLUSTER_SOURCE = 'core:embedding-cluster';

/** Cluster a flat node soup into labeled groups (see module doc). */
export async function clusterNodes(
  session: AiSession,
  nodes: readonly ClusterNodeInput[],
  options: ClusterNodesOptions = {},
): Promise<ClusterResult> {
  const domain = options.domain ?? 'core';
  if (nodes.length === 0) return { clusters: [], budget: session.budget };

  // Deterministic input order: sort the soup by id before embedding.
  const ordered = [...nodes].sort((a, b) => cmp(a.id, b.id));
  const embed = await session.embed(
    ordered.map((n) => n.text),
    { ...(options.signal !== undefined ? { signal: options.signal } : {}) },
  );
  const provenance = provenanceOfEmbed(embed);
  const vectors = embed.vectors.map((v) => normalize(v));

  const k = clampK(options.k ?? defaultK(ordered.length), ordered.length);
  const assignment = kMeans(vectors, k, options.maxIterations ?? 50);

  const clusters = buildClusters(ordered, vectors, assignment, domain, provenance);
  return { clusters, budget: session.budget };
}

/**
 * The named clusterer the roadmap commits to (§5) — a thin, reusable facade
 * over {@link clusterNodes} that binds a session (and default options) once.
 * Embeddings are pluggable: whatever provider the session's `embedding` route
 * resolves to supplies the vectors; the clustering stays a pure function of
 * them (I6).
 */
export class EmbeddingClusterer {
  constructor(
    private readonly session: AiSession,
    private readonly defaults: ClusterNodesOptions = {},
  ) {}

  cluster(nodes: readonly ClusterNodeInput[], options: ClusterNodesOptions = {}): Promise<ClusterResult> {
    return clusterNodes(this.session, nodes, { ...this.defaults, ...options });
  }
}

/** Map clusters to an abstraction proposal for the one write path. */
export function clustersToProposal(clusters: readonly Cluster[]): { readonly groups: readonly ProposedGroup[] } {
  const groups: ProposedGroup[] = clusters.map((c) => ({
    id: c.id,
    label: c.label,
    members: c.members,
    rationale: `embedding cluster of ${c.members.length} nodes`,
    confidence: c.confidence,
    providerId: c.provenance.providerId,
    model: c.provenance.model,
    promptVersion: c.provenance.promptVersion,
    inputHash: c.provenance.inputHash,
  }));
  return { groups };
}

// ------------------------------------------------------------- pure clustering

function defaultK(n: number): number {
  return Math.max(1, Math.round(Math.sqrt(n / 2)));
}

function clampK(k: number, n: number): number {
  if (!Number.isFinite(k)) return 1;
  return Math.min(Math.max(1, Math.trunc(k)), n);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalize(v: readonly number[]): readonly number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v.map(() => 0);
  return v.map((x) => x / norm);
}

function sqDist(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return sum;
}

/** Farthest-first (Gonzalez) seeding — deterministic, no RNG. */
function seedCentroids(vectors: readonly (readonly number[])[], k: number): number[] {
  const chosen: number[] = [0];
  while (chosen.length < k) {
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < vectors.length; i++) {
      if (chosen.includes(i)) continue;
      let minToChosen = Infinity;
      for (const c of chosen) minToChosen = Math.min(minToChosen, sqDist(vectors[i]!, vectors[c]!));
      // Strict `>` keeps the smallest index on ties (deterministic).
      if (minToChosen > bestDist) {
        bestDist = minToChosen;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // fewer distinct points than k
    chosen.push(bestIdx);
  }
  return chosen;
}

function meanOf(vectors: readonly (readonly number[])[], members: readonly number[], dim: number): number[] {
  const centroid = new Array<number>(dim).fill(0);
  for (const m of members) {
    const v = vectors[m]!;
    for (let d = 0; d < dim; d++) centroid[d]! += v[d]!;
  }
  const count = members.length;
  for (let d = 0; d < dim; d++) centroid[d]! /= count;
  return centroid;
}

/** Deterministic Lloyd's algorithm; returns each point's cluster index. */
function kMeans(vectors: readonly (readonly number[])[], k: number, maxIterations: number): number[] {
  const n = vectors.length;
  const dim = vectors[0]?.length ?? 0;
  const seedIdx = seedCentroids(vectors, k);
  let centroids = seedIdx.map((i) => [...vectors[i]!]);
  const assignment = new Array<number>(n).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = sqDist(vectors[i]!, centroids[c]!);
        if (d < bestDist) {
          bestDist = d;
          best = c; // `<` keeps the smallest centroid index on ties
        }
      }
      if (assignment[i] !== best) changed = true;
      assignment[i] = best;
    }
    // Recompute centroids; empty clusters keep their previous centroid.
    const next = centroids.map((prev, c) => {
      const members: number[] = [];
      for (let i = 0; i < n; i++) if (assignment[i] === c) members.push(i);
      return members.length === 0 ? prev : meanOf(vectors, members, dim);
    });
    centroids = next;
    if (!changed) break;
  }
  return assignment;
}

function buildClusters(
  ordered: readonly ClusterNodeInput[],
  vectors: readonly (readonly number[])[],
  assignment: readonly number[],
  domain: string,
  provenance: AiProvenance,
): Cluster[] {
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < assignment.length; i++) {
    const c = assignment[i]!;
    (buckets.get(c) ?? buckets.set(c, []).get(c)!).push(i);
  }

  const clusters: Cluster[] = [];
  for (const indices of buckets.values()) {
    if (indices.length === 0) continue;
    const memberInputs = indices.map((i) => ordered[i]!);
    const members = memberInputs.map((n) => n.id).sort(cmp);
    const label = labelOf(memberInputs, members.length);
    const confidence = cohesion(indices, vectors);
    const id = deriveNodeId({ domain, source: CLUSTER_SOURCE, path: members });
    clusters.push({ id, label, members, confidence, provenance });
  }
  // Deterministic cluster order: by first (smallest) member id.
  clusters.sort((a, b) => cmp(a.members[0] ?? '', b.members[0] ?? ''));
  return clusters;
}

/** Deterministic label: the dominant member kind (ties by name) + size. */
function labelOf(members: readonly ClusterNodeInput[], size: number): string {
  const counts = new Map<string, number>();
  for (const m of members) {
    const kind = m.kind ?? 'core:node';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  let dominant = '';
  let best = -1;
  for (const [kind, count] of [...counts.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    if (count > best) {
      best = count;
      dominant = kind;
    }
  }
  return `Cluster of ${size} (${dominant})`;
}

/** Cohesion in [0,1]: one minus the mean squared distance from each normalized
 * member vector to its centroid. For unit vectors that mean is in [0,1]
 * (`1 - ||centroid||^2`), so no additional distance scaling is required. */
function cohesion(indices: readonly number[], vectors: readonly (readonly number[])[]): number {
  if (indices.length <= 1) return 1;
  const dim = vectors[0]?.length ?? 0;
  const centroid = meanOf(vectors, indices, dim);
  let total = 0;
  for (const i of indices) total += sqDist(vectors[i]!, centroid);
  const mean = total / indices.length;
  return Math.min(1, Math.max(0, 1 - mean));
}
