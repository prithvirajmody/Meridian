/**
 * HydrationManager (ADR-0039, SUBPHASES 11C): the cold ↔ live state machine
 * over graph-granular shells. Hydration/eviction move through the one write
 * path as *volatile* deltas (version advances, subscribers fire, backend
 * never sees them); eviction is safe by construction (roots, pins, the
 * undo-protection set, live children all refuse); re-hydration is
 * byte-identical; the resident-element budget prefers correctness over
 * budget (the ADR-0014 precedence rule).
 *
 * Fixture: a 3-level containment chain
 *   g-r (n-a [detail g-a], n-b, e-ab) → g-a (n-c [detail g-c], n-d) → g-c (n-e)
 * "Full" = every graph populated. "Spine" = g-r full + g-a as an empty shell
 * (same meta) + g-c absent — the top slab a cold open starts from.
 */
import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  createGraphSpace,
  encodePretty,
  MeridianError,
  type GraphId,
  type GraphSpace,
  type SemanticGraph,
  type SemanticNode,
} from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import {
  createStore,
  HydrationManager,
  invertDelta,
  type ChangeSet,
  type GraphManifestEntry,
  type HydrationPolicy,
  type StorageBackend,
} from '../src/index.js';
import { ORIGIN, SRC } from './helpers.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const gR = asGraphId('g-r');
const gA = asGraphId('g-a');
const gC = asGraphId('g-c');
const nA = asNodeId('n-a');
const nB = asNodeId('n-b');
const nC = asNodeId('n-c');
const nD = asNodeId('n-d');
const nE = asNodeId('n-e');
const eAB = asEdgeId('e-ab');

/** The fully-populated space (Maps in sorted insertion order — hydration
 * deltas must be deterministic). */
function fullSpace(): GraphSpace {
  let s = createGraphSpace();
  s = addGraph(s, { id: gR, label: 'Root', domain: 'demo', provenance: SRC });
  s = addGraph(s, { id: gA, label: 'A', domain: 'demo', provenance: SRC });
  s = addGraph(s, { id: gC, label: 'C', domain: 'demo', provenance: SRC });
  s = addNode(s, gC, { id: nE, kind: 'demo:step', label: 'e', provenance: SRC });
  s = addNode(s, gA, { id: nC, kind: 'demo:step', label: 'c', detail: { graph: gC }, provenance: SRC });
  s = addNode(s, gA, { id: nD, kind: 'demo:step', label: 'd', provenance: SRC });
  s = addNode(s, gR, { id: nA, kind: 'demo:module', label: 'a', detail: { graph: gA }, provenance: SRC });
  s = addNode(s, gR, { id: nB, kind: 'demo:module', label: 'b', provenance: SRC });
  s = addEdge(s, gR, { id: eAB, src: nA, dst: nB, kind: 'core:references', provenance: SRC });
  return s;
}

/** The spine (ADR-0039 top slab): g-r full, g-a an empty shell with its real
 * meta (still claimed by n-a), g-c absent from the space entirely. */
function spineSpace(full: GraphSpace): GraphSpace {
  const shell: SemanticGraph = { ...full.graphs.get(gA)!, nodes: new Map(), edges: new Map() };
  return {
    graphs: new Map<GraphId, SemanticGraph>([
      [gR, full.graphs.get(gR)!],
      [gA, shell],
    ]),
    roots: [gR],
  };
}

/** Backend manifest: every durable graph → meta + FULL element counts. */
function manifestFor(full: GraphSpace): Map<GraphId, GraphManifestEntry> {
  const manifest = new Map<GraphId, GraphManifestEntry>();
  for (const [id, g] of full.graphs) {
    manifest.set(id, { meta: g.meta, nodeCount: g.nodes.size, edgeCount: g.edges.size });
  }
  return manifest;
}

/** Mock StorageBackend over the full space; `state.loadGraph` overrides the
 * loader (deferred promises for coalesce/abort tests). */
