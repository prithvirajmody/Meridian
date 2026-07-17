import type {
  CancelMessage,
  CancelledMessage,
  CrashInfo,
  WorkerFactory,
  WorkerHandle,
} from '@meridian/adapter-code/worker-host';

interface CodeInitMessage {
  readonly type: 'meridian-code-init';
  readonly controlPort: MessagePort;
}

/** Browser composition for the code parser: grammar/runtime WASM remains in
 * this dedicated worker chunk and never executes on Studio's main thread. */
export function browserCodeWorkerFactory(): WorkerFactory {
  return (): WorkerHandle => {
    const worker = new Worker(new URL('./code-worker-entry.ts', import.meta.url), {
      type: 'module',
      name: 'meridian-code',
    });
    const { port1, port2 } = new MessageChannel();
    port1.start();
    const init: CodeInitMessage = { type: 'meridian-code-init', controlPort: port2 };
    worker.postMessage(init, [port2]);

    const crashListeners = new Set<(info: CrashInfo) => void>();
    worker.addEventListener('error', (event) => {
      for (const listener of crashListeners) listener({ kind: 'error', error: event.error ?? event.message });
    });
    worker.addEventListener('messageerror', (event) => {
      for (const listener of crashListeners) listener({ kind: 'error', error: event.data });
    });

    return {
      rpc: worker,
      control: {
        postMessage: (message: CancelMessage) => port1.postMessage(message),
        onMessage: (listener: (message: CancelledMessage) => void) => {
          port1.addEventListener('message', (event: MessageEvent<CancelledMessage>) => listener(event.data));
        },
        close: () => port1.close(),
      },
      onCrash: (listener) => crashListeners.add(listener),
      terminate: () => worker.terminate(),
    };
  };
}
