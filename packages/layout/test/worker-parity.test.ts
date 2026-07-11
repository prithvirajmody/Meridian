/**
 * Worker parity (ROADMAP Phase 4 §12 exit; ADR-0017): `grid`/`tree` run
 * **inside the worker** must produce **byte-identical geometry** to the
 * main-thread providers — the property the order-preserving placeholder ids
 * (protocol.ts) buy us, and the same property the CLI golden-parity test
 * proves end-to-end over the corpus. This suite pins it on hand-built inputs
 * covering the degenerate cases (disconnected components, zero-size nodes,
 * single node, tree-shaped cuts) plus **stability parity** under a warm-start
 * delta (the `prev` wire path).
 */
import { describe, expect, it } from 'vitest';
import {
  elkLayeredProvider,
  gridProvider,
  LayoutWorkerHost,
  treeProvider,
  type CompoundNesting,
  type LayoutInput,
  type LayoutProvider,
  type LayoutResult,
  type LayoutWorkerHost as Host,
} from '../src/index.js';
import { cutOf, edge, n, sizes, uniformSizes } from './helpers.js';
import { makeNodeFactory } from './node-factory.js';

function assertLayoutEqual(worker: LayoutResult, main: LayoutResult, members: readonly string[]): void {
  expect(worker.stability).toBe(main.stability);
  expect(worker.bounds).toEqual(main.bounds);
  expect(worker.positions.size).toBe(main.positions.size);
  for (const id of members) {
    const w = worker.positions.get(id as never);
    const m = main.positions.get(id as never);
    expect(w).toEqual(m);
  }
  expect(worker.edgeRoutes).toBeUndefined();
  expect(main.edgeRoutes).toBeUndefined();
}

const cases: { name: string; provider: LayoutProvider; input: () => LayoutInput }[] = [
  {
    name: 'grid — connected + disconnected components',
    provider: gridProvider,
    input: () => ({
      cut: cutOf('a', 'b', 'c', 'x', 'y', 'z'),
      edges: [edge('a', 'b'), edge('b', 'c'), edge('x', 'y')], // {a,b,c}, {x,y}, {z}
      sizes: sizes({
        a: { width: 60, height: 28 },
        b: { width: 80, height: 30 },
        c: { width: 40, height: 20 },
        x: { width: 100, height: 28 },
        y: { width: 50, height: 28 },
        z: { width: 0, height: 0 }, // zero-size node
      }),
      hints: { spacing: 16 },
    }),
  },
  {
    name: 'tree — hierarchy from induced edges',
    provider: treeProvider,
    input: () => ({
      cut: cutOf('root', 'c1', 'c2', 'g1', 'g2', 'g3'),
      edges: [
        edge('root', 'c1'),
        edge('root', 'c2'),
        edge('c1', 'g1'),
        edge('c1', 'g2'),
        edge('c2', 'g3'),
      ],
      sizes: uniformSizes(['root', 'c1', 'c2', 'g1', 'g2', 'g3'], { width: 70, height: 24 }),
      hints: { direction: 'down', spacing: 20 },
    }),
  },
  {
    name: 'grid — single node',
    provider: gridProvider,
    input: () => ({ cut: cutOf('solo'), edges: [], sizes: sizes({ solo: { width: 30, height: 30 } }), hints: {} }),
  },
];

const hosts: Host[] = [];
async function dispose(): Promise<void> {
  await Promise.all(hosts.splice(0).map((h) => h.dispose()));
}

describe('grid/tree in the worker == main thread (byte-identical geometry)', () => {
  for (const c of cases) {
    it(
      c.name,
      async () => {
        const { factory } = makeNodeFactory();
        const host = new LayoutWorkerHost({ factory });
        hosts.push(host);
        const input = c.input();
        const workerResult = await host.compute(c.provider.id, input);
        expect(workerResult.source).toBe('worker');
        expect(workerResult.degraded).toBe(false);
        const mainResult = await c.provider.compute(input);
        assertLayoutEqual(
          workerResult.layout,
          mainResult,
          input.cut.members.map(String),
        );
        await dispose();
      },
      20_000,
    );
  }

  it(
    'stability score matches the main-thread scorer under a warm-start delta',
    async () => {
      const { factory } = makeNodeFactory();
      const host = new LayoutWorkerHost({ factory });
      hosts.push(host);

      const base: LayoutInput = {
        cut: cutOf('a', 'b', 'c', 'd'),
        edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
        sizes: uniformSizes(['a', 'b', 'c', 'd'], { width: 60, height: 28 }),
        hints: { direction: 'down', spacing: 18 },
      };
      const prev = await treeProvider.compute(base);

      // A small delta: add one node under d.
      const next: LayoutInput = {
        cut: cutOf('a', 'b', 'c', 'd', 'e'),
        edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e')],
        sizes: uniformSizes(['a', 'b', 'c', 'd', 'e'], { width: 60, height: 28 }),
        hints: { direction: 'down', spacing: 18 },
      };

      const main = await treeProvider.compute(next, prev);
      const worker = await host.compute('tree', next, { prev });
      expect(worker.layout.stability).toBe(main.stability);
      assertLayoutEqual(worker.layout, main, next.cut.members.map(String));
      await dispose();
    },
    20_000,
  );
});

