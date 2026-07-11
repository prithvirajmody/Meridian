/**
 * The Node `worker_threads` entry for `meridian layout --worker` (ADR-0017's
 * "worker host shim" — the one place `node:worker_threads` is allowed). It
 * wires the isomorphic `createLayoutWorker` (grid/tree only, production) to
 * Comlink over `parentPort` (RPC) and the transferred control `MessagePort`
 * (cancel). The CLI process spawns this file; the geometry runs here, off the
 * CLI's main thread — the same substrate P5 picking and P7 parsing will reuse.
 */
import { parentPort, workerData } from 'node:worker_threads';
import * as Comlink from 'comlink';
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
import { createLayoutWorker, type WorkerControlChannel } from '@meridian/layout';

interface RawPort {
  postMessage(msg: unknown): void;
  on(type: 'message', cb: (msg: unknown) => void): void;
  start?: () => void;
}

const controlPort = workerData.controlPort as RawPort;
controlPort.start?.();

const control: WorkerControlChannel = {
  postMessage: (msg) => controlPort.postMessage(msg),
  onMessage: (cb) => controlPort.on('message', (msg) => cb(msg as never)),
};

const api = createLayoutWorker({ control });
Comlink.expose(api, nodeEndpoint(parentPort!));
