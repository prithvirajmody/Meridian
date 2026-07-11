/**
 * Ambient types for Comlink's Node adapter deep import (`.mjs` specifier;
 * Comlink ships only `node-adapter.d.ts`, which NodeNext resolution of the
 * `.mjs` path does not pick up). Declares the one function the CLI worker
 * factory + entry use.
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