/**
 * elk-layered parity (ROADMAP §12 exit; ADR-0017): the real engine, run inside
 * the worker on order-preserving placeholder ids and placeholder group keys,
 * must produce byte-identical geometry to the main thread — including
 * `edgeRoutes` (orthogonal polylines) and the compound nesting. And, critically
 * for 4D, the **stability score with `prev` edges on the wire**: because elk
 * emits `edgeRoutes`, the ADR-0017 prev-induced-edges row goes live, so the
 * worker-side ADR-0016 `Λ` must equal an independent main-side recomputation.
 */
function assertElkEqual(worker: LayoutResult, main: LayoutResult, members: readonly string[]): void {
  expect(worker.stability).toBe(main.stability);
  expect(worker.bounds).toEqual(main.bounds);
  expect(worker.positions.size).toBe(main.positions.size);
  for (const id of members) {
    expect(worker.positions.get(id as never)).toEqual(main.positions.get(id as never));
  }
  // edgeRoutes: same keys, same polylines (the induced identities are the real
  // NodeIds on both sides — the worker re-keys placeholder routes on return).
  const wk = worker.edgeRoutes;
  const mk = main.edgeRoutes;
  expect(wk === undefined).toBe(mk === undefined);
  if (wk !== undefined && mk !== undefined) {
    expect([...wk.keys()].sort()).toEqual([...mk.keys()].sort());
    for (const [k, poly] of mk) expect(wk.get(k)).toEqual(poly);
  }
}

describe('elk-layered in the worker == main thread (byte-identical, incl. routes)', () => {
  const compound: CompoundNesting = {
    groupOf: new Map([
      [n('a'), 'G0'],
      [n('b'), 'G0'],
      [n('c'), 'G1'],
      [n('d'), 'G1'],
    ]),
    parentOf: new Map(),
  };
  const elkCases: { name: string; input: () => LayoutInput }[] = [
    {
      name: 'flat DAG with orthogonal routes',
      input: () => ({
        cut: cutOf('a', 'b', 'c', 'd'),
        edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
        sizes: uniformSizes(['a', 'b', 'c', 'd'], { width: 60, height: 24 }),
        hints: { direction: 'down', spacing: 20 },
      }),
    },
    {
      name: 'compound nesting (groups become elk compound nodes)',
      input: () => ({
        cut: cutOf('a', 'b', 'c', 'd'),
        edges: [edge('a', 'b'), edge('c', 'd'), edge('a', 'c')],
        sizes: uniformSizes(['a', 'b', 'c', 'd'], { width: 50, height: 22 }),
        hints: { spacing: 18 },
        compound,
      }),
    },
  ];

  for (const c of elkCases) {
    it(
      c.name,
      async () => {
        const { factory } = makeNodeFactory();
        const host = new LayoutWorkerHost({ factory });
        hosts.push(host);
        const input = c.input();
        const workerResult = await host.compute(elkLayeredProvider.id, input);
        expect(workerResult.source).toBe('worker');
        expect(workerResult.degraded).toBe(false);
        const main = await elkLayeredProvider.compute(input);
        assertElkEqual(workerResult.layout, main, input.cut.members.map(String));
        await dispose();
      },
      30_000,
    );
  }

  it(
    'stability with prev edges on the wire matches an independent main recompute',
    async () => {
      const { factory } = makeNodeFactory();
      const host = new LayoutWorkerHost({ factory });
      hosts.push(host);

      const base: LayoutInput = {
        cut: cutOf('a', 'b', 'c', 'd', 'e', 'f'),
        edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'e'), edge('d', 'f'), edge('e', 'f')],
        sizes: uniformSizes(['a', 'b', 'c', 'd', 'e', 'f'], { width: 50, height: 24 }),
        hints: { direction: 'down', spacing: 20 },
      };
      // prev is a *real elk result carrying edgeRoutes* — so the ADR-0017
      // prev-induced-edges wire row is exercised (grid/tree would omit it).
      const prev = await elkLayeredProvider.compute(base);
      expect(prev.edgeRoutes).toBeDefined();

      const next: LayoutInput = {
        ...base,
        cut: cutOf('a', 'b', 'c', 'd', 'e', 'f', 'g'),
        edges: [...base.edges, edge('f', 'g')],
        sizes: uniformSizes(['a', 'b', 'c', 'd', 'e', 'f', 'g'], { width: 50, height: 24 }),
      };
      const main = await elkLayeredProvider.compute(next, prev);
      const worker = await host.compute(elkLayeredProvider.id, next, { prev });
      expect(worker.layout.stability).toBe(main.stability);
      assertElkEqual(worker.layout, main, next.cut.members.map(String));
      await dispose();
    },
    30_000,
  );
});
