/**
 * Phase 6 perf budget (ROADMAP Phase 6 §12; ADR-0023): a transition plan must
 * be computed in **< 20ms on a 5k-node cut diff** — the plan budget is part of
 * the 300ms plan-to-settle, not extra. A perf budget is a test (§5.2).
 *
 * Two scenarios, both on a synthetic ~5k-member cut, median of 7 runs:
 *   A. a genuine adjacent-level cut diff (refinement) — exercises the
 *      RefinementMap derivation (ancestor/descendant walks) + the degrade
 *      decision over a large enter/exit set.
 *   B. a choreographed re-layout (same cut, ~1/5 nodes displaced) — exercises
 *      the full geometry path (characteristicLength, stabilityScore, per-node
 *      move anims) without degrading.
 * The gate is the max of the two.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode } from '../packages/graph-core/dist/index.js';
import { buildCut, buildLevelChain } from '../packages/abstraction/dist/index.js';
import { deriveRefinementMap, planTransition } from '../packages/navigation/dist/index.js';

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'),
);

const SRC = { origin: 'source', uri: 'demo://nav-forest' };

/** A two-level forest: `PARENTS` parents each with `CHILDREN` children. Level 0
 * cut = parents; level 1 cut = children (~PARENTS·CHILDREN members). */
const PARENTS = 72;
const CHILDREN = 70; // 72 + 72·70 = 5112 nodes; level-1 cut = 5040 members.

function buildDocument() {
  const graphs = [];
  const root = { id: 'g-root', meta: { label: 'root', domain: 'demo', provenance: SRC }, nodes: [], edges: [] };
  graphs.push(root);
  for (let p = 0; p < PARENTS; p++) {
    const detail = { id: `g-${p}`, meta: { label: 'd', domain: 'demo', provenance: SRC }, nodes: [], edges: [] };
    graphs.push(detail);
    for (let c = 0; c < CHILDREN; c++) {
      detail.nodes.push({ id: `n-${p}-${c}`, kind: 'demo:item', label: 'c', provenance: SRC });
    }
    root.nodes.push({ id: `p-${p}`, kind: 'demo:group', label: 'p', detail: { graph: detail.id }, provenance: SRC });
  }
  return { formatVersion: 1, producer: { name: 'meridian-benchmarks', version: '1' }, roots: [root.id], graphs };
}

/** A deterministic grid layout over a cut's members. */
function gridLayout(members, jitterFn = () => 0) {
  const positions = new Map();
  const cols = Math.ceil(Math.sqrt(members.length));
  members.forEach((id, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.set(id, { x: col * 20 + jitterFn(i), y: row * 20, width: 10, height: 10 });
  });
  return { positions, bounds: { x: 0, y: 0, width: cols * 20, height: cols * 20 }, stability: 1 };
}

function median(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const decoded = decode(JSON.stringify(buildDocument()));
if (!decoded.ok) {
  console.error('benchmark document failed to decode:', decoded.errors.slice(0, 5));
  process.exit(1);
}
const space = decoded.space;
const chain = buildLevelChain(space);
const cut0 = buildCut(space, chain, 0);
const cut1 = buildCut(space, chain, 1);
console.log(`synthetic forest: ${space.graphs.size} graphs; cut@0 ${cut0.members.length}, cut@1 ${cut1.members.length} members`);

// Layouts.
const layout0 = gridLayout(cut0.members);
const layout1 = gridLayout(cut1.members);
// Scenario B: same cut, displace ~1/5 of the members by 15 world units (> ε·Λ
// with Λ ≈ spacing 20 ⇒ ε·Λ = 10), keeping stability above the floor.
const layout1b = gridLayout(cut1.members, (i) => (i % 5 === 0 ? 15 : 0));
const HINTS = { spacing: 20 };

// Warmup (JIT), unmeasured.
for (let i = 0; i < 3; i++) {
  const ref = deriveRefinementMap(cut0, cut1, space);
  planTransition({ cut: cut0, layout: layout0 }, { cut: cut1, layout: layout1 }, ref);
  const refB = deriveRefinementMap(cut1, cut1, space);
  planTransition({ cut: cut1, layout: layout1, hints: HINTS }, { cut: cut1, layout: layout1b, hints: HINTS }, refB);
}

const N = 7;

const aSamples = [];
for (let i = 0; i < N; i++) {
  const t0 = process.hrtime.bigint();
  const ref = deriveRefinementMap(cut0, cut1, space);
  const plan = planTransition({ cut: cut0, layout: layout0 }, { cut: cut1, layout: layout1 }, ref);
  aSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  if (plan.enter.length + plan.exit.length + plan.move.length === 0 && plan.mode === 'choreographed') {
    throw new Error('scenario A produced no diff');
  }
}

const bSamples = [];
for (let i = 0; i < N; i++) {
  const t0 = process.hrtime.bigint();
  const ref = deriveRefinementMap(cut1, cut1, space);
  const plan = planTransition({ cut: cut1, layout: layout1, hints: HINTS }, { cut: cut1, layout: layout1b, hints: HINTS }, ref);
  bSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  if (plan.mode !== 'choreographed' || plan.move.length === 0) {
    throw new Error(`scenario B expected a choreographed plan with moves, got ${plan.mode} / ${plan.move.length}`);
  }
}

const aMed = median(aSamples);
const bMed = median(bSamples);
const value = Math.max(aMed, bMed);
console.log(`  scenario A (cut diff):        ${aMed.toFixed(2)}ms`);
console.log(`  scenario B (choreographed):   ${bMed.toFixed(2)}ms`);

const name = 'navigation-plan-5k-ms';
const budget = budgets[name];
const ok = value <= budget;
console.log(`\nbudget check:\n  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${value.toFixed(2)}ms  (budget ≤ ${budget}ms)`);
if (!ok) {
  console.error('\nperf budget exceeded — budgets are CI contracts (ADR-A12)');
  process.exit(1);
}