function testBackend(source: GraphSpace) {
  const hints: GraphId[][] = [];
  const state = {
    appendCount: 0,
    loadCalls: [] as GraphId[],
    loadGraph: undefined as ((id: GraphId) => Promise<SemanticGraph | null>) | undefined,
  };
  const backend: StorageBackend = {
    loadGraph: (id) => {
      state.loadCalls.push(id);
      if (state.loadGraph) return state.loadGraph(id);
      return Promise.resolve(source.graphs.get(id) ?? null);
    },
    persist: async () => {},
    appendOps: async () => {
      state.appendCount++;
    },
    evictHint: (ids) => hints.push([...ids]),
  };
  return { backend, hints, state };
}

function setup(policy?: HydrationPolicy) {
  const full = fullSpace();
  const { backend, hints, state } = testBackend(full);
  const store = createStore(spineSpace(full), { backend });
  const manifest = manifestFor(full);
  const manager = new HydrationManager({ store, backend, manifest, ...(policy ? { policy } : {}) });
  return { full, backend, hints, state, store, manifest, manager };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MeridianError);
  expect((caught as MeridianError).code).toBe(code);
}

describe('initial states over a spine space', () => {
  it('classifies live root, cold shell, and cold absent descendant', () => {
    const { manager, manifest } = setup();
    expect(manager.state(gR)).toBe('live'); // root with elements — never evictable
    expect(manager.state(gA)).toBe('cold'); // empty shell, manifest says 2 nodes
    expect(manager.state(gC)).toBe('cold'); // absent from the space
    expect(manager.coldSet()).toEqual(new Set([gA, gC]));
    expect(manager.summary(gA)).toEqual(manifest.get(gA));
    expect(manager.summary(gA)).toMatchObject({ nodeCount: 2, edgeCount: 0 });
    expect(manager.stats()).toMatchObject({
      residentElements: 3, // g-r: 2 nodes + 1 edge
      liveGraphs: 1,
      coldGraphs: 2,
      hydrations: 0,
      evictions: 0,
      overBudget: false,
    });
  });
});

describe('hydration refusals', () => {
  it('rejects hydrating a graph with no shell in the space (ancestors cold)', async () => {
    const { manager } = setup();
    await expectCode(manager.hydrate(gC), 'hydration-unreachable');
    expect(manager.state(gC)).toBe('cold');
  });

  it('rejects hydrating a graph the manifest does not know', async () => {
    const { manager } = setup();
    await expectCode(manager.hydrate(asGraphId('g-x')), 'unknown-graph');
  });
});

describe('hydrate(g-a): one volatile delta, elements + child shells', () => {
  it('materializes g-a and a claimed g-c shell without touching the backend log', async () => {
    const { manager, store, state } = setup();
    const seen: ChangeSet[] = [];
    store.subscribe((c) => seen.push(c));

    await manager.hydrate(gA);

    // Not pinned, not protected, not a root, child g-c cold → evictable.
    expect(manager.state(gA)).toBe('evictable');
    const space = store.snapshot();
    expect([...space.graphs.get(gA)!.nodes.keys()].sort()).toEqual([nC, nD]);
    // The top-slab invariant: g-c now exists as an empty shell, claimed by n-c.
    const shell = space.graphs.get(gC)!;
    expect(shell.nodes.size + shell.edges.size).toBe(0);
    expect(shell.meta).toEqual(manager.summary(gC)!.meta);
    expect(space.roots).toEqual([gR]); // claimed — never a spurious root
    expect(manager.state(gC)).toBe('cold');

    expect(store.version().counter).toBe(1); // volatile deltas advance the session version
    await flush();
    expect(state.appendCount).toBe(0); // never forwarded to the durable log
    expect(seen).toHaveLength(1);
    expect(seen[0]!.origin.volatile).toBe(true);
    expect(manager.stats()).toMatchObject({ residentElements: 5, hydrations: 1, liveGraphs: 2 });
  });
});

