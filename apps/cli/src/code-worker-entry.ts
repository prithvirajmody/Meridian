/**
 * The Node `worker_threads` entry for `meridian ingest --adapter code`. This is
 * where code grammars actually load — **inside the worker** (ROADMAP Phase 7
 * architecture row) — wired exactly like the layout entry (ADR-0017): the
 * isomorphic `createParseWorker` exposed over Comlink on `parentPort`, the
 * transferred control `MessagePort` carrying cancels. The parse+map walk runs
 * here; only the graph-shaped `RawModule` crosses back. The CLI process spawns
 * this file, so grammar WASM never touches the CLI's main thread.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import * as Comlink from 'comlink';
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';
import {
  createParseWorker,
  GRAMMAR_FILES,
  type CodeLanguage,
  type WorkerControlChannel,
} from '@meridian/adapter-code';

interface RawPort {
  postMessage(msg: unknown): void;
  on(type: 'message', cb: (msg: unknown) => void): void;
  start?: () => void;
}

// Vendored grammars live under the adapter package's `grammars/` dir; resolve
// them from the installed package, not a build-relative guess.
const require = createRequire(import.meta.url);
const grammarsDir = resolve(dirname(require.resolve('@meridian/adapter-code')), '..', 'grammars');

const controlPort = workerData.controlPort as RawPort;
controlPort.start?.();

const control: WorkerControlChannel = {
  postMessage: (msg) => controlPort.postMessage(msg),
  onMessage: (cb) => controlPort.on('message', (msg) => cb(msg as never)),
};

const readGrammar = async (language: CodeLanguage): Promise<Uint8Array> =>
  new Uint8Array(await readFile(resolve(grammarsDir, GRAMMAR_FILES[language])));

const api = createParseWorker({ runtime: { readGrammar }, control });
Comlink.expose(api, nodeEndpoint(parentPort!));
