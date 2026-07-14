/**
 * The flat "node soup" clustering fixture (Phase 8F, ROADMAP §11: "clusterer
 * turns a 500-node flat soup into labeled groups that pass the eval floor").
 *
 * A soup is `n` nodes drawn from `topics` latent groups. Each node's `text`
 * carries a stable topic token (`[t3]`) plus filler so it reads like a real
 * label; the topic token is what the offline mock embedder keys on to place the
 * node near its topic centroid (see lib/mock-embed.mjs). The ground-truth topic
 * per node is returned separately so the harness can score purity/ARI — the
 * clusterer itself never sees it.
 *
 * Determinism: node order, ids, and text are a pure function of (n, topics,
 * seed). No RNG state leaks between calls. The canonical fixture is
 * `buildSoup({ n: 500, topics: 8 })`; the 5k perf variant reuses this builder.
 */
import { mulberry32, hashSeed } from '../lib/prng.mjs';

const KINDS = ['doc:section', 'code:function', 'code:class', 'conv:message'];
const TOPIC_WORDS = [
  ['auth', 'login', 'token', 'session', 'credential'],
  ['render', 'canvas', 'pixel', 'shader', 'frame'],
  ['graph', 'node', 'edge', 'delta', 'snapshot'],
  ['layout', 'force', 'elk', 'spacing', 'anchor'],
  ['budget', 'cost', 'token', 'ceiling', 'spend'],
  ['cluster', 'embed', 'vector', 'centroid', 'cohesion'],
  ['parser', 'markdown', 'heading', 'fence', 'ast'],
  ['navigate', 'zoom', 'drill', 'breadcrumb', 'camera'],
  ['review', 'gate', 'checklist', 'verify', 'regression'],
  ['plugin', 'adapter', 'manifest', 'capability', 'seam'],
];

/**
 * @param {{ n?: number, topics?: number, seed?: string }} opts
 * @returns {{ nodes: {id,text,kind,label}[], truthById: Map<string,number> }}
 */
export function buildSoup({ n = 500, topics = 8, seed = 'soup' } = {}) {
  const rng = mulberry32(hashSeed(`${seed}:${n}:${topics}`));
  const nodes = [];
  const truthById = new Map();
  for (let i = 0; i < n; i++) {
    const topic = i % topics; // even spread across topics, deterministic
    const words = TOPIC_WORDS[topic % TOPIC_WORDS.length];
    const kind = KINDS[Math.floor(rng() * KINDS.length)];
    const w1 = words[Math.floor(rng() * words.length)];
    const w2 = words[Math.floor(rng() * words.length)];
    const id = `soup:n${String(i).padStart(4, '0')}`;
    const label = `${w1} ${w2} ${i}`;
    // The `[t{topic}]` token is the only separable signal the mock embedder reads.
    const text = `[t${topic}] ${label} — ${w1} handling in the ${w2} subsystem`;
    nodes.push({ id, text, kind, label });
    truthById.set(id, topic);
  }
  return { nodes, truthById };
}
