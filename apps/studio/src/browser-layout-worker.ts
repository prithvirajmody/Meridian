import {
  LayoutWorkerHost,
  type CancelMessage,
  type CancelledMessage,
  type CrashInfo,
  type LayoutInput,
  type LayoutResult,
  type WorkerFactory,
  type WorkerHandle,
} from '@meridian/layout';
import type { StudioLayoutService } from './studio-session.js';

interface LayoutInitMessage {
  readonly type: 'meridian-layout-init';
  readonly controlPort: MessagePort;
}

/** Browser worker adapter for ADR-0017's isomorphic LayoutWorkerHost. */
export function browserLayoutWorkerFactory(): WorkerFactory {
  return (): WorkerHandle => {
    const worker = new Worker(new URL('./layout-worker-entry.ts', import.meta.url), {
      type: 'module',
      name: 'meridian-layout',
    });
    const { port1, port2 } = new MessageChannel();
    port1.start();
    const init: LayoutInitMessage = { type: 'meridian-layout-init', controlPort: port2 };
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

export class BrowserStudioLayoutService implements StudioLayoutService {
  private readonly host = new LayoutWorkerHost({ factory: browserLayoutWorkerFactory() });

  async compute(providerId: string, input: LayoutInput): Promise<LayoutResult> {
    return (await this.host.compute(providerId, input)).layout;
  }

  async dispose(): Promise<void> {
    await this.host.dispose();
  }
}
