/**
 * Phase 11 scale contracts over the real SQLite + hydration composition:
 * 500k nodes durably stored, a 50k-node resident working set, and cold open
 * through the first resolved cut in under three seconds. The synthetic
 * checkpoint is inserted with set-based SQL so fixture construction does not
 * dominate or accidentally become part of the cold-open measurement.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLevelChain, LodResolver } from '../packages/abstraction/dist/index.js';
import { BetterSqlite3Driver, openProjectStore } from '../packages/store-sqlite/dist/node/index.js';
import { initializeSchema } from '../packages/store-sqlite/dist/index.js';
import { perfGateMode, reportOnlyMetricIds } from './lib/perf-gates.mjs';

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'),
);
// Empty unless MERIDIAN_PERF_GATES=report (hosted CI only): see lib/perf-gates.mjs.
const reportOnly = reportOnlyMetricIds(
  perfGateMode(process.env.MERIDIAN_PERF_GATES),
  JSON.parse(readFileSync(fileURLToPath(new URL('./runner.json', import.meta.url)), 'utf8')),
);

const CHILD_GRAPHS = 500;
const CHILD_NODES = 999;
const ROOT_NODES = CHILD_GRAPHS;
const EDGES_PER_CHILD = 250;
const STORED_NODES = ROOT_NODES + CHILD_GRAPHS * CHILD_NODES; // exactly 500k
const HYDRATE_GRAPHS = 50;
const EVICTION_HYDRATE_GRAPHS = 100;
const NAVIGATION_SOAK_ITERATIONS = 200;
const MAX_RESIDENT_ELEMENTS = 100_000;
const PROVENANCE = '{"origin":"derived"}';

const DIGITS = `
WITH digits(d) AS (
  VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
), numbers(n) AS (
  SELECT a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d + 100000*f.d
  FROM digits a, digits b, digits c, digits d, digits e, digits f
)`;

function seedScaleProject(path) {
  const db = new BetterSqlite3Driver(path);
  try {
    initializeSchema(db, { formatVersion: 1, producer: 'meridian-phase11-benchmark' });
    db.transaction(() => {
      db.run(
        'INSERT INTO graphs (id, label, domain, provenance, node_count, edge_count) VALUES (?, ?, ?, ?, ?, ?)',
        ['g-root', 'Scale root', 'benchmark', PROVENANCE, ROOT_NODES, 0],
      );
      db.exec(`${DIGITS}
        INSERT INTO graphs (id, label, domain, provenance, node_count, edge_count)
        SELECT printf('g-%03d', n), printf('Graph %03d', n), 'benchmark', '${PROVENANCE}', ${CHILD_NODES}, ${EDGES_PER_CHILD}
        FROM numbers WHERE n < ${CHILD_GRAPHS};`);
      db.exec(`${DIGITS}
        INSERT INTO nodes (id, graph_id, kind, label, detail_graph, attrs, provenance)
        SELECT printf('root-n-%03d', n), 'g-root', 'bench:section', printf('Section %03d', n), printf('g-%03d', n), NULL, '${PROVENANCE}'
        FROM numbers WHERE n < ${ROOT_NODES};`);
      db.exec(`${DIGITS}
        INSERT INTO nodes (id, graph_id, kind, label, detail_graph, attrs, provenance)
        SELECT
          printf('n-%03d-%03d', CAST(n / ${CHILD_NODES} AS INTEGER), n % ${CHILD_NODES}),
          printf('g-%03d', CAST(n / ${CHILD_NODES} AS INTEGER)),
          'bench:item', printf('Item %d', n), NULL, NULL, '${PROVENANCE}'
        FROM numbers WHERE n < ${CHILD_GRAPHS * CHILD_NODES};`);
      db.exec(`${DIGITS}
        INSERT INTO edges (id, graph_id, src, dst, kind, weight, attrs, provenance)
        SELECT
          printf('e-%03d-%03d', CAST(n / ${EDGES_PER_CHILD} AS INTEGER), n % ${EDGES_PER_CHILD}),
          printf('g-%03d', CAST(n / ${EDGES_PER_CHILD} AS INTEGER)),
          printf('n-%03d-%03d', CAST(n / ${EDGES_PER_CHILD} AS INTEGER), n % ${EDGES_PER_CHILD}),
          printf('n-%03d-%03d', CAST(n / ${EDGES_PER_CHILD} AS INTEGER), ((n % ${EDGES_PER_CHILD}) * 7 + 11) % ${CHILD_NODES}),
          'core:references', NULL, NULL, '${PROVENANCE}'
        FROM numbers WHERE n < ${CHILD_GRAPHS * EDGES_PER_CHILD};`);
    });
    const stored = Number(db.get('SELECT COUNT(*) AS n FROM nodes')?.n ?? 0);
    if (stored !== STORED_NODES) throw new Error(`scale fixture stored ${stored} nodes, expected ${STORED_NODES}`);
  } finally {
    db.close();
  }
}

const directory = mkdtempSync(join(tmpdir(), 'meridian-phase11-bench-'));
const path = join(directory, 'scale.meridian');
const results = [];

try {
  console.log(`seeding ${STORED_NODES.toLocaleString('en-US')} nodes + ${(CHILD_GRAPHS * EDGES_PER_CHILD).toLocaleString('en-US')} edges …`);
  seedScaleProject(path);
  results.push(['store-sqlite-stored-nodes-min', STORED_NODES]);

  const started = process.hrtime.bigint();
  const { project, store, hydration } = await openProjectStore(path, {
    cold: true,
    hydrationPolicy: { maxResidentElements: MAX_RESIDENT_ELEMENTS, lowWaterRatio: 0.8 },
  });
  if (hydration === undefined) throw new Error('cold open did not create a hydration manager');
  const space = store.snapshot();
  const resolver = new LodResolver(space, buildLevelChain(space), {
    thresholds: [0.5],
    hysteresis: 0,
    budget: { maxNodes: 50_000 },
  });
  const cut = resolver.resolve({ zoom: 0, overrides: new Map(), cold: hydration.coldSet() });
  if (!cut.cut.coverage.covers || cut.cut.members.length === 0) {
    throw new Error('cold open did not produce an interactive covering cut');
  }
  const coldOpenMs = Number(process.hrtime.bigint() - started) / 1e6;
  results.push(['cold-open-first-cut-ms', coldOpenMs]);

  for (let graph = 0; graph < HYDRATE_GRAPHS; graph++) {
    await hydration.hydrate(`g-${String(graph).padStart(3, '0')}`);
  }
  let residentNodes = 0;
  for (const graph of store.snapshot().graphs.values()) residentNodes += graph.nodes.size;
  if (hydration.stats().overBudget) throw new Error('50k-node working set degraded under its configured memory ceiling');
  results.push(['hydrated-working-set-nodes-min', residentNodes]);

  const hydratedSpace = store.snapshot();
  const navigation = new LodResolver(hydratedSpace, buildLevelChain(hydratedSpace), {
    thresholds: [0.5],
    hysteresis: 0,
    budget: { maxNodes: 50_500 },
  });
  const navigationSamples = [];
  let firstFineCutMs;
  if (typeof globalThis.gc !== 'function') {
    throw new Error('phase11-scale requires Node --expose-gc for the retained-heap soak contract');
  }
  globalThis.gc();
  const navigationHeapBaseline = process.memoryUsage().heapUsed;
  for (let iteration = 0; iteration < NAVIGATION_SOAK_ITERATIONS; iteration++) {
    const navStarted = process.hrtime.bigint();
    const result = navigation.resolve({
      zoom: iteration % 2,
      overrides: new Map(),
      cold: hydration.coldSet(),
    });
    const navigationMs = Number(process.hrtime.bigint() - navStarted) / 1e6;
    navigationSamples.push(navigationMs);
    if (iteration === 1) firstFineCutMs = navigationMs;
    if (!result.cut.coverage.covers) throw new Error(`navigation soak iteration ${iteration} lost cut coverage`);
  }
  navigationSamples.sort((a, b) => a - b);
  results.push(['hydrated-navigation-first-fine-cut-ms', firstFineCutMs]);
  results.push(['hydrated-navigation-p95-ms', navigationSamples[Math.ceil(navigationSamples.length * 0.95) - 1]]);
  globalThis.gc();
  results.push([
    'hydrated-navigation-soak-heap-growth-bytes',
    Math.max(0, process.memoryUsage().heapUsed - navigationHeapBaseline),
  ]);

  for (let graph = HYDRATE_GRAPHS; graph < EVICTION_HYDRATE_GRAPHS; graph++) {
    await hydration.hydrate(`g-${String(graph).padStart(3, '0')}`);
  }
  const evictionStats = hydration.stats();
  const loadedElementsWithoutEviction = ROOT_NODES + EVICTION_HYDRATE_GRAPHS * (CHILD_NODES + EDGES_PER_CHILD);
  const requiredReclaim = loadedElementsWithoutEviction - MAX_RESIDENT_ELEMENTS;
  const actualReclaim = loadedElementsWithoutEviction - evictionStats.residentElements;
  const reclaimShare = requiredReclaim <= 0 ? 1 : Math.min(1, actualReclaim / requiredReclaim);
  if (evictionStats.evictions === 0 || evictionStats.overBudget) {
    throw new Error(`hydration eviction did not restore its ceiling: ${JSON.stringify(evictionStats)}`);
  }
  results.push(['hydration-eviction-required-reclaim-min-share', reclaimShare]);
  await project.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

let failed = false;
console.log('\nbudget check:');
for (const [name, value] of results) {
  const budget = budgets[name];
  const isFloor = name.includes('-min');
  const ok = isFloor ? value >= budget : value <= budget;
  const reported = !ok && reportOnly.has(name);
  if (!ok && !reported) failed = true;
  const unit = name.endsWith('-ms') ? 'ms' : name.endsWith('-bytes') ? 'bytes' : '';
  const comparator = isFloor ? '≥' : '≤';
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${value.toFixed(name.endsWith('-ms') ? 1 : 0)}${unit}  (budget ${comparator} ${budget}${unit})${reported ? '  [report-only on this runner]' : ''}`);
}
if (failed) {
  console.error('\nperf budget exceeded — budgets are CI contracts (ADR-A12)');
  process.exit(1);
}
