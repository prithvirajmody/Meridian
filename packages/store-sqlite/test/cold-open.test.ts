/**
 * The 11C exit criterion: cold-open a big db → first interactive cut
 * without full hydration (ADR-0039 + ADR-0038 cold open). Also the memory
 * soak: hydration under a budget evicts LRU and stays honest, hydration/
 * eviction churn never touches the durable op log, and re-hydration is
 * byte-identical.
 */
import { describe, expect, it } from 'vitest';
import {
  addGraph,
  addNode,
  createGraphSpace,
  encodePretty,
  type GraphSpace,
  type NodeId,
} from '@meridian/graph-core';
import { buildLevelChain, LodResolver } from '@meridian/abstraction';
import type { GraphStore, HydrationManager } from '@meridian/graph-store';
import { BetterSqlite3Driver, openProject, openProjectStore } from '../src/node/index.js';
import { gid, DERIVED, SRC, tmpProjectPath } from './helpers.js';

const SECTIONS = 5;
const NODES_PER_SECTION = 20;
const SUBS_PER_SECTION = 3;
const NODES_PER_SUB = 30;
const TOTAL_GRAPHS = 1 + SECTIONS + SECTIONS * SUBS_PER_SECTION; // 21
const POLICY = { thresholds: [0.5], hysteresis: 0 };

/** Root graph with SECTIONS detail graphs, each with SUBS deeper graphs. */
function deepSpace(): GraphSpace {
  let space = createGraphSpace();
  space = addGraph(space, { id: gid('g-root'), label: 'Root', domain: 'test', provenance: DERIVED });
  for (let s = 0; s < SECTIONS; s++) {
    const sec = gid(`g-sec-${s}`);
    space = addGraph(space, { id: sec, label: `Section ${s}`, domain: 'test', provenance: DERIVED });
    for (let j = 0; j < SUBS_PER_SECTION; j++) {
      const sub = gid(`g-sub-${s}-${j}`);
      space = addGraph(space, { id: sub, label: `Sub ${s}.${j}`, domain: 'test', provenance: DERIVED });
      for (let n = 0; n < NODES_PER_SUB; n++) {
        space = addNode(space, sub, {
          id: `n-sub-${s}-${j}-${n}` as NodeId,
          kind: 'test:leaf',
          label: `Leaf ${s}.${j}.${n}`,
          provenance: SRC,
        });
      }
    }
    for (let n = 0; n < NODES_PER_SECTION; n++) {
      space = addNode(space, sec, {
        id: `n-sec-${s}-${n}` as NodeId,
        kind: 'test:item',
        label: `Item ${s}.${n}`,
        provenance: SRC,
        ...(n < SUBS_PER_SECTION ? { detail: { graph: gid(`g-sub-${s}-${n}`) } } : {}),
      });
    }
    space = addNode(space, gid('g-root'), {
      id: `n-root-${s}` as NodeId,
      kind: 'test:section',
      label: `Section ${s}`,
      provenance: SRC,
      detail: { graph: sec },
    });
  }
  return space;
}

async function seedProject(): Promise<string> {
  const path = tmpProjectPath('deep.meridian');
  const project = await openProject(path, { initialSpace: deepSpace() });
  await project.close();
  return path;
}

/** Hydrate every cold graph top-down (BFS over shells). */
async function hydrateAll(store: GraphStore, hydration: HydrationManager): Promise<void> {
  for (;;) {
    const cold = [...hydration.coldSet()].filter((id) => store.snapshot().graphs.has(id)).sort();
    if (cold.length === 0) return;
    for (const id of cold) await hydration.hydrate(id);
  }
}

