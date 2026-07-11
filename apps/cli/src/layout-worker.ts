/**
 * The Node `worker_threads` {@link WorkerFactory} for `meridian layout
 * --worker` (ADR-0017). Spawns the compiled worker entry, transfers a control
 * `MessagePort`, and adapts both channels to the host's abstract
 * {@link WorkerHandle}. Lives in the CLI (a composition root that may use
 * `node:*`) so the core-law `@meridian/layout` package never imports
 * `worker_threads`.
 */
import { MessageChannel, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
import type { WorkerFactory, WorkerHandle } from '@meridian/layout';

const ENTRY = fileURLToPath(new URL('./layout-worker-entry.js', import.meta.url));

/** A factory that spawns the CLI's layout worker (grid/tree in the worker). */
export function nodeWorkerFactory(): WorkerFactory {
  return (): WorkerHandle => {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(ENTRY, { workerData: { controlPort: port2 }, transferList: [port2] });
    worker.unref();
    return {
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
  };
}
