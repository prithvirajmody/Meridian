/**
 * Node `worker_threads` {@link WorkerFactory} for the parse-worker tests —
 * the environment shim that lives outside `src/` (adapters-no-node-builtins),
 * mirroring layout's 4C `node-factory.ts`: one worker per call, a transferred
 * control `MessagePort`, both channels adapted to the abstract
 * {@link WorkerHandle}.
 */
import { MessageChannel, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
import type { WorkerFactory, WorkerHandle } from '../src/index.js';

const ENTRY = fileURLToPath(new URL('./worker-entry.mjs', import.meta.url));

export interface NodeFactoryOptions {
  /** Artificial delay (ms) before each worker-side parse — lets a test hold a
   * request in flight deterministically (cancel/crash measurement). */
  readonly parseDelayMs?: number;
}

/** Build a {@link WorkerFactory} spawning the test worker entry; records every
 * spawned `Worker` so tests can assert respawns and force crashes. */
export function makeNodeFactory(opts: NodeFactoryOptions = {}): {
  factory: WorkerFactory;
  workers: Worker[];
} {
  const workers: Worker[] = [];
  const factory: WorkerFactory = () => {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(ENTRY, {
      workerData: { controlPort: port2, parseDelayMs: opts.parseDelayMs },
      transferList: [port2],
    });
    worker.unref();
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
