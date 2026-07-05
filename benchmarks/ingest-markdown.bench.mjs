/**
 * Phase 2 perf budget (ROADMAP Phase 2 §12): ingest a synthetic 5MB
 * CommonMark book — host arbitration → adapter skeleton pass → IR gate —
 * measured against benchmarks/budgets.json. Exceeding a budget exits 1.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { markdownPlugin } from '../packages/adapters/markdown/dist/index.js';
import {
  decode,
  deriveEdgeId,
  deriveGraphId,
  deriveNodeId,
} from '../packages/graph-core/dist/index.js';
import { createPluginHost } from '../packages/plugin-host/dist/index.js';

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'),
);

// ---- synthetic book: deterministic chapters/sections with paragraphs,
// ---- lists, code fences, and internal cross-links, grown to ≥ 5 MB.
function buildBook() {
  const parts = ['# The Synthetic Book\n\nA deterministic 5MB corpus.\n'];
  let bytes = parts[0].length;
  const TARGET = 5 * 1024 * 1024;
  let chapter = 0;
  while (bytes < TARGET) {
    chapter += 1;
    const c = [`\n# Chapter ${chapter}\n`];
    for (let s = 1; s <= 8; s++) {
      c.push(`\n## Section ${chapter}.${s}\n`);
      for (let p = 0; p < 4; p++) {
        c.push(
          `\nParagraph ${p} of section ${chapter}.${s}: the quick brown graph jumps over ` +
            `the lazy renderer, with a link to [chapter ${Math.max(1, chapter - 1)}](#chapter-${Math.max(1, chapter - 1)}) ` +
            `and enough prose to look like a real book paragraph rather than filler.\n`,
        );
      }
      c.push('\n- alpha item\n- beta item\n- gamma item\n');
      c.push('\n```js\nconst x = ' + chapter + ';\nconsole.log(x);\n```\n');
    }
    const text = c.join('');
    parts.push(text);
    bytes += text.length;
  }
  return parts.join('');
}

const ids = {
  nodeId: (c) => deriveNodeId(c),
  graphId: (c) => deriveGraphId(c),
  edgeId: (c) => deriveEdgeId(c),
};

console.log('building synthetic 5MB markdown book …');
const text = buildBook();
console.log(`  ${(text.length / 1e6).toFixed(1)} MB of markdown`);
const src = { uri: 'bench://book.md', mediaType: 'text/markdown', text };

const host = createPluginHost({ ids });
const reg = host.register(markdownPlugin);
if (!reg.ok) {
  console.error('benchmark plugin failed to register:', reg.issue);
  process.exit(1);
}
const vocabulary = host.vocabulary();

async function ingestOnce() {
  const outcome = await host.ingest(src);
  if (!outcome.ok) throw new Error(`ingest failed: ${outcome.issue.message}`);
  const gate = decode(outcome.documents[0], { vocabulary });
  if (!gate.ok) throw new Error(`gate rejected: ${gate.errors[0]?.message}`);
  return gate.space;
}

// Warmup (JIT) — one run, unmeasured; also sanity-checks output shape.
const space = await ingestOnce();
console.log(`  → ${space.graphs.size} graphs`);

const samples = [];
for (let i = 0; i < 3; i++) {
  const t0 = process.hrtime.bigint();
  await ingestOnce();
  samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
samples.sort((a, b) => a - b);
const ingestMs = samples[Math.floor(samples.length / 2)];

let failed = false;
console.log('\nbudget check (median):');
for (const [name, ms] of [['ingest-5mb-markdown-ms', ingestMs]]) {
  const budget = budgets[name];
  const ok = ms <= budget;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${ms.toFixed(1)}ms  (budget ${budget}ms)`);
}
if (failed) {
  console.error('\nperf budget exceeded — budgets are CI contracts (ADR-A12)');
  process.exit(1);
}
