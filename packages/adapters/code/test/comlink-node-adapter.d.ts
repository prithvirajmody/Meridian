/**
 * Ambient types for Comlink's Node adapter deep import. Comlink ships
 * `node-adapter.d.ts` (not `.d.mts`), so NodeNext resolution of the `.mjs`
 * specifier does not find it; this declares the one function the test worker
 * factory uses.
 */
declare module 'comlink/dist/esm/node-adapter.mjs' {
  import type { Endpoint } from 'comlink';
  export interface NodeEndpoint {
    postMessage(message: unknown, transfer?: readonly unknown[]): void;
    on(type: string, listener: (...args: unknown[]) => void): unknown;
    off(type: string, listener: (...args: unknown[]) => void): unknown;
    start?: () => void;
  }
  export default function nodeEndpoint(nep: NodeEndpoint): Endpoint;
}
