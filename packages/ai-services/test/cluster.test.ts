/**
 * `clusterNodes` / `EmbeddingClusterer` (8E): embeddings are pluggable (any
 * provider on the `embedding` route supplies the vectors), but the clustering
 * is a pure, fully deterministic function of those vectors (I6) — same soup,
 * same groups, byte-stable for replay. Clusters are AI-derived, so each carries
 * the embedding call's provenance and becomes a proposal, never a write.
 */
import type { MockEmbeddingHandler } from '@meridian/ai';
import { describe, expect, it } from 'vitest';
import { clusterNodes, clustersToProposal, EmbeddingClusterer, type ClusterNodeInput } from '../src/cluster.js';
import { makeSession } from './helpers.js';

function nodes(ids: string[]): ClusterNodeInput[] {
  return ids.map((id) => ({ id, text: id, kind: 'doc:node', label: id }));
}

/** One-hot-by-group embedding: text `g{k}#{i}` → basis vector e_k (+ tiny jitter). */
const plantedEmbed: MockEmbeddingHandler = (req) =>
  req.input.map((t) => {
    const m = /^g(\d+)#(\d+)$/.exec(t)!;
    const group = Number(m[1]);
    const i = Number(m[2]);
    const v = new Array<number>(5).fill(0);
    v[group] = 1 + i * 1e-9;
    return v;
  });

describe('clusterNodes — determinism (I6)', () => {
  it('produces byte-identical clusters across independent runs', async () => {
    const soup = nodes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    const a = await clusterNodes(makeSession().session, soup, { k: 2 });
    const b = await clusterNodes(makeSession().session, soup, { k: 2 });
    expect(a.clusters).toEqual(b.clusters);
  });

  it('is independent of input order (sorts the soup before embedding)', async () => {
    const forward = await clusterNodes(makeSession().session, nodes(['a', 'b', 'c', 'd']), { k: 2 });
    const shuffled = await clusterNodes(makeSession().session, nodes(['d', 'b', 'a', 'c']), { k: 2 });
    expect(forward.clusters).toEqual(shuffled.clusters);
  });
});

describe('clusterNodes — pluggable embeddings recover planted structure', () => {
  it('groups by the embedding provider’s vectors, not the labels', async () => {
    const { session } = makeSession({ onEmbed: plantedEmbed });
    const soup: ClusterNodeInput[] = [
      { id: 'a', text: 'g0#0' },
      { id: 'b', text: 'g0#1' },
      { id: 'c', text: 'g1#0' },
      { id: 'd', text: 'g1#1' },
    ];
    const { clusters } = await clusterNodes(session, soup, { k: 2 });
    const memberSets = clusters.map((c) => [...c.members].sort());
    expect(memberSets).toContainEqual(['a', 'b']);
    expect(memberSets).toContainEqual(['c', 'd']);
    // Identical-direction vectors ⇒ near-perfect cohesion.
    for (const c of clusters) expect(c.confidence).toBeGreaterThan(0.99);
  });

  it('scales maximally dispersed unit vectors to zero cohesion', async () => {
    const { session } = makeSession({
      onEmbed: (req) => req.input.map((_, i) => i === 0 ? [1, 0] : [-1, 0]),
    });
    const { clusters } = await clusterNodes(session, nodes(['a', 'b']), { k: 1 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.confidence).toBe(0);
  });
});

describe('clusterNodes — 500-node soup → labeled groups (acceptance)', () => {
  it('recovers 5 planted groups covering all 500 nodes exactly once', async () => {
    const { session } = makeSession({ onEmbed: plantedEmbed });
    const soup: ClusterNodeInput[] = [];
    for (let g = 0; g < 5; g++) {
      for (let i = 0; i < 100; i++) soup.push({ id: `n${g}_${String(i).padStart(3, '0')}`, text: `g${g}#${i}` });
    }
    const { clusters } = await clusterNodes(session, soup, { k: 5 });

    expect(clusters).toHaveLength(5);
    const all = clusters.flatMap((c) => c.members);
    expect(all).toHaveLength(500);
    expect(new Set(all).size).toBe(500); // disjoint partition
    for (const c of clusters) {
      expect(c.label).toMatch(/^Cluster of \d+ \(.+\)$/);
      const groups = new Set(c.members.map((m) => m.slice(0, 2)));
      expect(groups.size).toBe(1); // each cluster is one planted group
    }
  });
});

describe('clusterNodes — edges & options', () => {
  it('returns no clusters for an empty soup', async () => {
    const { clusters } = await clusterNodes(makeSession().session, [], { k: 3 });
    expect(clusters).toEqual([]);
  });

  it('clamps k above n down to n', async () => {
    const { clusters } = await clusterNodes(makeSession({ onEmbed: plantedEmbed }).session, [
      { id: 'a', text: 'g0#0' },
      { id: 'b', text: 'g1#0' },
    ], { k: 99 });
    expect(clusters.length).toBeLessThanOrEqual(2);
  });

  it('EmbeddingClusterer binds a session and default options', async () => {
    const clusterer = new EmbeddingClusterer(makeSession({ onEmbed: plantedEmbed }).session, { k: 2 });
    const { clusters } = await clusterer.cluster([
      { id: 'a', text: 'g0#0' },
      { id: 'b', text: 'g1#0' },
    ]);
    expect(clusters.length).toBe(2);
  });
});

describe('clustersToProposal — provenance flows onto the groups', () => {
  it('carries the embedding call’s replay key + cohesion as confidence', async () => {
    const { session } = makeSession(); // default deterministic embedding
    const { clusters } = await clusterNodes(session, nodes(['a', 'b']), { k: 1 });
    const { groups } = clustersToProposal(clusters);
    expect(groups[0]).toMatchObject({
      providerId: 'embed',
      model: 'embed-model',
      promptVersion: 'embedding',
      inputHash: expect.any(String),
    });
    expect(groups[0]!.confidence).toBe(clusters[0]!.confidence);
  });
});
