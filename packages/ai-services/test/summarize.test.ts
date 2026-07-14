/**
 * `summarizeCut` (8D): the atomic-per-unit contract of ADR-0032. Every rollup
 * is one work-unit, so budget trips and degradable failures fall cleanly
 * *between* units — enriched units keep their AI name + provenance, floored
 * units keep the deterministic floor, and the set is always complete. A genuine
 * fault (replay miss) propagates rather than being hidden as a floor.
 */
import type { MockCompletionHandler, MockOutcome } from '@meridian/ai';
import { describe, expect, it } from 'vitest';
import { summarizeCut, type RollupInput } from '../src/summarize.js';
import { makeSession } from './helpers.js';

function rollup(id: string, members: string[], fallbackName = `floor-${id}`): RollupInput {
  return {
    id,
    domain: 'doc',
    members,
    digest: members.map((m) => ({ kind: 'doc:node', label: m })),
    fallbackName,
    fallbackSummary: `floor summary ${id}`,
  };
}

/** A handler that returns a valid summary keyed off the request, deterministically. */
const okHandler: MockCompletionHandler = (_req, i): MockOutcome => ({
  kind: 'json',
  value: { name: `AI name ${i}`, summary: `AI summary ${i}`, confidence: 0.75 },
});

describe('summarizeCut — enrichment & provenance', () => {
  it('enriches every rollup with an AI name/summary and the provenance quartet', async () => {
    const { session } = makeSession({ onComplete: okHandler });
    const result = await summarizeCut(session, [rollup('g0', ['a', 'b']), rollup('g1', ['c'])]);

    expect(result.enriched).toBe(2);
    expect(result.floored).toBe(0);
    expect(result.stoppedByBudget).toBe(false);
    const s0 = result.summaries[0]!;
    expect(s0).toMatchObject({ id: 'g0', name: 'AI name 0', enriched: true, confidence: 0.75 });
    expect(s0.provenance).toEqual({
      providerId: 'mock',
      model: 'test-model',
      promptVersion: '1',
      inputHash: expect.any(String),
    });
  });

  it('is deterministic — identical input yields identical output', async () => {
    const rollups = [rollup('g0', ['a', 'b']), rollup('g1', ['c', 'd'])];
    const a = await summarizeCut(makeSession({ onComplete: okHandler }).session, rollups);
    const b = await summarizeCut(makeSession({ onComplete: okHandler }).session, rollups);
    expect(a.summaries).toEqual(b.summaries);
  });

  it('caps the rendered member digest at maxMembersPerRollup', async () => {
    const { session, completion } = makeSession({ onComplete: okHandler });
    const big = rollup('g', ['a', 'b', 'c', 'd', 'e']);
    await summarizeCut(session, [big], { maxMembersPerRollup: 2 });
    const content = String(completion.completionRequests[0]!.messages[0]!.content);
    expect(content).toContain('5 total');
    expect(content).toContain('showing 2');
  });
});

describe('summarizeCut — degradation to the deterministic floor', () => {
  it('floors a refused unit and enriches the rest (degrade-unit)', async () => {
    const onComplete: MockCompletionHandler = (_req, i) =>
      i === 0 ? { kind: 'refusal' } : okHandler(_req, i);
    const { session } = makeSession({ onComplete });
    const result = await summarizeCut(session, [rollup('g0', ['a']), rollup('g1', ['b'])]);

    expect(result.floored).toBe(1);
    expect(result.enriched).toBe(1);
    expect(result.stoppedByBudget).toBe(false);
    expect(result.summaries[0]).toMatchObject({ id: 'g0', name: 'floor-g0', enriched: false, confidence: 0 });
    expect(result.summaries[0]!.provenance).toBeUndefined();
    expect(result.summaries[1]).toMatchObject({ id: 'g1', enriched: true });
  });

  it('floors a schema-invalid unit even after the one repair attempt', async () => {
    // Both the primary and repair completions return out-of-range confidence.
    const onComplete: MockCompletionHandler = () => ({
      kind: 'json',
      value: { name: 'n', summary: 's', confidence: 9 },
    });
    const { session } = makeSession({ onComplete });
    const result = await summarizeCut(session, [rollup('g0', ['a'])]);
    expect(result.floored).toBe(1);
    expect(result.summaries[0]).toMatchObject({ enriched: false, name: 'floor-g0' });
  });
});

describe('summarizeCut — budget hard-stop leaves valid partial state (ADR-0032)', () => {
  it('enriches units before the trip and floors the unit that trips and every unit after', async () => {
    // Each successful call spends 20 tokens; maxTokens 20 trips the *second* call.
    const { session } = makeSession({ onComplete: okHandler, budget: { maxTokens: 20 } });
    const result = await summarizeCut(session, [
      rollup('g0', ['a']),
      rollup('g1', ['b']),
      rollup('g2', ['c']),
    ]);

    expect(result.stoppedByBudget).toBe(true);
    expect(result.enriched).toBe(1);
    expect(result.floored).toBe(2);
    expect(result.summaries[0]).toMatchObject({ id: 'g0', enriched: true });
    expect(result.summaries[1]).toMatchObject({ id: 'g1', enriched: false, name: 'floor-g1' });
    expect(result.summaries[2]).toMatchObject({ id: 'g2', enriched: false, name: 'floor-g2' });
    expect(result.budget.tripped).toBe(true);
  });

  it('stops issuing calls after a budget trip (remaining units never hit the provider)', async () => {
    const { session, completion } = makeSession({ onComplete: okHandler, budget: { maxTokens: 20 } });
    await summarizeCut(session, [rollup('g0', ['a']), rollup('g1', ['b']), rollup('g2', ['c'])]);
    // Only g0 reaches the provider: g1's budget precheck rejects before any call,
    // and the stop flag floors g2 without a precheck.
    expect(completion.completionCount).toBe(1);
  });
});

describe('summarizeCut — non-degradable faults propagate', () => {
  it('rethrows a replay miss instead of silently flooring it', async () => {
    // replay mode with an empty store: every call is a hard replay_miss.
    const { session } = makeSession({ mode: 'replay' });
    await expect(summarizeCut(session, [rollup('g0', ['a'])])).rejects.toMatchObject({ kind: 'replay_miss' });
  });
});
