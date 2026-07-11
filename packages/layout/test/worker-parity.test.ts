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
  gridProvider,
  LayoutWorkerHost,
  treeProvider,
  type LayoutInput,
  type LayoutProvider,
  type LayoutResult,
  type LayoutWorkerHost as Host,
} from '../src/index.js';
import { cutOf, edge, sizes, uniformSizes } from './helpers.js';
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
