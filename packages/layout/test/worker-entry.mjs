/**
 * Node `worker_threads` entry for the 4C worker-host tests. This is the
 * environment shim ADR-0017 sanctions ("no DOM outside the worker host shim");
 * it lives in `test/` (not `src/`) precisely because it imports
 * `node:worker_threads` — which the core-law `layout` package forbids in `src`.
 *
 * It wires the isomorphic `createLayoutWorker` (from built `dist/`) to Comlink
 * over `parentPort` (RPC) and the transferred control `MessagePort` (cancel),
 * and registers three *test-only* providers used to MEASURE the protocol:
 *   - `slow`  — cooperative: ticks a SharedArrayBuffer counter and checks the
 *     abort signal each work unit, so the host (and the test) can observe that
 *     a cancelled compute actually stops advancing.
 *   - `throw` — throws inside the worker (worker stays alive) → host re-runs
 *     with grid in the worker (degraded).
 *   - `crash` — `process.exit(1)`: kills the worker process → host recovers on
 *     the main thread with grid, then respawns.
 */
/* global setTimeout */
import { parentPort, workerData } from 'node:worker_threads';
import * as Comlink from 'comlink';
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
import { abortError, createLayoutWorker, elkLayeredProvider, gridProvider, treeProvider } from '../dist/index.js';

const controlPort = workerData.controlPort;
controlPort.start?.();
const control = {
  postMessage: (msg) => controlPort.postMessage(msg),
  onMessage: (cb) => controlPort.on('message', cb),
};

const counter = workerData.counterSab ? new Int32Array(workerData.counterSab) : null;
const slowIterations = workerData.slowIterations ?? 1000;
const slowDelayMs = workerData.slowDelayMs ?? 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cooperative provider: interruptible, observable via a shared counter. */
const slowProvider = {
  id: 'slow',
  capabilities: { incremental: false, compound: false, deterministic: false },
  async compute(input, prev, signal) {
    for (let i = 0; i < slowIterations; i++) {
      if (signal?.aborted) throw abortError();
      if (counter) Atomics.add(counter, 0, 1);
      await sleep(slowDelayMs);
    }
    // Finish with a real, deterministic layout so a *completed* slow run is a
    // valid grid result (used by the storm test's surviving request).
    return gridProvider.compute(input, prev, signal);
  },
};

/** Throws in-worker; the worker process survives. */
const throwProvider = {
  id: 'throw',
  capabilities: { incremental: false, compound: false, deterministic: false },
  async compute() {
    throw new Error('throwProvider: intentional in-worker failure');
  },
};

/** Kills the worker process mid-compute (uncaught crash). */
const crashProvider = {
  id: 'crash',
  capabilities: { incremental: false, compound: false, deterministic: false },
  async compute() {
    process.exit(1);
  },
};

const providers = new Map([
  [gridProvider.id, gridProvider],
  [treeProvider.id, treeProvider],
  [elkLayeredProvider.id, elkLayeredProvider],
  [slowProvider.id, slowProvider],
  [throwProvider.id, throwProvider],
  [crashProvider.id, crashProvider],
]);

const api = createLayoutWorker({ providers, control });
Comlink.expose(api, nodeEndpoint(parentPort));
