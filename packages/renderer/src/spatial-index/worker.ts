/** Worker-side message dispatcher for ADR-0021's packed spatial-index build. */
import { buildSpatialIndex } from './build.js';
import {
  isSpatialIndexWorkerRequest,
  spatialIndexResponseTransfer,
  type SpatialIndexBuildRequest,
  type SpatialIndexErrorResponse,
  type SpatialIndexWorkerResponse,
} from './protocol.js';

export interface SpatialIndexWorkerScope {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: SpatialIndexWorkerResponse, transfer?: readonly ArrayBuffer[]): void;
}

export type SpatialIndexWorkerPost = (
  message: SpatialIndexWorkerResponse,
  transfer?: readonly ArrayBuffer[],
) => void;

function errorResponse(
  request: SpatialIndexBuildRequest,
  error: unknown,
): SpatialIndexErrorResponse {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    type: 'error',
    requestId: request.requestId,
    modelRevision: request.modelRevision,
    message,
    ...(stack === undefined ? {} : { stack }),
  };
}

/**
 * Create the stateful worker handler. Cancellation is best-effort: a request
 * cancelled before construction starts is skipped; a synchronous tree build
 * already running may finish, and the host still drops its stale response.
 */
export function createSpatialIndexWorkerHandler(
  post: SpatialIndexWorkerPost,
): (message: unknown) => void {
  const preCancelled = new Set<number>();
  let greatestFinishedRequestId = 0;
  const preCancelLimit = 4096;

  return (message: unknown): void => {
    if (!isSpatialIndexWorkerRequest(message)) return;
    if (message.type === 'cancel') {
      if (message.requestId > greatestFinishedRequestId) {
        if (preCancelled.size >= preCancelLimit) preCancelled.clear();
        preCancelled.add(message.requestId);
      }
      post({ type: 'cancelled', requestId: message.requestId });
      return;
    }

    if (preCancelled.delete(message.requestId)) {
      greatestFinishedRequestId = Math.max(greatestFinishedRequestId, message.requestId);
      post({ type: 'cancelled', requestId: message.requestId });
      return;
    }

    try {
      const response = buildSpatialIndex(message);
      greatestFinishedRequestId = Math.max(greatestFinishedRequestId, message.requestId);
      post(response, spatialIndexResponseTransfer(response));
    } catch (error) {
      greatestFinishedRequestId = Math.max(greatestFinishedRequestId, message.requestId);
      post(errorResponse(message, error));
    }
  };
}

/** Attach the dispatcher to a browser-worker-like global scope. */
export function attachSpatialIndexWorker(scope: SpatialIndexWorkerScope): void {
  const handle = createSpatialIndexWorkerHandler((message, transfer) => {
    scope.postMessage(message, transfer);
  });
  scope.onmessage = (event): void => handle(event.data);
}
