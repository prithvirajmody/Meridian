import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/mock-provider.js';
import { AiSession } from '../src/session.js';
import { MemoryResponseStore } from '../src/store.js';
import { COMPLETION_CAPS, completionConfig, countingSleeper, summarySpec } from './helpers.js';

const VALID = { name: 'N', summary: 'S' };

// Each mock completion reports usage {input:10, output:10} = 20 tokens.
function jsonProvider(): MockProvider {
  return new MockProvider({
    id: 'mock',
    capabilities: COMPLETION_CAPS,
    onComplete: () => ({ kind: 'json', value: VALID }),
  });
}

describe('AiSession.call — budget', () => {
  it('trips mid-run and leaves the prior result valid (no rollback)', async () => {
    const provider = jsonProvider();
    const session = new AiSession({
      config: completionConfig('off', { budget: { maxTokens: 20 } }),
      providers: [provider],
      sleeper: countingSleeper().sleeper,
    });

    const first = await session.call(summarySpec, { nodeId: 'a', text: 'x' });
    expect(first.value).toEqual(VALID); // valid, kept

    await expect(session.call(summarySpec, { nodeId: 'b', text: 'y' })).rejects.toMatchObject({
      kind: 'budget_exceeded',
    });
    expect(provider.completionCount).toBe(1); // the tripped call never reached the provider
    expect(session.budget.tripped).toBe(true);
    expect(session.budget.calls).toBe(1);
  });

  it('does not charge budget for ordinary live-cache hits', async () => {
    const provider = jsonProvider();
    const session = new AiSession({
      config: completionConfig('live', { budget: { maxTokens: 20 } }),
      providers: [provider],
      store: new MemoryResponseStore(),
      sleeper: countingSleeper().sleeper,
    });

    const a1 = await session.call(summarySpec, { nodeId: 'a', text: 'x' }); // spends 20
    const a2 = await session.call(summarySpec, { nodeId: 'a', text: 'x' }); // cache hit — free
    expect(a1.cached).toBe(false);
    expect(a2.cached).toBe(true);
    expect(session.budget.calls).toBe(1);

    // A fresh input now trips the ceiling.
    await expect(session.call(summarySpec, { nodeId: 'b', text: 'y' })).rejects.toMatchObject({
      kind: 'budget_exceeded',
    });
  });
});
