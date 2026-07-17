/** Child for the Phase-11 streamed-ingest crash composition test. */
import { setTimeout as delay } from 'node:timers/promises';
import { stageDeltaStream } from '../../../packages/graph-store/dist/index.js';
import { openProject } from '../../../packages/store-sqlite/dist/node/index.js';

const path = process.argv[2];
const project = await openProject(path, { checkpointEvery: 4 });
if (process.send === undefined) throw new Error('stream crash child requires IPC');

let appendCount = 0;
const backend = {
  loadGraph: (id) => project.backend.loadGraph(id),
  appendOps: async (delta) => {
    appendCount += 1;
    process.send?.({ type: 'append', count: appendCount });
    await project.backend.appendOps(delta);
  },
  persist: (change) => project.backend.persist(change),
  evictHint: (ids) => project.backend.evictHint(ids),
};

async function* deltas() {
  for (let index = project.version.counter; ; index++) {
    yield {
      origin: { actor: 'stream-crash-child' },
      ops: [{
        t: 'graph:add',
        graph: `g-stream-crash-${index}`,
        meta: {
          label: `Stream crash ${index}`,
          domain: 'test',
          provenance: { origin: 'derived' },
        },
      }],
    };
    // Keep ingest alive and allow IPC/SIGKILL to interleave with backend work.
    await delay(0);
  }
}

process.send({ type: 'started' });
const result = await stageDeltaStream(project.space, deltas(), {
  backend,
  initialVersion: project.version,
  maxOpsPerBatch: 1,
  settle: () => project.flush(),
});
// The source is intentionally infinite; reaching here means staging failed.
process.stderr.write(`stream staging stopped unexpectedly: ${JSON.stringify(result)}\n`);
process.exit(3);
