/**
 * `LayoutWorkerHost` behaviour tests (ROADMAP Phase 4 §11–12; ADR-0017), run
 * against a **real Node `worker_threads` worker** so every claim is measured,
 * not assumed:
 *
 *  - cancellation actually stops compute (a shared counter freezes),
 *  - a new request aborts the stale one (measured the same way),
 *  - a cancellation storm leaves exactly one survivor and a healthy worker,
 *  - a worker crash recovers on the main thread with grid, then respawns,
 *  - the crash budget trips a breaker that pins the slot to grid,
 *  - the main thread is never blocked > 4ms (the boundary is O(1)).
 *
 * The Node worker factory + the cooperative/throwing/crashing test providers
 * live in `node-factory.ts` / `worker-entry.mjs` (outside `src/`, since they
 * import `node:worker_threads`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  gridProvider,
  LayoutWorkerHost,
  type LayoutInput,
  type LayoutWorkerHost as Host,
} from '../src/index.js';
import { cutOf, uniformSizes } from './helpers.js';
import { makeNodeFactory } from './node-factory.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tinyInput(): LayoutInput {
  return {
    cut: cutOf('a', 'b', 'c'),
    edges: [],
    sizes: uniformSizes(['a', 'b', 'c'], { width: 60, height: 28 }),
    hints: {},
  };
}

function bigInput(n: number): LayoutInput {
  const ids = Array.from({ length: n }, (_, i) => `node-${String(i).padStart(6, '0')}`);
  return {
    cut: cutOf(...ids),
    edges: [],
    sizes: uniformSizes(ids, { width: 40, height: 20 }),
    hints: {},
  };
}

/** Poll until `read()` reaches `target` or `budgetMs` elapses; returns value. */
async function waitUntil(read: () => number, target: number, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let v = read();
  while (v < target && Date.now() < deadline) {
    await sleep(2);
    v = read();
  }
  return v;
}

const hosts: Host[] = [];
function track(host: Host): Host {
  hosts.push(host);
  return host;
}
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.dispose()));
});

describe('cancellation actually stops compute (measured)', () => {
  it(
    'an aborted compute rejects AbortError and the worker stops advancing',
    async () => {
      const counterSab = new SharedArrayBuffer(4);
      const counter = new Int32Array(counterSab);
      const { factory } = makeNodeFactory({ counterSab, slowIterations: 100_000, slowDelayMs: 1 });
      const host = track(new LayoutWorkerHost({ factory }));

      // Warm the worker so the measurement reflects steady state, not startup.
      await host.compute('grid', tinyInput());
      Atomics.store(counter, 0, 0);

      const ac = new AbortController();
      const p = host.compute('slow', tinyInput(), { signal: ac.signal });
      const ticksBefore = await waitUntil(() => Atomics.load(counter, 0), 20, 2000);
      expect(ticksBefore).toBeGreaterThanOrEqual(20); // genuinely running

      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });

      const atAbort = Atomics.load(counter, 0);
      await sleep(200); // if it did NOT stop, it would tick ~200 more times
      const afterAbort = Atomics.load(counter, 0);
      console.log(`cancel: ticks@abort=${atAbort}, ticks+200ms=${afterAbort}, delta=${afterAbort - atAbort}`);
      expect(afterAbort - atAbort).toBeLessThanOrEqual(2); // compute stopped
    },
    20_000,
  );

  it(
    'a new request aborts the stale one (measured)',
    async () => {
      const counterSab = new SharedArrayBuffer(4);
      const counter = new Int32Array(counterSab);
      const { factory } = makeNodeFactory({ counterSab, slowIterations: 100_000, slowDelayMs: 1 });
      const host = track(new LayoutWorkerHost({ factory }));
      await host.compute('grid', tinyInput());
      Atomics.store(counter, 0, 0);

      const stale = host.compute('slow', tinyInput());
      await waitUntil(() => Atomics.load(counter, 0), 15, 2000);
      const fresh = host.compute('grid', tinyInput()); // supersedes the stale slow

      await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
      const freshResult = await fresh;
      expect(freshResult.source).toBe('worker');

      const atSupersede = Atomics.load(counter, 0);
      await sleep(200);
      const after = Atomics.load(counter, 0);
      console.log(`supersede: ticks@supersede=${atSupersede}, +200ms=${after}, delta=${after - atSupersede}`);
      expect(after - atSupersede).toBeLessThanOrEqual(2);
      expect(host.stats().cancelled).toBeGreaterThanOrEqual(1);
    },
    20_000,
  );
});

