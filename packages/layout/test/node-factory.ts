/**
 * A Node `worker_threads` {@link WorkerFactory} for the 4C host tests — the
 * environment shim that lives outside `src/` so the core-law package never
 * imports `node:worker_threads`. It creates one worker per call (startup +
 * respawn), a transferred control `MessagePort`, and adapts both channels to
 * the host's abstract {@link WorkerHandle}. Optional `counterSab`/slow params
 * flow to the worker's cooperative `slow` provider for cancellation MEASUREMENT.
 */
import { MessageChannel, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
import type { WorkerFactory, WorkerHandle } from '../src/index.js';

const ENTRY = fileURLToPath(new URL('./worker-entry.mjs', import.meta.url));

export interface NodeFactoryOptions {
  /** Shared counter the `slow` provider ticks each work unit (observability). */
  readonly counterSab?: SharedArrayBuffer;
  /** How many work units the `slow` provider runs before completing. */
  readonly slowIterations?: number;
  /** Per-work-unit delay (ms) of the `slow` provider. */
  readonly slowDelayMs?: number;
}

/** Build a {@link WorkerFactory} that spawns the test worker entry. Also
 * records every spawned `Worker` so a test can assert respawns / clean up. */
export function makeNodeFactory(opts: NodeFactoryOptions = {}): {
  factory: WorkerFactory;
  workers: Worker[];
} {
  const workers: Worker[] = [];
  const factory: WorkerFactory = () => {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(ENTRY, {
      workerData: {
        controlPort: port2,
        counterSab: opts.counterSab,
        slowIterations: opts.slowIterations,
        slowDelayMs: opts.slowDelayMs,
      },
      transferList: [port2],
    });
    worker.unref(); // never keep the test process alive on our account
    workers.push(worker);
    const handle: WorkerHandle = {
      rpc: nodeEndpoint(worker),
      control: {
        postMessage: (msg) => port1.postMessage(msg),
        onMessage: (cb) => port1.on('message', cb),
        close: () => port1.close(),
      },
      onCrash: (cb) => {
        worker.on('error', (error) => cb({ kind: 'error', error }));
        worker.on('exit', (code) => {
          if (code !== 0) cb({ kind: 'exit', code });
        });
        worker.on('messageerror', (error) => cb({ kind: 'error', error }));
      },
      terminate: () => worker.terminate().then(() => undefined),
    };
    return handle;
  };
  return { factory, workers };
}
