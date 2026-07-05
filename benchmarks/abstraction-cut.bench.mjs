/**
 * Phase 3 perf budget (ROADMAP Phase 3 §12; ADR-0013 — the induced-edge perf
 * cliff): induced-edge resolution and incremental invalidation on a synthetic
 * ~100k-node / 8-level containment forest, measured against
 * benchmarks/budgets.json. A perf budget is a test (§5.2). Budgets:
 *   - cold resolve (build cover + aggregate the whole cut from scratch) < 150ms
 *   - warm resolve (one-edge ChangeSet invalidation + resolve) < 30ms
 * The warm path recomputes only the edited edge's endpoint members (ADR-0013's
 * exact invalidation), so it must stay far under a from-scratch pass.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode } from '../packages/graph-core/dist/index.js';
import { createStore } from '../packages/graph-store/dist/index.js';
import {
  aggregateEdges,
  buildCut,
  buildLevelChain,
  InducedEdgeCache,
} from '../packages/abstraction/dist/index.js';

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'),
);

const SRC = { origin: 'source', uri: 'demo://forest' };
const TARGET_NODES = 100_000;
const BRANCH = 5;
const MAX_DEPTH = 7; // depths 0..7 ⇒ 8 levels
const CUT_LEVEL = 4;

/** Build a ~100k-node, 8-level forest document. DFS with a global node budget:
 * the leftmost path reaches depth 7 (guaranteeing 8 levels); each graph gets a
 * few intra-graph chain edges so cuts have induced edges to aggregate. */
function buildDocument() {
  const graphs = [];
  let nodeCount = 0;
  let graphCount = 0;

  const newGraph = () => {
    const g = { id: `g${graphCount++}`, meta: { label: 'g', domain: 'demo', provenance: SRC }, nodes: [], edges: [] };
    graphs.push(g);
    return g;
  };

  const build = (graph, depth) => {
    for (let i = 0; i < BRANCH; i++) {
      if (nodeCount >= TARGET_NODES) break;
      const node = { id: `n${nodeCount++}`, kind: 'demo:item', label: 'item', provenance: SRC };
      graph.nodes.push(node);
      if (depth < MAX_DEPTH && nodeCount < TARGET_NODES) {
        const child = newGraph();
        node.detail = { graph: child.id };
        build(child, depth + 1);
      }
    }
    // Chain edges among this graph's siblings (induced when they are members).
    for (let j = 0; j + 1 < graph.nodes.length; j++) {
      graph.edges.push({
        id: `e${graph.id}-${j}`,
        src: graph.nodes[j].id,
        dst: graph.nodes[j + 1].id,
        kind: 'demo:link',
        provenance: { origin: 'derived' },
      });
    }
  };

  const root = newGraph();
  build(root, 0);
  return {
    formatVersion: 1,
    producer: { name: 'meridian-benchmarks', version: '1' },
    roots: [root.id],
    graphs,
  };
}

console.log('building synthetic ~100k-node / 8-level forest …');
const decoded = decode(JSON.stringify(buildDocument()));
if (!decoded.ok) {
  console.error('benchmark document failed to decode:', decoded.errors.slice(0, 5));
  process.exit(1);
}
const space = decoded.space;
let nodeTotal = 0;
let edgeTotal = 0;
for (const g of space.graphs.values()) {
  nodeTotal += g.nodes.size;
  edgeTotal += g.edges.size;
}
const chain = buildLevelChain(space);
const cut = buildCut(space, chain, CUT_LEVEL);
console.log(
  `  ${nodeTotal} nodes, ${edgeTotal} base edges, ${space.graphs.size} graphs; ` +
    `cut@level ${CUT_LEVEL}: ${cut.members.length} members, ${aggregateEdges(space, cut).length} induced edges`,
);

// Warmup (JIT), unmeasured.
{
  const c = new InducedEdgeCache(space, cut);
  void c.resolve();
}

const results = [];

// -- cold resolve: build cover + aggregate the whole cut from scratch (median of 5).
{
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    const cache = new InducedEdgeCache(space, cut);
    const edges = cache.resolve();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (edges.length === 0) throw new Error('cold resolve produced no induced edges');
  }
  samples.sort((a, b) => a - b);
  results.push(['abstraction-cut-cold-ms', samples[Math.floor(samples.length / 2)]]);
}

// -- warm resolve: an already-built cache absorbs a one-edge ChangeSet and
//    re-resolves (median of 5). A fresh store per run keeps state identical.
{
  const samples = [];
  // Two frontier members co-resident in one graph, to add a real cross edge.
  const memberSet = new Set(cut.members);
  let frontierGraph;
  let a;
  let b;
  for (const g of space.graphs.values()) {
    const memberNodes = [...g.nodes.keys()].filter((id) => memberSet.has(id));
    if (memberNodes.length >= 2) {
      frontierGraph = g;
      [a, b] = memberNodes;
      break;
    }
  }
  if (frontierGraph === undefined) throw new Error('no frontier graph found for warm edit');
  for (let i = 0; i < 5; i++) {
    const store = createStore(space);
    const cache = new InducedEdgeCache(space, cut);
    cache.resolve();
    const res = store.apply({
      origin: { actor: 'bench' },
      ops: [{ t: 'edge:add', graph: frontierGraph.id, edge: { id: `warm-${i}`, src: a, dst: b, kind: 'demo:link', attrs: {}, provenance: { origin: 'derived' } } }],
    });
    if (!res.ok) throw new Error('warm edge:add rejected: ' + JSON.stringify(res.errors));
    const t0 = process.hrtime.bigint();
    cache.applyChange(res.changes, store.snapshot());
    const edges = cache.resolve();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    void edges;
    if (cache.recomputedMembers.length > 2) throw new Error('warm edit touched more than 2 members');
  }
  samples.sort((a2, b2) => a2 - b2);
  results.push(['abstraction-cut-warm-ms', samples[Math.floor(samples.length / 2)]]);
}

let failed = false;
console.log('\nbudget check:');
for (const [name, value] of results) {
  const budget = budgets[name];
  const ok = value <= budget;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${value.toFixed(1)}ms  (budget ≤ ${budget}ms)`);
}
if (failed) {
  console.error('\nperf budget exceeded — budgets are CI contracts (ADR-A12)');
  process.exit(1);
}
