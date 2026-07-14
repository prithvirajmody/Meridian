/**
 * Phase 8 perf budget (ROADMAP Phase 8 §12): replay-mode overhead per gateway
 * call. In replay (CI) mode a `session.call` is a content-hash lookup + a zod
 * validate — no network, no provider. The verification table requires
 * "Replay-mode overhead < 5ms/call"; this measures the median per-call wall
 * time over a warm, pre-recorded response store, against benchmarks/budgets.json.
 * Exceeding a budget exits 1 — a perf budget is a test (§5.2).
 *
 * Zero network by construction: the replay provider throws if the gateway ever
 * calls it, so a measured call that is not a pure cache hit fails loudly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AiSession, MemoryResponseStore, MockProvider } from '../packages/ai/dist/index.js';
import { SUMMARIZE_ROLLUP_PROMPT } from '../packages/ai-services/dist/prompts/summarize-rollup.js';

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'),
);

const PROVIDER_ID = 'mock';
const MODEL = 'mock-1';
const CAPS = { completion: true, embedding: false, models: { [MODEL]: { inputPerMTok: 3, outputPerMTok: 15 } } };
const ROUTES = { summarization: { providerId: PROVIDER_ID, model: MODEL } };

// ---- distinct inputs so every call keys to its own recorded response --------
const N = 400;
function inputs() {
  const out = [];
  for (let i = 0; i < N; i++) {
    out.push({
      domain: 'code',
      members: [
        { kind: 'code:function', label: `fn_${i}` },
        { kind: 'code:function', label: `helper_${i}` },
        { kind: 'code:type', label: `Type_${i}` },
      ],
      totalMembers: 3,
    });
  }
  return out;
}
const ITEMS = inputs();

// ---- record: fill a store with one response per input -----------------------
const recordProvider = new MockProvider({
  id: PROVIDER_ID,
  capabilities: CAPS,
  onComplete: (req) => {
    const user = [...req.messages].reverse().find((m) => m.role === 'user');
    const tag = typeof user?.content === 'string' ? user.content.length : 0;
    return { kind: 'json', value: { name: `Group ${tag}`, summary: `A group of three items (${tag}).`, confidence: 0.7 } };
  },
});
const store = new MemoryResponseStore();
const recorder = new AiSession({
  // This recorder is an in-process MockProvider and cannot egress. Record mode
  // still requires the same explicit consent bit as every network-capable
  // session, so the benchmark exercises the production constructor contract.
  config: { mode: 'record', routes: ROUTES, egressConsent: true },
  providers: [recordProvider],
  store,
});
console.log(`recording ${N} responses …`);
for (const input of ITEMS) {
  const res = await recorder.call(SUMMARIZE_ROLLUP_PROMPT, input);
  if (!res.value?.name) throw new Error('record produced no value');
}
const snapshot = store.snapshot();

// ---- replay: provider throws if ever called; measure per-call overhead -------
const replayProvider = new MockProvider({
  id: PROVIDER_ID,
  capabilities: CAPS,
  onComplete: () => {
    throw new Error('replay mode must not call the provider');
  },
});
const replayer = new AiSession({
  config: { mode: 'replay', routes: ROUTES },
  providers: [replayProvider],
  store: new MemoryResponseStore(snapshot),
});

// Warmup (JIT + zod compile), unmeasured.
for (let w = 0; w < 20; w++) {
  const res = await replayer.call(SUMMARIZE_ROLLUP_PROMPT, ITEMS[w % N]);
  if (!res.cached) throw new Error('warmup call was not a cache hit');
}

const samples = [];
for (let rep = 0; rep < 3; rep++) {
  for (const input of ITEMS) {
    const t0 = process.hrtime.bigint();
    const res = await replayer.call(SUMMARIZE_ROLLUP_PROMPT, input);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (!res.cached) throw new Error('replay call was not a cache hit — recording gap');
  }
}
samples.sort((a, b) => a - b);
const results = [
  ['ai-replay-overhead-p50-ms', samples[Math.floor(samples.length / 2)]],
  ['ai-replay-overhead-p95-ms', samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]],
];

let failed = false;
console.log('\nbudget check:');
for (const [name, value] of results) {
  const budget = budgets[name];
  const ok = value <= budget;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${value.toFixed(3)}ms  (budget ≤ ${budget}ms)`);
}
if (failed) {
  console.error('\nperf budget exceeded — budgets are CI contracts (ADR-A12)');
  process.exit(1);
}