describe('cancellation storm', () => {
  it(
    'a burst of superseding requests leaves one survivor and a healthy worker',
    async () => {
      const counterSab = new SharedArrayBuffer(4);
      const counter = new Int32Array(counterSab);
      const { factory } = makeNodeFactory({ counterSab, slowIterations: 100_000, slowDelayMs: 1 });
      const host = track(new LayoutWorkerHost({ factory }));
      await host.compute('grid', tinyInput());

      const STORM = 40;
      const slow = [];
      for (let i = 0; i < STORM; i++) slow.push(host.compute('slow', tinyInput()));
      const winner = host.compute('grid', tinyInput()); // final request wins

      const settled = await Promise.allSettled(slow);
      const rejected = settled.filter(
        (r) => r.status === 'rejected' && (r.reason as Error)?.name === 'AbortError',
      ).length;
      expect(rejected).toBe(STORM); // every superseded slow request aborts
      const won = await winner;
      expect(won.source).toBe('worker');

      // No zombie sim: the counter is frozen after the storm settles.
      await sleep(50);
      const frozen = Atomics.load(counter, 0);
      await sleep(150);
      expect(Atomics.load(counter, 0) - frozen).toBeLessThanOrEqual(2);

      // Worker survived the storm; a fresh request still runs in it.
      expect(host.stats().crashes).toBe(0);
      const after = await host.compute('grid', tinyInput());
      expect(after.source).toBe('worker');
      console.log(`storm: ${STORM} superseded → ${rejected} AbortError, 1 survivor, crashes=${host.stats().crashes}`);
    },
    20_000,
  );
});

describe('worker crash → host recovers (fallback to grid)', () => {
  it(
    'a provider that kills the worker recovers on the main thread, then respawns',
    async () => {
      const { factory } = makeNodeFactory();
      const host = track(new LayoutWorkerHost({ factory }));
      await host.compute('grid', tinyInput()); // spawn + warm

      const crashed = await host.compute('crash', tinyInput());
      expect(crashed.degraded).toBe(true);
      expect(crashed.provider).toBe('grid');
      expect(crashed.source).toBe('main-fallback');

      // The recovered layout is a correct grid layout.
      const truth = await gridProvider.compute(tinyInput());
      for (const id of tinyInput().cut.members) {
        expect(crashed.layout.positions.get(id)).toEqual(truth.positions.get(id));
      }

      const s = host.stats();
      expect(s.crashes).toBeGreaterThanOrEqual(1);
      expect(s.respawns).toBeGreaterThanOrEqual(1);
      expect(s.mainFallbacks).toBeGreaterThanOrEqual(1);

      // After respawn, normal requests run in the worker again.
      const recovered = await host.compute('grid', tinyInput());
      expect(recovered.source).toBe('worker');
      console.log(`crash: recovered via ${crashed.source} (grid), respawns=${s.respawns}, then back to worker`);
    },
    20_000,
  );

  it(
    'a provider that throws in-worker falls back to grid without killing the worker',
    async () => {
      const { factory } = makeNodeFactory();
      const host = track(new LayoutWorkerHost({ factory }));
      const thrown = await host.compute('throw', tinyInput());
      expect(thrown.degraded).toBe(true);
      expect(thrown.provider).toBe('grid');
      expect(thrown.requested).toBe('throw');
      expect(thrown.source).toBe('worker-fallback');
      expect(host.stats().crashes).toBe(0); // worker survived
      expect(host.stats().providerThrows).toBe(1);
    },
    20_000,
  );

  it(
    'repeated crashes trip the circuit breaker and pin the slot to grid',
    async () => {
      const clock = 0;
      const { factory } = makeNodeFactory();
      const host = track(
        new LayoutWorkerHost({ factory, crashBudget: { maxCrashes: 3, windowMs: 60_000 }, now: () => clock }),
      );
      for (let i = 0; i < 3; i++) {
        const r = await host.compute('crash', tinyInput());
        expect(r.degraded).toBe(true);
      }
      expect(host.stats().breakerTripped).toBe(true);
      // Pinned: further requests skip the (absent) worker and grid on main.
      const pinned = await host.compute('grid', tinyInput());
      expect(pinned.source).toBe('main-fallback');
    },
    20_000,
  );
});

