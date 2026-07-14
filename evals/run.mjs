/**
 * Meridian eval harness (ROADMAP Phase 8 §3/§11/§13, SUBPHASES 8F).
 *
 * Offline-first, provider-neutral quality harness for the AI services:
 *
 *   node evals/run.mjs                 # mock, zero network — offline gate
 *   node evals/run.mjs --replay        # replay a complete durable recording
 *   node evals/run.mjs --record ...    # explicit-consent live fixture authoring
 *   node evals/run.mjs --update-golden # regenerate committed mock goldens
 *
 * `--record` is intentionally separate from every automated command. It needs
 * a provider, model, matching environment key, and the literal
 * `--consent-live` flag before a network-capable session can be constructed.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeCut } from '../packages/ai-services/dist/summarize.js';
import { clusterNodes } from '../packages/ai-services/dist/cluster.js';
import {
  mockSummarizeSession,
  mockClusterSession,
  recordSession,
  replaySession,
} from './lib/sessions.mjs';
import { buildSoup } from './fixtures/node-soup.mjs';
import { purity, adjustedRandIndex, summaryStructure, mean } from './lib/metrics.mjs';
import { MockProvider } from '../packages/ai/dist/index.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const readJsonPath = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readJson = (p) => readJsonPath(here(p));
const canon = (v) => JSON.stringify(v, null, 2) + '\n';

const DEFAULT_RECORDING_PATH = here('./recordings/services.recording.json');
const DEFAULT_OUT_DIR = here('./out');
const DEFAULT_RATINGS_PATH = here('./ratings/module-summaries.ratings.json');
const FLOORS = readJson('./floors.json');

const USAGE = `Usage:
  node evals/run.mjs
  node evals/run.mjs --replay
  node evals/run.mjs --update-golden
  node evals/run.mjs --record <anthropic|openai> <model> --task <summarize|cluster> --consent-live

Named --provider/--model arguments are also accepted. If --task is omitted,
completion models record summaries and OpenAI embedding models record clusters.`;

// ------------------------------------------------------------------- fixtures
function rollupsFromModules() {
  const fixture = readJson('./fixtures/module-summaries.json');
  return fixture.modules.map((m) => ({
    id: m.id,
    domain: fixture.domain,
    members: m.members,
    digest: m.digest,
    fallbackName: m.fallbackName,
    fallbackSummary: m.fallbackSummary,
  }));
}

const project = (r) =>
  r.summaries.map((s) => ({
    id: s.id,
    name: s.name,
    summary: s.summary,
    confidence: s.confidence,
  }));

async function summarizeOnce(session) {
  const result = await summarizeCut(session, rollupsFromModules());
  const structural = result.summaries.map((s) => ({ id: s.id, ...summaryStructure(s) }));
  const invalid = structural.filter((s) => !s.ok);
  return {
    summaries: project(result),
    enriched: result.enriched,
    floored: result.floored,
    validShare: 1 - invalid.length / structural.length,
    invalid,
    budget: result.budget,
  };
}

async function clusterOnce(session) {
  const { nodes, truthById } = buildSoup({ n: 500, topics: 8 });
  const result = await clusterNodes(session, nodes, { k: 8, domain: 'soup' });
  return {
    nodeCount: nodes.length,
    clusterCount: result.clusters.length,
    purity: purity(result.clusters, truthById),
    ari: adjustedRandIndex(result.clusters, truthById),
    labels: result.clusters.map((c) => ({
      label: c.label,
      size: c.members.length,
      confidence: Number(c.confidence.toFixed(4)),
    })),
    budget: result.budget,
  };
}

// ------------------------------------------------------------- service evals
export async function runSummarize(makeSession) {
  const result = await summarizeOnce(makeSession());
  const again = await summarizeOnce(makeSession());
  return {
    ...result,
    deterministic: canon(result.summaries) === canon(again.summaries),
  };
}

export async function runCluster(makeSession) {
  const result = await clusterOnce(makeSession());
  const again = await clusterOnce(makeSession());
  const shape = (r) => ({
    clusterCount: r.clusterCount,
    labels: r.labels,
  });
  return {
    ...result,
    deterministic: canon(shape(result)) === canon(shape(again)),
  };
}

// --------------------------------------------------------------- human ratings
function humanSummaryMean(path = DEFAULT_RATINGS_PATH) {
  if (!existsSync(path)) return null;
  const ratings = readJsonPath(path);
  const scores = Object.values(ratings.scores ?? {})
    .map((r) => r.rating)
    .filter((n) => typeof n === 'number');
  return scores.length > 0 ? mean(scores) : null;
}

// ---------------------------------------------------------------- recordings
export function loadRecordings(path = DEFAULT_RECORDING_PATH) {
  if (!existsSync(path)) {
    throw new Error(
      `No recording at ${relative(process.cwd(), path)}. Record both tasks locally first (needs explicit consent and keys).`,
    );
  }
  const recording = readJsonPath(path);
  const missing = ['summarize', 'cluster'].filter((task) => !recording[task]);
  if (missing.length > 0) {
    throw new Error(
      `Recording ${relative(process.cwd(), path)} is incomplete (missing ${missing.join(', ')}). Run --record for each missing task.`,
    );
  }
  return recording;
}

function replayProvider(recording, task) {
  const routeName = task === 'summarize' ? 'summarization' : 'embedding';
  const route = recording.config.routes[routeName];
  if (!route) throw new Error(`Recording '${task}' has no '${routeName}' route.`);
  const capabilities = {
    completion: task === 'summarize',
    embedding: task === 'cluster',
    models: {
      [route.model]: recording.metadata?.pricing ?? {
        inputPerMTok: 0,
        outputPerMTok: 0,
      },
    },
  };
  return new MockProvider({
    id: route.providerId,
    capabilities,
    onComplete: () => {
      throw new Error('replay must never call completion provider');
    },
    onEmbed: () => {
      throw new Error('replay must never call embedding provider');
    },
  });
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = resolve(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, canon(value), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

function cleanConfig(config) {
  // Consent authorizes a particular live invocation; it is not persisted as a
  // project-wide grant in a fixture. Replay never requires it.
  const persisted = { ...config };
  delete persisted.egressConsent;
  return persisted;
}

function usageSummary(budget, unitCount) {
  return {
    calls: budget.calls,
    tokens: budget.spentTokens,
    dollars: Number(budget.spentDollars.toFixed(9)),
    centsPerThousandUnits: Number(
      ((budget.spentDollars * 100 * 1000) / Math.max(1, unitCount)).toFixed(6),
    ),
  };
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * Record exactly one service task and merge it into the durable recording.
 * `createSession` is injectable solely so the offline test can use deterministic
 * MockProviders. The CLI always uses `recordSession`, which constructs a real
 * built-in adapter only after consent and key validation.
 */