describe('coalescing and abort', () => {
  it('coalesces concurrent hydrations onto one in-flight promise', async () => {
    const { manager, full, state } = setup();
    let release!: (g: SemanticGraph | null) => void;
    state.loadGraph = () => new Promise((resolve) => (release = resolve));

    const p1 = manager.hydrate(gA);
    const p2 = manager.hydrate(gA);
    expect(p2).toBe(p1); // same promise object
    expect(manager.state(gA)).toBe('hydrating');
    expect(state.loadCalls).toEqual([gA]); // loadGraph called once

    release(full.graphs.get(gA)!);
    await p1;
    expect(manager.state(gA)).toBe('evictable');
    expect(state.loadCalls).toHaveLength(1);
  });

  it('an abort before the load resolves rejects hydration-aborted and leaves the space untouched', async () => {
    const { manager, store, full, state } = setup();
    let release!: (g: SemanticGraph | null) => void;
    state.loadGraph = () => new Promise((resolve) => (release = resolve));

    const controller = new AbortController();
    const p = manager.hydrate(gA, { signal: controller.signal });
    controller.abort();
    release(full.graphs.get(gA)!); // the load completes, but must not commit

    await expectCode(p, 'hydration-aborted');
    expect(manager.state(gA)).toBe('cold');
    expect(store.version().counter).toBe(0); // no delta applied
    expect(store.snapshot().graphs.get(gA)!.nodes.size).toBe(0);
    expect(store.snapshot().graphs.has(gC)).toBe(false);
  });

  it('hydrating a live graph resolves immediately without calling loadGraph', async () => {
    const { manager, state } = setup();
    await manager.hydrate(gR); // live from construction
    expect(state.loadCalls).toHaveLength(0);
    await manager.hydrate(gA);
    const calls = state.loadCalls.length;
    await manager.hydrate(gA); // already live
    expect(state.loadCalls).toHaveLength(calls);
  });
});

describe('eviction: deepest-first, shells, byte-identical re-hydration', () => {
  it('refuses a parent with a live child, evicts deepest-first, round-trips exactly', async () => {
    const { manager, store, hints, full } = setup();
    await manager.hydrate(gA);
    await manager.hydrate(gC);

    // g-c is live and durably non-empty → its parent must refuse.
    expect(manager.evict(gA)).toBe(false);

    // Deepest first: g-c → shell (present, still claimed), advisory hint fires.
    expect(manager.evict(gC)).toBe(true);
    const afterC = store.snapshot();
    expect(afterC.graphs.get(gC)!.nodes.size).toBe(0);
    expect(afterC.graphs.has(gC)).toBe(true);
    expect(afterC.roots).toEqual([gR]); // still claimed by n-c
    expect(manager.state(gC)).toBe('cold');
    expect(hints.at(-1)).toEqual([gC]);

    // Now g-a: its elements go, and the g-c shell leaves the space entirely.
    expect(manager.evict(gA)).toBe(true);
    const afterA = store.snapshot();
    expect(afterA.graphs.get(gA)!.nodes.size).toBe(0);
    expect(afterA.graphs.has(gC)).toBe(false);
    expect(manager.state(gA)).toBe('cold');
    expect(hints.at(-1)).toEqual([gA, gC]);
    expect(manager.stats()).toMatchObject({ residentElements: 3, evictions: 2 });

    // Re-hydration is byte-identical to the full space (the ADR-0027 invariant).
    await manager.hydrate(gA);
    await manager.hydrate(gC);
    const producer = { producer: { name: 'test', version: '0' } };
    expect(encodePretty(store.snapshot(), producer)).toBe(encodePretty(full, producer));
  });
});

describe('protected sets refuse eviction', () => {
  it('pin blocks eviction until unpin', async () => {
    const { manager } = setup();
    await manager.hydrate(gA);
    manager.pin(gA);
    expect(manager.state(gA)).toBe('live'); // pinned — not evictable
    expect(manager.evict(gA)).toBe(false);
    manager.unpin(gA);
    expect(manager.evict(gA)).toBe(true);
  });

  it('a semantic delta history-protects its graphs for the whole session', async () => {
    const { manager, store } = setup();
    await manager.hydrate(gA);
    const r = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:attr', graph: gA, id: nC, key: 'test:x', next: 1 }],
    });
    expect(r.ok).toBe(true);
    await flush(); // protection arrives via the store subscription (microtask)
    expect(manager.state(gA)).toBe('live');
    expect(manager.evict(gA)).toBe(false);
    manager.unpin(gA); // no pin involved — protection is the history set
    expect(manager.evict(gA)).toBe(false);
  });

  it('roots are never evictable', () => {
    const { manager } = setup();
    expect(manager.evict(gR)).toBe(false);
    expect(manager.state(gR)).toBe('live');
  });
});

