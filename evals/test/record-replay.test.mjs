import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AiSession, MemoryResponseStore } from '../../packages/ai/dist/index.js';
import { mockEmbedProvider } from '../lib/mock-embed.mjs';
import { mockExtractProvider } from '../lib/mock-extract.mjs';
import { mockSummarizeProvider } from '../lib/mock-summarize.mjs';
import { parseRecordArgs, runEvaluation, runRecord } from '../run.mjs';

function fakeRecordSession(target) {
  const store = new MemoryResponseStore();
  const provider =
    target.task === 'cluster'
      ? mockEmbedProvider(target.provider, target.model)
      : target.task === 'argmap'
        ? mockExtractProvider(target.provider, target.model)
        : mockSummarizeProvider(target.provider, target.model);
  const routes =
    target.task === 'cluster'
      ? { embedding: { providerId: provider.id, model: target.model } }
      : target.task === 'argmap'
        ? { extraction: { providerId: provider.id, model: target.model } }
        : { summarization: { providerId: provider.id, model: target.model } };
  const config = { mode: 'record', routes, egressConsent: true };
  const session = new AiSession({ config, providers: [provider], store });
  return Promise.resolve({ session, store, config, provider });
}

test('live record CLI requires explicit consent and the matching provider key', () => {
  assert.throws(
    () => parseRecordArgs(['--record', 'anthropic', 'claude-test', '--task', 'summarize'], {}),
    /explicit egress consent/i,
  );
  assert.throws(
    () =>
      parseRecordArgs(
        ['--record', 'openai', 'gpt-test', '--task', 'summarize', '--consent-live'],
        {},
      ),
    /OPENAI_API_KEY is required/,
  );
  assert.throws(
    () =>
      parseRecordArgs(
        ['--record', 'openai', 'gpt-test', '--task', 'summarize', '--consent-live'],
        { OPENAI_API_KEY: 'test-only', CI: 'true' },
      ),
    /disabled when CI is set/,
  );
  assert.deepEqual(
    parseRecordArgs(
      [
        '--record',
        '--provider',
        'anthropic',
        '--model',
        'claude-test',
        '--task',
        'summarize',
        '--consent-live',
      ],
      { ANTHROPIC_API_KEY: 'test-only' },
    ),
    {
      provider: 'anthropic',
      model: 'claude-test',
      task: 'summarize',
      egressConsent: true,
    },
  );
});

test('offline fake record writes durable artifacts that replay green without network', async () => {
  const root = mkdtempSync(join(tmpdir(), 'meridian-evals-'));
  const recordingPath = join(root, 'recordings', 'services.recording.json');
  const outDir = join(root, 'out');
  const logs = [];
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error('test attempted live network access');
  };

  try {
    const common = {
      createSession: fakeRecordSession,
      recordingPath,
      outDir,
      now: () => '2026-07-13T00:00:00.000Z',
      log: (line) => logs.push(line),
    };
    const summarize = await runRecord(
      {
        provider: 'fake-complete',
        model: 'fake-complete-1',
        task: 'summarize',
        egressConsent: true,
      },
      common,
    );
    const cluster = await runRecord(
      {
        provider: 'fake-embed',
        model: 'fake-embed-1',
        task: 'cluster',
        egressConsent: true,
      },
      common,
    );
    const argmap = await runRecord(
      {
        provider: 'fake-extract',
        model: 'fake-extract-1',
        task: 'argmap',
        egressConsent: true,
      },
      common,
    );

    assert.equal(existsSync(recordingPath), true);
    assert.equal(existsSync(summarize.outputPath), true);
    assert.equal(existsSync(cluster.outputPath), true);
    assert.equal(existsSync(argmap.outputPath), true);

    const recording = JSON.parse(readFileSync(recordingPath, 'utf8'));
    assert.equal(Object.keys(recording.summarize.snapshot).length, 20);
    assert.equal(Object.keys(recording.cluster.snapshot).length, 1);
    assert.equal(recording.summarize.config.egressConsent, undefined);
    assert.equal(recording.cluster.config.egressConsent, undefined);

    const report = await runEvaluation({
      mode: 'replay',
      recordings: recording,
      ratingsPath: join(root, 'no-human-ratings.json'),
      log: (line) => logs.push(line),
    });
    assert.equal(report.ok, true);
    assert.equal(report.summarize.deterministic, true);
    assert.equal(report.cluster.deterministic, true);
    assert.equal(report.argmap.deterministic, true);
    assert.equal(report.argmap.structuralOk, true);
    assert.ok(report.argmap.nodeCount > 8);
    assert.ok(report.argmap.budget.spentDollars > 0);
    assert.equal(report.cluster.purity, 1);
    assert.ok(report.summarize.budget.spentDollars > 0);
    assert.ok(report.cluster.budget.spentDollars > 0);
    assert.equal(networkAttempts, 0);
    assert.ok(logs.some((line) => line.includes('all objective floors held')));
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