export async function runRecord(
  target,
  {
    createSession = recordSession,
    recordingPath = DEFAULT_RECORDING_PATH,
    outDir = DEFAULT_OUT_DIR,
    now = () => new Date().toISOString(),
    log = console.log,
  } = {},
) {
  // Parse any existing fixture before constructing a network-capable session;
  // a corrupt destination must fail before a paid call can happen.
  const existing = existsSync(recordingPath) ? readJsonPath(recordingPath) : {};
  const { session, store, config, provider } = await createSession(target);
  const recordedAt = now();
  const routeName = target.task === 'cluster' ? 'embedding' : 'summarization';
  const route = config.routes[routeName];
  if (!route) throw new Error(`Record session has no '${routeName}' route.`);
  const pricing = provider?.capabilities?.models?.[route.model];
  if (!pricing) throw new Error(`Record provider has no pricing for model '${route.model}'.`);

  let taskResult;
  let output;
  let unitCount;
  if (target.task === 'cluster') {
    taskResult = await clusterOnce(session);
    unitCount = taskResult.nodeCount;
    output = {
      version: 1,
      recordedAt,
      providerId: route.providerId,
      model: route.model,
      fixture: 'node-soup',
      nodeCount: taskResult.nodeCount,
      usage: usageSummary(taskResult.budget, unitCount),
      metrics: {
        clusterCount: taskResult.clusterCount,
        purity: Number(taskResult.purity.toFixed(6)),
        ari: Number(taskResult.ari.toFixed(6)),
      },
      labels: taskResult.labels,
    };
  } else if (target.task === 'summarize') {
    taskResult = await summarizeOnce(session);
    unitCount = taskResult.summaries.length;
    output = {
      version: 1,
      recordedAt,
      providerId: route.providerId,
      model: route.model,
      fixture: 'module-summaries',
      nodeCount: unitCount,
      usage: usageSummary(taskResult.budget, unitCount),
      metrics: {
        enriched: taskResult.enriched,
        floored: taskResult.floored,
        structuralValidShare: Number(taskResult.validShare.toFixed(6)),
      },
      summaries: taskResult.summaries,
    };
  } else {
    throw new Error(`Unknown record task '${target.task}' (expected summarize|cluster).`);
  }

  const outputPath = resolve(
    outDir,
    `${output.fixture}.${safeSegment(route.providerId)}.${safeSegment(route.model)}.json`,
  );
  writeJsonAtomic(outputPath, output);

  const taskKey = target.task === 'cluster' ? 'cluster' : 'summarize';
  const recording = {
    ...existing,
    version: 1,
    createdAt: existing.createdAt ?? recordedAt,
    updatedAt: recordedAt,
    [taskKey]: {
      config: cleanConfig(config),
      snapshot: store.snapshot(),
      metadata: {
        task: target.task,
        recordedAt,
        providerId: route.providerId,
        model: route.model,
        fixture: output.fixture,
        nodeCount: unitCount,
        usage: output.usage,
        pricing,
        metrics: output.metrics,
      },
    },
  };
  writeJsonAtomic(recordingPath, recording);

  log(`recorded ${target.task}: ${route.providerId}/${route.model}`);
  log(
    `  ${output.usage.calls} calls · ${output.usage.tokens} tokens · $${output.usage.dollars.toFixed(6)} · ${output.usage.centsPerThousandUnits.toFixed(4)}¢/1k ${target.task === 'cluster' ? 'nodes' : 'modules'}`,
  );
  log(`  durable recording: ${relative(process.cwd(), recordingPath)}`);
  log(`  inspect/rate output: ${relative(process.cwd(), outputPath)}`);
  return { recording, recordingPath, output, outputPath, taskResult };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.\n\n${USAGE}`);
  return value;
}

function ciIsSet(value) {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/** Parse and guard the only network-capable eval command. */
export function parseRecordArgs(args, env = process.env) {
  const recordIndex = args.indexOf('--record');
  if (recordIndex === -1) throw new Error(`Missing --record.\n\n${USAGE}`);
  const positionalProvider = args[recordIndex + 1]?.startsWith('--')
    ? undefined
    : args[recordIndex + 1];
  const positionalModel = args[recordIndex + 2]?.startsWith('--')
    ? undefined
    : args[recordIndex + 2];
  const provider = optionValue(args, '--provider') ?? positionalProvider;
  const model = optionValue(args, '--model') ?? positionalModel;
  if (!provider || !model) throw new Error(`--record requires provider and model.\n\n${USAGE}`);
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(`Unknown provider '${provider}' (expected anthropic|openai).`);
  }
  if (!args.includes('--consent-live')) {
    throw new Error(
      'Live recording is disabled without explicit egress consent. Review the data/cost implications, then pass --consent-live.',
    );
  }
  if (ciIsSet(env.CI)) {
    throw new Error('Live --record is disabled when CI is set; automated jobs must use mock or replay mode.');
  }
  const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  if (typeof env[keyName] !== 'string' || env[keyName].trim() === '') {
    throw new Error(`${keyName} is required for --record ${provider}.`);
  }

  const requestedTask = optionValue(args, '--task');
  let task;
  if (requestedTask === undefined) {
    task = provider === 'openai' && /embedding/i.test(model) ? 'cluster' : 'summarize';
  } else if (requestedTask === 'summarize' || requestedTask === 'summarization') {
    task = 'summarize';
  } else if (requestedTask === 'cluster' || requestedTask === 'embedding') {
    task = 'cluster';
  } else {
    throw new Error(`Unknown --task '${requestedTask}' (expected summarize|cluster).`);
  }
  if (provider === 'anthropic' && task === 'cluster') {
    throw new Error('The built-in Anthropic adapter has no embedding capability; use an embedding provider such as OpenAI for --task cluster.');
  }
  return { provider, model, task, egressConsent: true };
}

// ---------------------------------------------------------------------- report
function check(log, name, ok, shown, floorShown) {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${shown}  (floor ${floorShown})`);
  return ok;
}

