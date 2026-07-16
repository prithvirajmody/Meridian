/**
 * Crash-test child (SUBPHASES 11B: "kill -9 during write → reopen recovers
 * via op-log replay"). Opens the project at argv[2] and commits graph:add
 * deltas as fast as the write path allows until killed. Each committed
 * graph is numbered; the parent verifies that the reopened project is an
 * exact prefix: graphs g-crash-0..K-1 present ⇔ version counter K.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { openProjectStore } from '../dist/node/index.js';

const path = process.argv[2];
const { store } = await openProjectStore(path, { checkpointEvery: 4 });

process.stdout.write('started\n');

const base = store.version().counter;
for (let i = base; i < 10_000; i++) {
  const result = store.apply({
    origin: { actor: 'crash-child' },
    ops: [
      {
        t: 'graph:add',
        graph: `g-crash-${i}`,
        meta: { label: `Crash ${i}`, domain: 'test', provenance: { origin: 'derived' } },
      },
    ],
  });
  if (!result.ok) {
    process.stderr.write(`apply failed at ${i}\n`);
    process.exit(3);
  }
  // Yield a macrotask so the post-commit backend notifications interleave
  // with commits — the kill lands at an arbitrary point of the protocol.
  await delay(0);
}
