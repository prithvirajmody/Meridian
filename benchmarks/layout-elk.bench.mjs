/**
 * Phase 4D layout budgets (ROADMAP Phase 4 §12; ADR-0016) for the `elk-layered`
 * engine, measured against benchmarks/budgets.json. A perf budget is a test
 * (§5.2); a `*-min` floor gates a *scored* number (ADR-0016 stability).
 *
 *   - `layout-elk-2k-compound-ms`             — a 2k-node compound cut < 1.5s
 *                                               (worker-side = the provider's
 *                                               own compute, which is exactly
 *                                               what runs in the worker).
 *   - `layout-elk-incremental-10-node-delta-ms` — re-layout after a 10-node
 *                                               delta (warm-started from prev)
 *                                               < 100ms.
 *   - `layout-stability-small-delta-min`      — on scripted small-delta (node
 *                                               addition) sequences, the
 *                                               ADR-0016 stability score stays
 *                                               ≥ 0.90. This is the "scored,
 *                                               CI-gated number" 4D must show.
 *
 * elkjs pays a large one-time init on its first `layout()` call, so every
 * measured phase is preceded by a warmup run (unmeasured), exactly as the
 * abstraction-cut benchmark warms the JIT.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { elkLayeredProvider as elk } from '../packages/layout/dist/index.js';

const budgets = JSON.parse(readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'));

const SIZE = { width: 44, height: 22 };
function mkCut(ids) {
  return { level: 0, members: [...ids].sort(), trace: new Map(), coverage: { leaves: 0, coveredLeaves: 0, covers: true } };
}
function e(src, dst) {
  return { src, dst, kind: 'rel:x', weight: 1, multiplicity: 1, samples: [] };
}
function sizesFor(ids) {
  const m = new Map();
  for (const id of ids) m.set(id, SIZE);
  return m;
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const now = () => Number(process.hrtime.bigint()) / 1e6;

// -- warmup (unmeasured): pay elkjs' one-time init cost.
await elk.compute({ cut: mkCut(['a', 'b']), edges: [e('a', 'b')], sizes: sizesFor(['a', 'b']), hints: {} });

const results = [];

// --------------------------------------------------- 2k-node compound cut <1.5s
{
  const GROUPS = 40;
  const PER = 50; // 2000 members
  const ids = [];
  const groupOf = new Map();
  const parentOf = new Map();
  const edges = [];
  for (let g = 0; g < GROUPS; g++) {
    const gk = `G${g}`;
    parentOf.set(gk, 'ROOT'); // all groups nested under one root container
    for (let i = 0; i < PER; i++) {
      const id = `g${g}n${i}`;
      ids.push(id);
      groupOf.set(id, gk);
      if (i > 0) edges.push(e(`g${g}n${i - 1}`, `g${g}n${i}`)); // intra-group chain
    }
    if (g > 0) edges.push(e(`g${g - 1}n0`, `g${g}n0`)); // cross-group edge
  }
  const input = { cut: mkCut(ids), edges, sizes: sizesFor(ids), hints: { spacing: 16 }, compound: { groupOf, parentOf } };
  const samples = [];
  for (let r = 0; r < 3; r++) {
    const t0 = now();
    const out = await elk.compute(input);
    samples.push(now() - t0);
    if (out.positions.size !== ids.length) throw new Error(`2k-compound: expected ${ids.length} positions, got ${out.positions.size}`);
  }
  console.log(`  2k-node compound: ${ids.length} members, ${GROUPS} groups, ${edges.length} edges`);
  results.push(['layout-elk-2k-compound-ms', median(samples)]);
}

// -------------------------------- incremental re-layout after a 10-node delta <100ms
function layeredGraph(count) {
  const ids = [];
  const edges = [];
  for (let i = 0; i < count; i++) {
    ids.push(`x${i}`);
    if (i > 0) edges.push(e(`x${i - 1 >> 1}`, `x${i}`)); // a broad tree
  }
  return { cut: mkCut(ids), edges, sizes: sizesFor(ids), hints: { direction: 'down', spacing: 20 } };
}
{
  const base = layeredGraph(150);
  const prev = await elk.compute(base);
  const next = layeredGraph(160); // +10 nodes at the frontier
  const samples = [];
  for (let r = 0; r < 5; r++) {
    const t0 = now();
    await elk.compute(next, prev);
    samples.push(now() - t0);
  }
  results.push(['layout-elk-incremental-10-node-delta-ms', median(samples)]);
}

// ------------------------- stability floor on scripted small-delta (node-add) sequences
function frontierTree(depth, branch) {
  const nodes = ['r'];
  const edges = [];
  let frontier = ['r'];
  for (let d = 0; d < depth; d++) {
    const nf = [];
    for (const p of frontier) {
      for (let b = 0; b < branch; b++) {
        const id = `${p}.${b}`;
        nodes.push(id);
        edges.push(e(p, id));
        nf.push(id);
      }
    }
    frontier = nf;
  }
  return { nodes, edges, frontier };
}
{
  // Grow a graph one small (≤10-node) delta at a time — new nodes attach at the
  // frontier, exactly the ADR-0016 "10-node delta" regime — and score each step.
  const t = frontierTree(3, 3); // ~40 nodes to start
  let prev = await elk.compute({ cut: mkCut(t.nodes), edges: t.edges, sizes: sizesFor(t.nodes), hints: { direction: 'down', spacing: 20 } });
  const scores = [];
  for (let step = 0; step < 6; step++) {
    // add up to 10 leaves this step, attached to distinct existing frontier nodes
    const added = [];
    for (let k = 0; k < 8; k++) {
      const parent = t.frontier[(step * 8 + k) % t.frontier.length];
      const id = `s${step}.${k}.${parent}`;
      t.nodes.push(id);
      t.edges.push(e(parent, id));
      added.push(id);
    }
    for (const id of added) t.frontier.push(id);
    const out = await elk.compute({ cut: mkCut(t.nodes), edges: t.edges, sizes: sizesFor(t.nodes), hints: { direction: 'down', spacing: 20 } }, prev);
    scores.push(out.stability);
    prev = out;
  }
  const minScore = Math.min(...scores);
  console.log(`  stability scores (8-node deltas): ${scores.map((s) => s.toFixed(3)).join(' ')} — min ${minScore.toFixed(3)}`);
  results.push(['layout-stability-small-delta-min', minScore]);
}

// ------------------------------------------------------------------ budget check
let failed = false;
console.log('\nbudget check:');
for (const [name, value] of results) {
  const budget = budgets[name];
  const isFloor = name.endsWith('-min');
  const ok = isFloor ? value >= budget : value <= budget;
  if (!ok) failed = true;
  const shown = isFloor ? value.toFixed(3) : `${value.toFixed(1)}ms`;
  const rel = isFloor ? `≥ ${budget}` : `≤ ${budget}ms`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${shown}  (budget ${rel})`);
}
if (failed) {
  console.error('\nperf/stability budget violated — budgets are CI contracts (ADR-A12/ADR-0016)');
  process.exit(1);
}
