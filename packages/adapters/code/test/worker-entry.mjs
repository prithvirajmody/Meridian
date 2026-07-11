/**
 * Node `worker_threads` entry for the parse-worker tests. This is where
 * grammars actually load in production shape — inside the worker (roadmap
 * Phase 7 architecture row) — wired exactly like layout's 4C entry: the
 * isomorphic `createParseWorker` (from built `dist/`) exposed over Comlink on
 * `parentPort`, the transferred control `MessagePort` carrying cancels.
 *
 * `parseDelayMs` (workerData) delays each parse so tests can deterministically
 * hold a request in flight while they cancel or kill the worker.
 */
/* global setTimeout */
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import * as Comlink from 'comlink';
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
import { createParseWorker, GRAMMAR_FILES } from '../dist/index.js';

const controlPort = workerData.controlPort;
controlPort.start?.();
const control = {
  postMessage: (msg) => controlPort.postMessage(msg),
  onMessage: (cb) => controlPort.on('message', cb),
};

const readGrammar = async (language) =>
  new Uint8Array(await readFile(new URL(`../grammars/${GRAMMAR_FILES[language]}`, import.meta.url)));

const api = createParseWorker({ runtime: { readGrammar }, control });

const delayMs = workerData.parseDelayMs ?? 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exposed =
  delayMs > 0
    ? {
        warm: (language) => api.warm(language),
        parse: async (req) => {
          await sleep(delayMs);
          return api.parse(req);
        },
      }
    : api;

Comlink.expose(exposed, nodeEndpoint(parentPort));
