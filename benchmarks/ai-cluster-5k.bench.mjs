/**
 * Phase 8 perf budget (ROADMAP Phase 8 §12): embedding + clustering of 5k nodes.
 * The roadmap's live-nightly target is "< 10s" end-to-end (which includes the
 * network embedding round-trip). This benchmark measures the *deterministic
 * offline* half — the embed-pipeline plumbing plus the pure k-means clustering
 * compute over 5,000 nodes — with a mock embedder so it runs in CI with zero
 * network. That compute is the part that must scale; the network term is
 * measured on the live/nightly path, not here. Measured against
 * benchmarks/budgets.json; exceeding a budget exits 1 (§5.2).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AiSession, MockProvider } from '../packages/ai/dist/index.js';
import { clusterNodes } from '../packages/ai-services/dist/cluster.js';

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'),
);

const N = 5000;
const TOPICS = 50;
const DIM = 16;

// ---- deterministic soup + separable mock embedder (no RNG time/Math.random) --
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function buildNodes() {
  const nodes = [];
  for (let i = 0; i < N; i++) {
    const topic = i % TOPICS;
    nodes.push({ id: `n${String(i).padStart(5, '0')}`, text: `[t${topic}] node ${i} in subsystem ${topic}`, kind: 'core:node' });
  }
  return nodes;
}
function embedText(text) {
  const vec = new Array(DIM).fill(0);
  const m = /\[t(\d+)\]/.exec(text);
  const topic = m ? Number(m[1]) % DIM : 0;
  vec[topic] = 1;
  const rng = mulberry32(fnv(text));
  for (let d = 0; d < DIM; d++) vec[d] += (rng() - 0.5) * 0.1;
  return vec;
}

const provider = new MockProvider({
  id: 'mock-embed',
  capabilities: { completion: false, embedding: true, models: { 'embed-1': { inputPerMTok: 0.02, outputPerMTok: 0 } } },
  onEmbed: (req) => req.input.map((t) => embedText(t)),
});
const makeSession = () =>
  new AiSession({ config: { mode: 'off', routes: { embedding: { providerId: 'mock-embed', model: 'embed-1' } } }, providers: [provider] });

const nodes = buildNodes();
console.log(`clustering ${N} nodes into k=${TOPICS} …`);

// Warmup on a small slice (JIT), unmeasured.
await clusterNodes(makeSession(), nodes.slice(0, 200), { k: 8 });

const samples = [];
for (let r = 0; r < 3; r++) {
  const t0 = process.hrtime.bigint();
  const out = await clusterNodes(makeSession(), nodes, { k: TOPICS });
  samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  if (out.clusters.length === 0) throw new Error('clustering produced no clusters');
}
samples.sort((a, b) => a - b);
const results = [['ai-cluster-5k-compute-ms', samples[Math.floor(samples.length / 2)]]];

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