describe('cold open → first interactive cut without full hydration (11C exit)', () => {
  it('opens the spine only, resolves a cut, and drills in via hydration', async () => {
    const path = await seedProject();
    const { project, store, hydration } = await openProjectStore(path, { cold: true });
    expect(hydration).toBeDefined();

    // The spine: root graph + one shell per section — not the 21 graphs.
    expect(project.manifest!.size).toBe(TOTAL_GRAPHS);
    expect(project.space.graphs.size).toBe(1 + SECTIONS);
    expect(store.snapshot().graphs.get(gid('g-sec-0'))!.nodes.size).toBe(0); // shell

    // First interactive cut, straight off the spine.
    const chain = buildLevelChain(store.snapshot());
    const resolver = new LodResolver(store.snapshot(), chain, POLICY);
    const result = resolver.resolve({ zoom: 0, overrides: new Map(), cold: hydration!.coldSet() });
    expect(result.cut.members.length).toBe(SECTIONS); // the root's section nodes
    expect(result.cut.coverage.covers).toBe(true);
    expect(result.frontier.needsHydration.length).toBe(SECTIONS);
    hydration!.touch(result.cut.members.map((m) => store.snapshot().graphs.get(gid('g-root'))!.nodes.get(m)!.detail!.graph));

    // Drill-in: expanding a cold frontier member is the hydration trigger.
    await hydration!.hydrate(gid('g-sec-0'));
    expect(hydration!.state(gid('g-sec-0'))).not.toBe('cold');
    // Hydration brought the section's elements and its children's shells only.
    expect(store.snapshot().graphs.size).toBe(1 + SECTIONS + SUBS_PER_SECTION);

    const resolver2 = new LodResolver(store.snapshot(), buildLevelChain(store.snapshot()), POLICY);
    const deep = resolver2.resolve({ zoom: 1, overrides: new Map(), cold: hydration!.coldSet() });
    const memberSet = new Set(deep.cut.members);
    expect(memberSet.has('n-sec-0-5' as NodeId)).toBe(true); // section content visible
    // The other sections stayed cold and are emitted 'cold' (descent warranted).
    expect(deep.provenance.reasons.get('n-root-1' as NodeId)).toBe('cold');
    // The hydrated section's sub-detail nodes are on the hydration frontier.
    expect(deep.frontier.needsHydration).toContain('n-sec-0-0' as NodeId);

    await project.close();
  });

  it('full hydration equals the eager open byte-for-byte; churn is volatile', async () => {
    const path = await seedProject();

    const eager = await openProject(path);
    const eagerBytes = encodePretty(eager.space);
    await eager.close();

    const { project, store, hydration } = await openProjectStore(path, { cold: true });
    await hydrateAll(store, hydration!);
    expect(encodePretty(store.snapshot())).toBe(eagerBytes);

    // Evict a whole section (deepest-first), then re-hydrate: byte-identical.
    for (let j = 0; j < SUBS_PER_SECTION; j++) expect(hydration!.evict(gid(`g-sub-2-${j}`))).toBe(true);
    expect(hydration!.evict(gid('g-sec-2'))).toBe(true);
    expect(hydration!.state(gid('g-sec-2'))).toBe('cold');
    await hydration!.hydrate(gid('g-sec-2'));
    for (let j = 0; j < SUBS_PER_SECTION; j++) await hydration!.hydrate(gid(`g-sub-2-${j}`));
    expect(encodePretty(store.snapshot())).toBe(eagerBytes);

    await project.close();

    // All that churn was volatile: the durable log never grew.
    const inspector = new BetterSqlite3Driver(path, { readonly: true });
    expect(Number(inspector.get('SELECT COUNT(*) AS n FROM oplog')!.n)).toBe(0);
    inspector.close();

    const reopened = await openProject(path);
    expect(reopened.version.counter).toBe(0);
    expect(encodePretty(reopened.space)).toBe(eagerBytes);
    await reopened.close();
  });

  it('soak: hydration under a small budget evicts LRU and stays under the ceiling', async () => {
    const path = await seedProject();
    const { project, store, hydration } = await openProjectStore(path, {
      cold: true,
      hydrationPolicy: { maxResidentElements: 120, lowWaterRatio: 0.8 },
    });

    // Churn: hydrate every section and every sub, touching as we go.
    for (let round = 0; round < 2; round++) {
      for (let s = 0; s < SECTIONS; s++) {
        const sec = gid(`g-sec-${s}`);
        if (store.snapshot().graphs.has(sec)) {
          await hydration!.hydrate(sec);
          hydration!.touch([sec]);
        }
        for (let j = 0; j < SUBS_PER_SECTION; j++) {
          const sub = gid(`g-sub-${s}-${j}`);
          if (store.snapshot().graphs.has(sub)) {
            await hydration!.hydrate(sub);
            hydration!.touch([sub]);
          }
          const stats = hydration!.stats();
          // The ceiling holds unless nothing is evictable — and then the
          // overshoot is reported, never silent (correctness over budget).
          if (stats.residentElements > 120) {
            expect(stats.overBudget).toBe(true);
            expect(hydration!.evictToBudget()).toBe(0);
          }
        }
      }
    }
    const stats = hydration!.stats();
    expect(stats.evictions).toBeGreaterThan(0);
    expect(stats.hydrations).toBeGreaterThan(SECTIONS);
    // The store still answers: a final cut over the current slab resolves.
    const resolver = new LodResolver(store.snapshot(), buildLevelChain(store.snapshot()), POLICY);
    const result = resolver.resolve({ zoom: 0, overrides: new Map(), cold: hydration!.coldSet() });
    expect(result.cut.coverage.covers).toBe(true);
    await project.close();
  });
});
