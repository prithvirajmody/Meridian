/** Phase 11 streamed-ingest throughput owner. It exercises the public bounded
 * staging path over 100k semantic nodes; construction is generator-backed so
 * the benchmark does not hide a monolithic delta ahead of the measured path. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGraphSpace } from '../packages/graph-core/dist/index.js';
import { stageDeltaStream } from '../packages/graph-store/dist/index.js';

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'),
);
const NODE_COUNT = 100_000;
const OPS_PER_EMISSION = 512;
const provenance = { origin: 'derived' };

async function* source() {
  yield {
    origin: { actor: 'phase11-stream-benchmark' },
    ops: [{
      t: 'graph:add',
      graph: 'g-stream',
      meta: { label: 'Stream benchmark', domain: 'benchmark', provenance },
    }],
  };
  for (let offset = 0; offset < NODE_COUNT; offset += OPS_PER_EMISSION) {
    const length = Math.min(OPS_PER_EMISSION, NODE_COUNT - offset);
    yield {
      origin: { actor: 'phase11-stream-benchmark' },
      ops: Array.from({ length }, (_, index) => {
        const at = offset + index;
        return {
          t: 'node:add',
          graph: 'g-stream',
          node: {
            id: `n-${String(at).padStart(6, '0')}`,
            kind: 'bench:item',
            label: `Item ${at}`,
            attrs: {},
            provenance,
          },
        };
      }),
    };
  }
}

const started = process.hrtime.bigint();
const staged = await stageDeltaStream(createGraphSpace(), source(), { maxOpsPerBatch: 512 });
const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
if (!staged.ok) throw new Error(`[${staged.failure.code}] ${staged.failure.message}`);
if (staged.stats.peakBufferedOps > 512) throw new Error(`stream retained ${staged.stats.peakBufferedOps} ops`);
const nodesPerSecond = NODE_COUNT / elapsedSeconds;
const id = 'stream-ingest-min-nodes-per-second';
const budget = budgets[id];
const ok = nodesPerSecond >= budget;
console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${nodesPerSecond.toFixed(0)}nodes/s  (budget ≥ ${budget}nodes/s)`);
if (!ok) process.exitCode = 1;
