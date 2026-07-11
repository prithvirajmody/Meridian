/** Browser `Worker` adapter for the isomorphic {@link SpatialIndexHost}. */
import type {
  SpatialIndexWorkerEndpoint,
  SpatialIndexWorkerFactory,
} from './host.js';
import type { SpatialIndexWorkerRequest } from './protocol.js';

interface BrowserMessageEventLike {
  readonly data: unknown;
}

interface BrowserErrorEventLike {
  readonly error?: unknown;
  readonly message?: string;
}

/** Minimal browser Worker shape, exported to make factory wiring testable. */
export interface BrowserSpatialIndexWorker {
  onmessage: ((event: BrowserMessageEventLike) => void) | null;
  onerror: ((event: BrowserErrorEventLike) => unknown) | null;
  onmessageerror: ((event: BrowserMessageEventLike) => unknown) | null;
  postMessage(message: SpatialIndexWorkerRequest, transfer?: readonly ArrayBuffer[]): void;
  terminate(): void;
}

export interface BrowserSpatialIndexWorkerFactoryOptions {
  /** Defaults to the emitted module-worker sibling. */
  readonly workerUrl?: string | URL;
  readonly name?: string;
  /** Injectable constructor seam for browser-adapter tests. */
  readonly createWorker?: (
    url: string | URL,
    options: WorkerOptions,
  ) => BrowserSpatialIndexWorker;
}

function defaultBundledWorker(name: string): BrowserSpatialIndexWorker {
  if (typeof Worker === 'undefined') {
    throw new Error('renderer: browser Worker is unavailable in this runtime');
  }
  // Keep this exact static URL shape: Vite discovers and emits module workers
  // only when it can analyze `new Worker(new URL(..., import.meta.url), ...)`.
  return new Worker(new URL('./browser-worker.js', import.meta.url), {
    type: 'module',
    name,
  }) as unknown as BrowserSpatialIndexWorker;
}

function asError(event: BrowserErrorEventLike, fallback: string): unknown {
  return event.error ?? new Error(event.message ?? fallback);
}

function endpoint(worker: BrowserSpatialIndexWorker): SpatialIndexWorkerEndpoint {
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    onMessage(listener) {
      const handler = (event: BrowserMessageEventLike): void => listener(event.data);
      worker.onmessage = handler;
      return (): void => {
        if (worker.onmessage === handler) worker.onmessage = null;
      };
    },
    onError(listener) {
      const errorHandler = (event: BrowserErrorEventLike): void => {
        listener(asError(event, 'spatial-index worker error'));
      };
      const messageErrorHandler = (): void => {
        listener(new Error('renderer: spatial-index worker message could not be decoded'));
      };
      worker.onerror = errorHandler;
      worker.onmessageerror = messageErrorHandler;
      return (): void => {
        if (worker.onerror === errorHandler) worker.onerror = null;
        if (worker.onmessageerror === messageErrorHandler) worker.onmessageerror = null;
      };
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * Create the Studio/browser factory without constructing a worker yet. The
 * default URL remains correct after TypeScript emits this file into `dist/`.
 */
export function createBrowserSpatialIndexWorkerFactory(
  options: BrowserSpatialIndexWorkerFactoryOptions = {},
): SpatialIndexWorkerFactory {
  const name = options.name ?? 'meridian-spatial-index';
  const workerOptions: WorkerOptions = {
    type: 'module',
    name,
  };
  const createWorker = options.createWorker;
  if (createWorker !== undefined) {
    const url = options.workerUrl ?? new URL('./browser-worker.js', import.meta.url);
    return (): SpatialIndexWorkerEndpoint =>
      endpoint(createWorker(url, workerOptions));
  }
  const workerUrl = options.workerUrl;
  if (workerUrl !== undefined) {
    return (): SpatialIndexWorkerEndpoint => {
      if (typeof Worker === 'undefined') {
        throw new Error('renderer: browser Worker is unavailable in this runtime');
      }
      return endpoint(
        new Worker(workerUrl, workerOptions) as unknown as BrowserSpatialIndexWorker,
      );
    };
  }
  return (): SpatialIndexWorkerEndpoint => endpoint(defaultBundledWorker(name));
}