describe('main thread never blocked > 4ms (asserted via the worker boundary)', () => {
  it(
    'the per-request boundary work stays < 4ms while O(N) geometry runs in the worker',
    async () => {
      const N = 20_000;
      const input = bigInput(N);

      // For contrast: computing this layout on the MAIN thread costs tens of ms
      // — exactly the blocking the worker boundary removes. (Also warms the JIT
      // so the measured host reflects steady state, not first-call compilation.)
      const tMain0 = performance.now();
      await gridProvider.compute(input);
      const mainThreadMs = performance.now() - tMain0;

      // Warm a throwaway host so Comlink's argument-serialization paths are
      // JIT-warm before we measure the boundary on a fresh host.
      const warm = track(new LayoutWorkerHost({ factory: makeNodeFactory().factory }));
      await warm.compute('grid', input);

      // Measure the host's existing dispatch/response spans with current-thread
      // CPU time. A lone wall-clock sample can include an OS deschedule, which
      // is not main-thread work and is covered by the cadence test below.
      const threadClock = (): number => {
        const cpu = process.threadCpuUsage();
        return (cpu.user + cpu.system) / 1_000;
      };
      const host = track(new LayoutWorkerHost({ factory: makeNodeFactory().factory }));
      const now = vi.spyOn(performance, 'now').mockImplementation(threadClock);
      const result = await host.compute('grid', input).finally(() => now.mockRestore());
      expect(result.layout.positions.size).toBe(N);
      expect(result.layout.positions.get(input.cut.members[N - 1]!)).toBeDefined(); // O(1) lazy get

      const s = host.stats();
      console.log(
        `4ms boundary (N=${N}): maxDispatchCpu=${s.maxDispatchMs.toFixed(3)}ms, ` +
          `maxHandle=${s.maxHandleMs.toFixed(3)}ms; main-thread grid would block ${mainThreadMs.toFixed(1)}ms`,
      );
      // Encoding (O(N), light) on dispatch and lazy O(1) re-hydration on
      // response are all the main thread does — both well under 4ms.
      expect(s.maxDispatchMs).toBeLessThan(4);
      expect(s.maxHandleMs).toBeLessThan(4);
      // The worker genuinely offloaded the O(N) geometry (tens of ms).
      expect(mainThreadMs).toBeGreaterThan(4 * s.maxHandleMs + 4 * s.maxDispatchMs);
    },
    30_000,
  );

  it(
    'the main thread stays responsive (no > 4ms gap) while a big layout computes in the worker',
    async () => {
      const input = bigInput(20_000);
      const { factory } = makeNodeFactory();
      const host = track(new LayoutWorkerHost({ factory }));
      await host.compute('grid', tinyInput()); // spawn + warm

      // Dispatch (synchronous encode already done here), then sample the
      // event-loop cadence WHILE the worker computes the 20k-node geometry.
      const pending = host.compute('grid', input);
      let last = performance.now();
      let maxGap = 0;
      let samples = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          await sleep(0);
          const now = performance.now();
          const gap = now - last;
          if (gap > maxGap) maxGap = gap;
          last = now;
          samples++;
        }
      })();
      await pending;
      sampling = false;
      await sampler;
      console.log(`liveness: ${samples} main-thread samples during worker compute, maxGap=${maxGap.toFixed(3)}ms`);
      expect(samples).toBeGreaterThan(3); // the compute really did span the loop
      expect(maxGap).toBeLessThan(4);
    },
    30_000,
  );
});
