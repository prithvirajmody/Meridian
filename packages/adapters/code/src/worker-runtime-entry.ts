/** Worker-only parser runtime surface. Import this entry only inside a worker. */
export type { CodeLanguage } from './languages.js';
export { createParseWorker } from './worker/worker-api.js';
export type { WorkerControlChannel } from './worker/protocol.js';
