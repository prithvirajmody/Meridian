/** Production mapper backed by the long-lived parse worker (ADR-0017). */
import type { CodeMapper } from './mapper.js';
import type { ParseWorkerHost } from './worker/host.js';

/** Worker-backed mapper: parse, mapping, and grammar loading stay in worker. */
export function createWorkerMapper(host: ParseWorkerHost): CodeMapper {
  return {
    async mapModule(req, opts) {
      const { module } = await host.map(req, opts);
      return module;
    },
    async resolveBody(req, opts) {
      const { body } = await host.resolveBody(req, opts);
      return body;
    },
    async dispose() {
      await host.dispose();
    },
  };
}