describe('undo after eviction pressure (ADR-0039 §6)', () => {
  it('the undo-protection set keeps inverse targets live', async () => {
    const { manager, store } = setup();
    await manager.hydrate(gA);
    await manager.hydrate(gC);
    const r = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:attr', graph: gA, id: nC, key: 'test:x', next: 1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await flush();

    // Evict everything evictable: g-a refuses (history-protected), g-c goes.
    expect(manager.evict(gA)).toBe(false);
    expect(manager.evict(gC)).toBe(true);

    // Undo = invert + apply. Volatile evictions advanced the version since the
    // commit, so the inverse is submitted unversioned (op-level prev
    // assertions carry the safety, ADR-0007).
    const inverse = invertDelta(r.delta);
    const undo = store.apply({ origin: inverse.origin, ops: inverse.ops });
    expect(undo.ok).toBe(true);
    expect(store.snapshot().graphs.get(gA)!.nodes.get(nC)!.attrs['test:x']).toBeUndefined();
  });
});

describe('budget: correctness over budget, LRU drain to low water', () => {
  it('hydration proceeds past the ceiling when nothing is evictable, and evictToBudget drains what it can', async () => {
    // Ceiling 4, low water 2. The spine root alone holds 3 elements.
    const { manager } = setup({ maxResidentElements: 4, lowWaterRatio: 0.5 });

    // Hydrating g-a overshoots (3+2=5): the auto-evict pass finds nothing
    // evictable (g-r is a root, g-a itself is excluded) — hydration still wins.
    await manager.hydrate(gA);
    expect(manager.state(gA)).toBe('evictable');
    expect(manager.stats()).toMatchObject({ residentElements: 5, overBudget: true });

    await manager.hydrate(gC); // 6 resident, still over
    expect(manager.stats()).toMatchObject({ residentElements: 6, overBudget: true });

    // Even though g-c is the most recently touched, it is the ONLY evictable
    // candidate (g-a has a live, durably non-empty child) — so it goes first.
    manager.touch([gC]);
    expect(manager.evictToBudget()).toBe(1);
    expect(manager.state(gC)).toBe('cold');
    const mid = manager.stats();
    expect(mid.residentElements).toBe(5);
    expect(mid.residentElements <= 4 || mid.overBudget).toBe(true);

    // g-a became evictable only after g-c cooled; a second pass drains it.
    expect(manager.state(gA)).toBe('evictable');
    expect(manager.evictToBudget()).toBe(1);
    expect(manager.stats()).toMatchObject({ residentElements: 3, overBudget: false });
  });
});

describe('manifest maintenance under semantic edits', () => {
  it('a semantic node:add bumps summary counts and resident size (after the microtask)', async () => {
    const { manager, store } = setup();
    await manager.hydrate(gA);
    const before = manager.stats().residentElements; // 5

    const node: SemanticNode = {
      id: asNodeId('n-f'),
      kind: 'demo:step',
      label: 'f',
      attrs: {},
      provenance: SRC,
    };
    const r = store.apply({ origin: ORIGIN, ops: [{ t: 'node:add', graph: gA, node }] });
    expect(r.ok).toBe(true);
    await flush(); // manifest counts arrive via the store subscription
    expect(manager.summary(gA)).toMatchObject({ nodeCount: 3, edgeCount: 0 });
    expect(manager.stats().residentElements).toBe(before + 1);

    // dispose() detaches the subscription: later semantic commits stop counting.
    manager.dispose();
    const node2: SemanticNode = { ...node, id: asNodeId('n-g'), label: 'g' };
    expect(store.apply({ origin: ORIGIN, ops: [{ t: 'node:add', graph: gA, node: node2 }] }).ok).toBe(true);
    await flush();
    expect(manager.summary(gA)).toMatchObject({ nodeCount: 3 });
  });
});