/** Run mock or replay evaluation without process exits, so tests can assert it. */
export async function runEvaluation({
  mode = 'mock',
  recordings,
  recordingPath = DEFAULT_RECORDING_PATH,
  ratingsPath = DEFAULT_RATINGS_PATH,
  updateGolden = false,
  log = console.log,
} = {}) {
  let makeSummarize = mockSummarizeSession;
  let makeCluster = mockClusterSession;
  if (mode === 'replay') {
    const rec = recordings ?? loadRecordings(recordingPath);
    if (!rec.summarize || !rec.cluster) throw new Error('Replay requires summarize and cluster recordings.');
    makeSummarize = () => replaySession(rec.summarize, replayProvider(rec.summarize, 'summarize'));
    makeCluster = () => replaySession(rec.cluster, replayProvider(rec.cluster, 'cluster'));
  } else if (mode !== 'mock') {
    throw new Error(`Unknown eval mode '${mode}'.`);
  }

  log(`meridian evals — mode: ${mode}\n`);
  const sum = await runSummarize(makeSummarize);
  const clus = await runCluster(makeCluster);

  log('summarize (module summaries):');
  log(`  ${sum.summaries.length} modules · ${sum.enriched} enriched · ${sum.floored} floored`);
  log('cluster (500-node soup):');
  log(
    `  ${clus.nodeCount} nodes → ${clus.clusterCount} clusters · purity ${clus.purity.toFixed(3)} · ARI ${clus.ari.toFixed(3)}`,
  );

  const goldens = {
    './goldens/module-summaries.mock.json': sum.summaries,
    './goldens/node-soup.mock.json': {
      clusterCount: clus.clusterCount,
      purity: Number(clus.purity.toFixed(6)),
      ari: Number(clus.ari.toFixed(6)),
      labels: clus.labels,
    },
  };
  if (updateGolden) {
    if (mode !== 'mock') throw new Error('--update-golden is only valid in mock mode.');
    mkdirSync(here('./goldens'), { recursive: true });
    for (const [path, value] of Object.entries(goldens)) writeFileSync(here(path), canon(value));
    log('\ngoldens updated.');
    return { ok: true, summarize: sum, cluster: clus, updatedGoldens: true };
  }

  log('\nfloor check:');
  let ok = true;
  ok = check(log, 'cluster-purity-min', clus.purity >= FLOORS['cluster-purity-min'], clus.purity.toFixed(3), `≥ ${FLOORS['cluster-purity-min']}`) && ok;
  ok = check(log, 'cluster-ari-min', clus.ari >= FLOORS['cluster-ari-min'], clus.ari.toFixed(3), `≥ ${FLOORS['cluster-ari-min']}`) && ok;
  ok = check(log, 'summary-structural-valid-min', sum.validShare >= FLOORS['summary-structural-valid-min'], sum.validShare.toFixed(3), `≥ ${FLOORS['summary-structural-valid-min']}`) && ok;
  ok = check(log, 'summarize-deterministic', sum.deterministic, String(sum.deterministic), 'true') && ok;
  ok = check(log, 'cluster-deterministic', clus.deterministic, String(clus.deterministic), 'true') && ok;

  if (mode === 'mock') {
    for (const [path, value] of Object.entries(goldens)) {
      const exists = existsSync(here(path));
      const match = exists && readFileSync(here(path), 'utf8') === canon(value);
      ok = check(
        log,
        `golden:${path.split('/').pop()}`,
        match,
        exists ? (match ? 'match' : 'DRIFT') : 'MISSING',
        'match (regen: --update-golden)',
      ) && ok;
    }
  }

  if (sum.invalid.length > 0) {
    log('\nstructural failures:');
    for (const inv of sum.invalid) log(`  ${inv.id}: ${inv.issues.join(', ')}`);
  }

  const humanMean = humanSummaryMean(ratingsPath);
  log('\nhuman-rated summary quality (RUBRIC.md):');
  if (humanMean === null) {
    log('  UNVERIFIED — HUMAN: no evals/ratings/module-summaries.ratings.json present.');
    log('  Record real summaries (--record) and rate them to populate it (see README).');
  } else {
    ok = check(log, 'summary-human-mean-min', humanMean >= FLOORS['summary-human-mean-min'], humanMean.toFixed(2), `≥ ${FLOORS['summary-human-mean-min']}`) && ok;
  }

  if (!ok) log('\neval floor breached — regression gate (ROADMAP §9c: floors, not per-CI).');
  else log('\nall objective floors held.');
  return { ok, summarize: sum, cluster: clus, humanMean };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const modes = ['--record', '--replay'].filter((flag) => args.includes(flag));
  if (modes.length > 1) throw new Error(`Choose only one of ${modes.join(', ')}.`);
  if (args.includes('--record')) {
    const target = parseRecordArgs(args, env);
    await runRecord(target);
    return;
  }
  const report = await runEvaluation({
    mode: args.includes('--replay') ? 'replay' : 'mock',
    updateGolden: args.includes('--update-golden'),
  });
  if (!report.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
