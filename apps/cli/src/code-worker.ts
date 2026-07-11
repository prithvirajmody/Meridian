/**
 * The Node `worker_threads` {@link WorkerFactory} for `meridian ingest
 * --adapter code` (ADR-0017). Spawns the compiled code-worker entry, transfers
 * a control `MessagePort`, and adapts both channels to the adapter's abstract
 * {@link WorkerHandle}. Lives in the CLI (a composition root that may use
 * `node:*`) so the isomorphic `@meridian/adapter-code` never imports
 * `worker_threads`.
 */
import { MessageChannel, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
import type { WorkerFactory, WorkerHandle } from '@meridian/adapter-code';

const ENTRY = fileURLToPath(new URL('./code-worker-entry.js', import.meta.url));

/** A factory that spawns the CLI's code parse+map worker (grammars in worker). */
export function codeWorkerFactory(): WorkerFactory {
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
