/**
 * Isomorphic main-thread host for ADR-0021 spatial-index builds.
 *
 * The host knows no DOM, Pixi, layout engine, or concrete worker runtime. A
 * browser or Node/test adapter supplies the small endpoint below. Each newer
 * build supersedes the pending request, and request-id + model-revision checks
 * make late worker messages harmless.
 */
import type { PackedQuadtree } from '../quadtree.js';
import {
  isSpatialIndexWorkerResponse,
  spatialIndexRequestTransfer,
  type SpatialIndexBuildRequest,
  type SpatialIndexBuildResponse,
  type SpatialIndexWorkerRequest,
} from './protocol.js';

export interface SpatialIndexWorkerEndpoint {
  postMessage(
    message: SpatialIndexWorkerRequest,
    transfer?: readonly ArrayBuffer[],
  ): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
  terminate(): void | Promise<void>;
}

/** Injectable runtime seam: browser Worker in Studio, a fake/Node adapter in tests. */
export type SpatialIndexWorkerFactory = () => SpatialIndexWorkerEndpoint;

export interface SpatialIndexHostOptions {
  readonly factory: SpatialIndexWorkerFactory;
}

export interface SpatialIndexBuildInput {
  readonly modelRevision: string;
  /**
   * Disposable `[x,y,width,height]` data. Its ArrayBuffer is transferred and
   * therefore detached in a real worker runtime; pass a copy if the renderer
   * still needs the source geometry.
   */
  readonly nodeRects: Float64Array;
  /** Disposable `[x1,y1,x2,y2]` packed edge-segment data. */
  readonly edgeSegments: Float64Array;
}

export interface SpatialIndexBuildOptions {
  readonly signal?: AbortSignal;
}

export interface SpatialIndexSnapshot {
  readonly requestId: number;
  readonly modelRevision: string;
  readonly nodeTree: PackedQuadtree;
  readonly edgeTree: PackedQuadtree;
}

export interface SpatialIndexHostStats {
  readonly dispatched: number;
  readonly completed: number;
  readonly superseded: number;
  readonly aborted: number;
  readonly staleResponses: number;
  readonly failed: number;
}

interface InFlight {
  readonly request: SpatialIndexBuildRequest;
  readonly signal?: AbortSignal;
  readonly resolve: (snapshot: SpatialIndexSnapshot) => void;
  readonly reject: (error: unknown) => void;
  abortListener?: () => void;
}

/** Cross-realm-safe AbortError for supersession and caller cancellation. */
export function spatialIndexAbortError(): Error {
  try {
    return new DOMException('Aborted', 'AbortError');
  } catch {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
  }
}

function buildFailure(message: string): Error {
  return new Error(`renderer: spatial-index worker ${message}`);
}

export class SpatialIndexHost {
  private readonly factory: SpatialIndexWorkerFactory;
  private worker: SpatialIndexWorkerEndpoint | undefined;
  private removeMessageListener: (() => void) | undefined;
  private removeErrorListener: (() => void) | undefined;
  private inFlight: InFlight | undefined;
  private ready: SpatialIndexSnapshot | undefined;
  private requestSequence = 0;
  private disposed = false;
  private readonly counters = {
    dispatched: 0,
    completed: 0,
    superseded: 0,
    aborted: 0,
    staleResponses: 0,
    failed: 0,
  };

  constructor(options: SpatialIndexHostOptions) {
    this.factory = options.factory;
  }

  /**
   * Move one revision's geometry to the worker. A newer call rejects the older
   * pending promise with `AbortError` before it is dispatched.
   */
  build(
    input: SpatialIndexBuildInput,
    options: SpatialIndexBuildOptions = {},
  ): Promise<SpatialIndexSnapshot> {
    if (this.disposed) return Promise.reject(buildFailure('host is disposed'));
    if (typeof input.modelRevision !== 'string') {
      return Promise.reject(new TypeError('renderer: spatial-index modelRevision must be a string'));
    }
    if (!(input.nodeRects instanceof Float64Array)) {
      return Promise.reject(new TypeError('renderer: spatial-index nodeRects must be Float64Array'));
    }
    if (!(input.edgeSegments instanceof Float64Array)) {
      return Promise.reject(
        new TypeError('renderer: spatial-index edgeSegments must be Float64Array'),
      );
    }
    if (options.signal?.aborted) return Promise.reject(spatialIndexAbortError());

    const requestId = ++this.requestSequence;
    if (!Number.isSafeInteger(requestId)) {
      return Promise.reject(buildFailure('request id space exhausted'));
    }
    const request: SpatialIndexBuildRequest = {
      type: 'build',
      requestId,
      modelRevision: input.modelRevision,
      nodeRects: input.nodeRects,
      edgeSegments: input.edgeSegments,
    };

    let transfer: ArrayBuffer[];
    try {
      transfer = spatialIndexRequestTransfer(request);
    } catch (error) {
      return Promise.reject(error);
    }

    this.supersedeCurrent();
    this.counters.dispatched++;

    return new Promise<SpatialIndexSnapshot>((resolve, reject) => {
      const current: InFlight = {
        request,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        resolve,
        reject,
      };
      this.inFlight = current;

      if (options.signal !== undefined) {
        const onAbort = (): void => this.abort(current);
        current.abortListener = onAbort;
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        this.ensureWorker().postMessage(request, transfer);
      } catch (error) {
        this.fail(current, error);
      }
    });
  }

