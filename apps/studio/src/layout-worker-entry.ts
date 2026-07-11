import { createLayoutWorker, type WorkerControlChannel } from '@meridian/layout';
import * as Comlink from 'comlink';

interface LayoutInitMessage {
  readonly type: 'meridian-layout-init';
  readonly controlPort: MessagePort;
}

function isInitMessage(value: unknown): value is LayoutInitMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'meridian-layout-init' &&
    (value as { controlPort?: unknown }).controlPort instanceof MessagePort
  );
}

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

const initialize = (event: MessageEvent<unknown>): void => {
  if (!isInitMessage(event.data)) return;
  scope.removeEventListener('message', initialize);
  const port = event.data.controlPort;
  port.start();
  const control: WorkerControlChannel = {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.addEventListener('message', (message: MessageEvent<unknown>) => listener(message.data as never));
    },
  };
  Comlink.expose(createLayoutWorker({ control }), scope);
};

scope.addEventListener('message', initialize);
