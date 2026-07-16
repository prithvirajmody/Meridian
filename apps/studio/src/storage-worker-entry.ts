/**
 * Dedicated-worker entry for the browser persistence backend (ADR-0038,
 * 11D). Vite bundles this module (and the sqlite WASM it pulls in) into its
 * own worker chunk; the main bundle never sees the binding.
 */
import { exposeStorageWorker } from '@meridian/store-sqlite/browser-worker';

exposeStorageWorker();
