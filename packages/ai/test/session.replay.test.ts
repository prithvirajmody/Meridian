import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/mock-provider.js';
import { AiSession } from '../src/session.js';
import { MemoryResponseStore } from '../src/store.js';
import { COMPLETION_CAPS, completionConfig, countingSleeper, summarySpec } from './helpers.js';

function jsonProvider(): MockProvider {
  return new MockProvider({
    id: 'mock',
    capabilities: COMPLETION_CAPS,
    onComplete: () => ({ kind: 'json', value: { name: 'N', summary: 'S' } }),
  });
}

const input = { nodeId: 'n1', text: 'body' };

describe('AiSession record → replay', () => {
  it('replays a recorded fixture with the network never touched', async () => {
    // Record live.
    const recProvider = jsonProvider();
    const store = new MemoryResponseStore();
    const recorder = new AiSession({
      config: completionConfig('record'),
      providers: [recProvider],
      store,
      sleeper: countingSleeper().sleeper,
    });
    const recorded = await recorder.call(summarySpec, input);
    const snapshot = store.snapshot();

    // Replay from the snapshot; the provider must not be called.
    const replayProvider = jsonProvider();
    const replayer = new AiSession({
      config: completionConfig('replay'),
      providers: [replayProvider],
      store: new MemoryResponseStore(snapshot),
      sleeper: countingSleeper().sleeper,
    });
    const replayed = await replayer.call(summarySpec, input);

    expect(replayProvider.completionCount).toBe(0);
    expect(replayed.cached).toBe(true);
    expect(replayed.value).toEqual(recorded.value);
    // Replay is zero-network but still reproduces the recorded cost meter.
    expect(replayer.budget.calls).toBe(1);
    expect(replayer.budget.spentTokens).toBe(20);
    expect(replayer.budget.spentDollars).toBeCloseTo(0.0004);
  });

  it('enforces a budget across replay hits using recorded usage', async () => {
    const store = new MemoryResponseStore();
    const recorder = new AiSession({
      config: completionConfig('record'),
      providers: [jsonProvider()],
      store,
      sleeper: countingSleeper().sleeper,
    });
    await recorder.call(summarySpec, input);

    const replayProvider = jsonProvider();
    const replayer = new AiSession({
      config: completionConfig('replay', { budget: { maxTokens: 20 } }),
      providers: [replayProvider],
      store: new MemoryResponseStore(store.snapshot()),
      sleeper: countingSleeper().sleeper,
    });

    await expect(replayer.call(summarySpec, input)).resolves.toMatchObject({ cached: true });
    expect(replayer.budget.status).toBe('stopped');
    await expect(replayer.call(summarySpec, input)).rejects.toMatchObject({
      kind: 'budget_exceeded',
    });
    expect(replayProvider.completionCount).toBe(0);
    expect(replayer.budget.calls).toBe(1);
  });

  it('treats a replay cache miss as a hard error and never calls the provider', async () => {
    const provider = jsonProvider();
    const replayer = new AiSession({
      config: completionConfig('replay'),
      providers: [provider],
      store: new MemoryResponseStore(),
      sleeper: countingSleeper().sleeper,
    });
    await expect(replayer.call(summarySpec, input)).rejects.toMatchObject({ kind: 'replay_miss' });
    expect(provider.completionCount).toBe(0);
  });
});
