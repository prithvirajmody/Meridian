/**
 * Phase 4E layout budgets (ROADMAP Phase 4 §12; ADR-0016/0018) for the
 * `d3-force` engine, measured against benchmarks/budgets.json. A perf budget is
 * a test (§5.2); a `*-min` floor gates a *scored* number (ADR-0016 stability).
 *
 *   - `layout-force-10k-convergence-ms`   — 10k nodes to convergence < 3s
 *                                           (ROADMAP §12 Performance row). This
 *                                           is the provider's own compute, which
 *                                           is exactly what runs in the worker.
 *   - `layout-stability-small-delta-min`  — on scripted small-delta (node-add)
 *                                           sequences, warm-started from the
 *                                           previous result, the ADR-0016
 *                                           stability score stays ≥ 0.90 (the
 *                                           same floor elk is gated on; force
 *                                           achieves it by holding persistent
 *                                           nodes through the warm relaxation).
 *
 * Determinism (I6) is a *unit* test (`packages/layout/test/d3-force.test.ts`);
 * here we measure only wall time and the stability score.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d3ForceProvider as force } from '../packages/layout/dist/index.js';

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

// -- warmup (unmeasured): pay JIT + module init once.
await force.compute({ cut: mkCut(['a', 'b']), edges: [e('a', 'b')], sizes: sizesFor(['a', 'b']), hints: {} });

const results = [];

// --------------------------------------------------- 10k nodes to convergence <3s
{
  const N = 10000;
  const ids = [];
  for (let i = 0; i < N; i++) ids.push('n' + String(i).padStart(5, '0'));
  // A cluster-ish graph: a spanning tree (connectivity) + extra intra-locality
  // edges, the shape d3-force is chosen for (ADR-0018 rules 5/6).
  const edges = [];
  for (let i = 1; i < N; i++) {
    edges.push(e(ids[i], ids[(i * 7) % i]));
    if (i % 3 === 0) edges.push(e(ids[i], ids[(i * 13) % i]));
  }
  const input = { cut: mkCut(ids), edges, sizes: sizesFor(ids), hints: { spacing: 20 } };
  const samples = [];
  for (let r = 0; r < 3; r++) {
    const t0 = now();
    const out = await force.compute(input);
    samples.push(now() - t0);
    if (out.positions.size !== N) throw new Error(`10k-force: expected ${N} positions, got ${out.positions.size}`);
    for (const rect of out.positions.values()) {
      if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) throw new Error('10k-force: non-finite position');
    }
  }
  console.log(`  10k-node force: ${N} members, ${edges.length} edges`);
  results.push(['layout-force-10k-convergence-ms', median(samples)]);
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
  // frontier, exactly the ADR-0016 "10-node delta" regime — warm-started from
  // the previous result, and score each step.
  const t = frontierTree(3, 3); // ~40 nodes to start
  const hints = { direction: 'down', spacing: 20 };
  let prev = await force.compute({ cut: mkCut(t.nodes), edges: t.edges, sizes: sizesFor(t.nodes), hints });
  const scores = [];
  for (let step = 0; step < 6; step++) {
    const added = [];
    for (let k = 0; k < 8; k++) {
      const parent = t.frontier[(step * 8 + k) % t.frontier.length];
      const id = `s${step}.${k}.${parent}`;
      t.nodes.push(id);
      t.edges.push(e(parent, id));
      added.push(id);
    }
    for (const id of added) t.frontier.push(id);
    const out = await force.compute({ cut: mkCut(t.nodes), edges: t.edges, sizes: sizesFor(t.nodes), hints }, prev);
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
