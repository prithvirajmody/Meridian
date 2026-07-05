/**
 * Phase 1 perf budgets (ROADMAP Phase 1 §12): the store's write path and
 * snapshot economics on a synthetic 100k-node space, measured against
 * benchmarks/budgets.json. Exceeding a budget exits 1 — a perf budget is a
 * test (§5.2). Budgets:
 *   - one 10k-op delta applies in < 50ms
 *   - 1k sequential small transactions on the 100k space in < 2s
 *   - snapshot() is O(1): 100k calls in < 100ms
 *   - a 100-version chain shares ≥ 90% of node objects (ADR-0006)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode } from '../packages/graph-core/dist/index.js';
import { createStore } from '../packages/graph-store/dist/index.js';

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'),
);

// ---- same synthetic shape as decode-validate: 200 graphs × 500 nodes.
const GRAPHS = 200;
const NODES = 500;
const EDGES = 400;

function buildDocument() {
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

const ORIGIN = { actor: 'bench' };

/** 10k node:attr ops spread across all graphs (50 per graph). */
function tenKOpDelta() {
  const ops = [];
  for (let i = 0; i < GRAPHS; i++) {
    for (let j = 0; j < 50; j++) {
      ops.push({ t: 'node:attr', graph: `g${i}`, id: `n${i}-${j}`, key: 'demo:touch', next: j });
    }
  }
  return { origin: ORIGIN, ops };
}

console.log('building synthetic 100k-node space …');
const decoded = decode(JSON.stringify(buildDocument()));
if (!decoded.ok) {
  console.error('benchmark document failed to decode:', decoded.errors.slice(0, 5));
  process.exit(1);
}
const space = decoded.space;

// Warmup (JIT + index build), unmeasured.
{
  const warmStore = createStore(space);
  const r = warmStore.apply(tenKOpDelta());
  if (!r.ok) {
    console.error('warmup delta rejected:', r.errors.slice(0, 3));
    process.exit(1);
  }
}

const results = [];

// -- 10k-op delta (median of 5; a fresh store per run so every run applies
//    against identical state — store creation stays outside the timed span).
{
  const delta = tenKOpDelta();
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const store = createStore(space);
    const t0 = process.hrtime.bigint();
    const r = store.apply(delta);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (!r.ok) throw new Error('10k-op delta rejected mid-benchmark');
  }
  samples.sort((a, b) => a - b);
  results.push(['store-10k-op-delta-ms', samples[Math.floor(samples.length / 2)]]);
}

// -- 1k sequential small transactions (3 ops each) on the 100k space.
{
  const store = createStore(space);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) {
    const g = `g${i % GRAPHS}`;
    const result = store.transact((tx) => {
      tx.addNode(g, {
        id: `bench-n${i}`,
        kind: 'demo:item',
        label: `bench node ${i}`,
        provenance: { origin: 'derived' },
      });
      tx.addEdge(g, {
        id: `bench-e${i}`,
        src: `bench-n${i}`,
        dst: `n${i % GRAPHS}-0`,
        kind: 'core:references',
        provenance: { origin: 'derived' },
      });
      tx.setAttr(g, `bench-n${i}`, 'demo:seq', i);
    }, ORIGIN);
    if (!result.ok) throw new Error(`transaction ${i} rejected: ${JSON.stringify(result.errors)}`);
  }
  results.push(['store-1k-transactions-100k-space-ms', Number(process.hrtime.bigint() - t0) / 1e6]);
  if (store.version().counter !== 1000) throw new Error('expected 1000 commits');

  // -- snapshot() O(1): 100k calls on the same store.
  const t1 = process.hrtime.bigint();
  let keep;
  for (let i = 0; i < 100_000; i++) keep = store.snapshot();
  results.push(['store-100k-snapshots-ms', Number(process.hrtime.bigint() - t1) / 1e6]);
  void keep;
}

// -- structural sharing across a 100-version chain (ADR-0006): one small
//    attr transaction per version, rotating graphs; then count node objects
//    of the first snapshot still referenced by the last.
{
  const store = createStore(space);
  const first = store.snapshot();
  for (let v = 0; v < 100; v++) {
    const r = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:attr', graph: `g${v % GRAPHS}`, id: `n${v % GRAPHS}-${v % NODES}`, key: 'demo:v', next: v }],
    });
    if (!r.ok) throw new Error('chain delta rejected');
  }
  const last = store.snapshot();
  const firstNodes = new Set();
  for (const g of first.graphs.values()) for (const n of g.nodes.values()) firstNodes.add(n);
  let shared = 0;
  let total = 0;
  for (const g of last.graphs.values()) {
    for (const n of g.nodes.values()) {
      total++;
      if (firstNodes.has(n)) shared++;
    }
  }
  results.push(['store-100-version-chain-min-node-share', shared / total]);
}

let failed = false;
console.log('\nbudget check:');
for (const [name, value] of results) {
  const budget = budgets[name];
  const isMin = name.includes('min');
  const ok = isMin ? value >= budget : value <= budget;
  if (!ok) failed = true;
  const rendered = isMin ? `${(value * 100).toFixed(2)}%` : `${value.toFixed(1)}ms`;
  const renderedBudget = isMin ? `≥ ${(budget * 100).toFixed(0)}%` : `≤ ${budget}ms`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${rendered}  (budget ${renderedBudget})`);
}
if (failed) {
  console.error('\nperf budget exceeded — budgets are CI contracts (ADR-A12)');
  process.exit(1);
}