  /** Return an index only when it exactly matches the renderer's model revision. */
  snapshotFor(modelRevision: string): SpatialIndexSnapshot | null {
    return this.ready?.modelRevision === modelRevision ? this.ready : null;
  }

  stats(): SpatialIndexHostStats {
    return { ...this.counters };
  }

  /** Abort pending work and tear down the injected worker. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const current = this.inFlight;
    if (current !== undefined) {
      this.postCancel(current.request.requestId);
      this.clearCurrent(current);
      current.reject(spatialIndexAbortError());
    }
    await this.teardownWorker();
    this.ready = undefined;
  }

  private ensureWorker(): SpatialIndexWorkerEndpoint {
    if (this.worker !== undefined) return this.worker;
    const worker = this.factory();
    this.worker = worker;
    this.removeMessageListener = worker.onMessage((message) => {
      if (this.worker === worker) this.receive(message);
    });
    this.removeErrorListener = worker.onError((error) => {
      if (this.worker === worker) this.workerFailed(error);
    });
    return worker;
  }

  private receive(message: unknown): void {
    if (!isSpatialIndexWorkerResponse(message)) {
      const current = this.inFlight;
      if (current !== undefined) this.fail(current, buildFailure('sent an invalid response'));
      return;
    }

    const current = this.inFlight;
    if (current === undefined || message.requestId !== current.request.requestId) {
      this.counters.staleResponses++;
      return;
    }

    if (message.type === 'cancelled') {
      this.counters.aborted++;
      this.fail(current, spatialIndexAbortError(), false);
      return;
    }
    if (message.modelRevision !== current.request.modelRevision) {
      this.fail(current, buildFailure('returned a mismatched model revision'));
      return;
    }
    if (message.type === 'error') {
      const error = buildFailure(`failed: ${message.message}`);
      if (message.stack !== undefined) error.stack = message.stack;
      this.fail(current, error);
      return;
    }

    this.complete(current, message);
  }

  private complete(current: InFlight, response: SpatialIndexBuildResponse): void {
    if (this.inFlight !== current) return;
    const snapshot: SpatialIndexSnapshot = {
      requestId: response.requestId,
      modelRevision: response.modelRevision,
      nodeTree: response.nodeTree,
      edgeTree: response.edgeTree,
    };
    this.ready = snapshot;
    this.counters.completed++;
    this.clearCurrent(current);
    current.resolve(snapshot);
  }

  private supersedeCurrent(): void {
    const current = this.inFlight;
    if (current === undefined) return;
    this.counters.superseded++;
    this.postCancel(current.request.requestId);
    this.clearCurrent(current);
    current.reject(spatialIndexAbortError());
  }

  private abort(current: InFlight): void {
    if (this.inFlight !== current) return;
    this.counters.aborted++;
    this.postCancel(current.request.requestId);
    this.clearCurrent(current);
    current.reject(spatialIndexAbortError());
  }

  private fail(current: InFlight, error: unknown, count = true): void {
    if (this.inFlight !== current) return;
    if (count) this.counters.failed++;
    this.clearCurrent(current);
    current.reject(error);
  }

  private clearCurrent(current: InFlight): void {
    if (this.inFlight === current) this.inFlight = undefined;
    if (current.abortListener !== undefined && current.signal !== undefined) {
      current.signal.removeEventListener('abort', current.abortListener);
    }
  }

  private postCancel(requestId: number): void {
    try {
      this.worker?.postMessage({ type: 'cancel', requestId });
    } catch {
      /* The request is already rejected locally; cancellation is best-effort. */
    }
  }

  private workerFailed(error: unknown): void {
    const current = this.inFlight;
    if (current !== undefined) this.fail(current, error);
    void this.teardownWorker();
  }

  private async teardownWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.removeMessageListener?.();
    this.removeErrorListener?.();
    this.removeMessageListener = undefined;
    this.removeErrorListener = undefined;
    try {
      await worker?.terminate();
    } catch {
      /* Best-effort teardown; the host no longer retains this endpoint. */
    }
  }
}
