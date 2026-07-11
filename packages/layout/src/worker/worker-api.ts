/**
 * The worker-side layout object (ADR-0017). Runs **inside the worker**; the
 * browser/Node entry shim wires it to Comlink and a control port. Isomorphic —
 * no `node:*`, no DOM: it reuses the deterministic providers unchanged and
 * speaks only the typed-array wire protocol.
 *
 * Two channels (ADR-0017):
 * - **RPC** (Comlink): `compute(req) → res`; the exposed method the host calls.
 * - **Control** (a dedicated port, *not* the RPC port): carries
 *   `{ type:'cancel', requestId }` host→worker and `{ type:'cancelled',
 *   requestId }` back. Separate on purpose — Comlink serializes RPC, so a
 *   cancel over the RPC port would queue *behind* the in-flight `compute` and
 *   could never preempt it. The control handler runs between the provider's
 *   cooperative await points, flipping a per-request `AbortController`.
 *
 * Cancellation is **cooperative**: `grid`/`tree` (and elk) run to return —
 * their compute is not interruptible — so a stale grid finishes and its result
 * is simply dropped by the host. Providers that check the signal at work-unit
 * boundaries (d3-force, 4E; the 4C measurement provider) abandon promptly.
 */
import * as Comlink from 'comlink';
import { elkLayeredProvider } from '../elk-layered.js';
import { gridProvider } from '../grid.js';
import { treeProvider } from '../tree.js';
import type { LayoutProvider } from '../types.js';
import {
  decodeRequest,
  encodeResponse,
  responseTransfer,
  type WireRequest,
  type WireResponse,
} from './protocol.js';

/** Host→worker control message (over the dedicated control port). */
export interface CancelMessage {
  readonly type: 'cancel';
  readonly requestId: number;
}

/** Worker→host control message: the worker abandoned a request (observability;
 * lets a measurement/storm test confirm the worker went silent). */
export interface CancelledMessage {
  readonly type: 'cancelled';
  readonly requestId: number;
}

/** The worker's view of the dedicated control port (adapted from a raw
 * `MessagePort` by the entry shim). */
export interface WorkerControlChannel {
  postMessage(msg: CancelledMessage): void;
  onMessage(cb: (msg: CancelMessage) => void): void;
}

/** The Comlink-exposed worker surface (ADR-0017 RPC port). */
export interface LayoutWorkerApi {
  compute(req: WireRequest): Promise<WireResponse>;
}

/** Build a portable `AbortError` (`DOMException` where available). */
export function abortError(): Error {
  try {
    return new DOMException('Aborted', 'AbortError');
  } catch {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }
}

/**
 * Construct the worker-side layout object. `providers` defaults to the
 * deterministic `grid`/`tree` registry (the browser shim's default); a test or
 * a richer entry may pass extra providers (e.g. a cooperative measurement
 * provider, or elk/force in 4D/4E). The `control` channel carries preemptive
 * cancels.
 */
export function createLayoutWorker(opts: {
  readonly providers?: ReadonlyMap<string, LayoutProvider>;
  readonly control: WorkerControlChannel;
}): LayoutWorkerApi {
  const providers =
    opts.providers ??
    new Map<string, LayoutProvider>([
      [gridProvider.id, gridProvider],
      [treeProvider.id, treeProvider],
      [elkLayeredProvider.id, elkLayeredProvider],
    ]);
  const active = new Map<number, AbortController>();
  // Cancels can outrun their compute: the control port and the RPC port are
  // independent channels with no cross-channel ordering, so a cancel may arrive
  // *before* `compute(req)` has registered the controller. Remember such
  // request ids so the compute aborts the instant it starts (prevents a zombie
  // sim under a cancellation storm).
  const preCancelled = new Set<number>();
  const PRECANCEL_CAP = 4096;

  opts.control.onMessage((msg) => {
    if (msg.type !== 'cancel') return;
    const controller = active.get(msg.requestId);
    if (controller !== undefined) {
      controller.abort();
    } else {
      if (preCancelled.size >= PRECANCEL_CAP) preCancelled.clear(); // bound memory
      preCancelled.add(msg.requestId);
    }
    opts.control.postMessage({ type: 'cancelled', requestId: msg.requestId });
  });

  return {
    async compute(req: WireRequest): Promise<WireResponse> {
      const provider = providers.get(req.providerId);
      if (provider === undefined) {
        throw new Error(`layout worker: unknown provider "${req.providerId}"`);
      }
      const controller = new AbortController();
      // Honor a cancel that arrived before this compute registered (see above).
      if (preCancelled.delete(req.requestId)) controller.abort();
      active.set(req.requestId, controller);
      try {
        if (controller.signal.aborted) throw abortError();
        const { input, prev } = decodeRequest(req);
        const result = await provider.compute(input, prev, controller.signal);
        // A provider may ignore the signal and finish; honor a late abort so
        // the host uniformly sees an AbortError for cancelled requests.
        if (controller.signal.aborted) throw abortError();
        const res = encodeResponse(req.requestId, result, input);
        return Comlink.transfer(res, responseTransfer(res));
      } finally {
        active.delete(req.requestId);
      }
    },
  };
}
