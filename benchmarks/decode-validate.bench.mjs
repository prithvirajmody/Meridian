/**
 * Phase 0 perf budgets (ROADMAP Phase 0 §12): decode+validate of a synthetic
 * 100k-node space, and stats over it, measured against benchmarks/budgets.json.
 * Exceeding a budget exits 1 — a perf budget is a test (§5.2).
 *
 * Harness note: plain hrtime + median-of-N for now (dependency-free and
 * deterministic to read); adopt tinybench when the suite grows beyond
 * single-scenario budgets.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, stats } from '../packages/graph-core/dist/index.js';

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'),
);

// ---- synthetic space: 200 graphs × 500 nodes = 100k nodes, 80k edges,
// ---- containment forest with fan-out 4 (depth ≈ 5).
function buildDocument() {
  const GRAPHS = 200;
  const NODES = 500;
  const EDGES = 400;
  const graphs = [];
  for (let i = 0; i < GRAPHS; i++) {
    const nodes = [];
    for (let j = 0; j < NODES; j++) {
      nodes.push({
        id: `n${i}-${j}`,
        kind: 'demo:item',
        label: `item ${i}/${j}`,
        provenance: { origin: 'source', uri: `demo://g${i}/n${j}` },
      });
    }
    const edges = [];
    for (let k = 0; k < EDGES; k++) {
      edges.push({
        id: `e${i}-${k}`,
        src: `n${i}-${(k + 4) % NODES}`,
        dst: `n${i}-${(k * 7 + 11) % NODES}`,
        kind: 'core:references',
        provenance: { origin: 'derived' },
      });
    }
    graphs.push({
      id: `g${i}`,
      meta: { label: `graph ${i}`, domain: 'demo', provenance: { origin: 'source' } },
      nodes,
      edges,
    });
  }
  // graph i (i>0) is the detail of node slot (i-1)%4 in graph floor((i-1)/4)
  for (let i = 1; i < GRAPHS; i++) {
    const parent = Math.floor((i - 1) / 4);
    const slot = (i - 1) % 4;
    graphs[parent].nodes[slot].detail = { graph: `g${i}` };
  }
  return {
    formatVersion: 1,
    producer: { name: 'meridian-benchmarks', version: '1' },
    roots: ['g0'],
    graphs,
  };
}

function medianMs(runs, fn) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

console.log('building synthetic 100k-node document …');
const json = JSON.stringify(buildDocument());
console.log(`  ${(json.length / 1e6).toFixed(1)} MB of JSON`);

// Warmup (JIT) — one run of each, unmeasured.
const warm = decode(json);
if (!warm.ok) {
  console.error('benchmark document failed to decode:', warm.errors.slice(0, 5));
  process.exit(1);
}
stats(warm.space);

const results = [];

const decodeMs = medianMs(5, () => {
  const r = decode(json);
  if (!r.ok) throw new Error('decode failed mid-benchmark');
});
results.push(['100k-decode-validate-ms', decodeMs]);

const space = warm.space;
const statsMs = medianMs(10, () => stats(space));
results.push(['100k-stats-ms', statsMs]);

let failed = false;
console.log('\nbudget check (median):');
for (const [name, ms] of results) {
  const budget = budgets[name];
  const ok = ms <= budget;
  if (!ok) failed = true;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${ms.toFixed(1)}ms  (budget ${budget}ms)`,
  );
}
if (failed) {
  console.error('\nperf budget exceeded — budgets are CI contracts (ADR-A12)');
  process.exit(1);
}
