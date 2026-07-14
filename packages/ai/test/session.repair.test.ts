import { describe, expect, it } from 'vitest';
import { AiError } from '../src/errors.js';
import { MockProvider } from '../src/mock-provider.js';
import { AiSession } from '../src/session.js';
import { MemoryResponseStore } from '../src/store.js';
import { COMPLETION_CAPS, completionConfig, countingSleeper, summarySpec } from './helpers.js';

const input = { nodeId: 'n1', text: 'body' };
const VALID = { name: 'N', summary: 'S' };

describe('AiSession.call — schema validation & repair', () => {
  it('runs exactly one repair attempt and returns the repaired value', async () => {
    const provider = MockProvider.fromOutcomes(
      [
        { kind: 'json', value: { name: 'N' } }, // missing `summary` → invalid
        { kind: 'json', value: VALID }, // repaired
      ],
      { id: 'mock', capabilities: COMPLETION_CAPS },
    );
    const session = new AiSession({
      config: completionConfig('off'),
      providers: [provider],
      sleeper: countingSleeper().sleeper,
    });
    const result = await session.call(summarySpec, input);

    expect(result.repaired).toBe(true);
    expect(result.value).toEqual(VALID);
    expect(provider.completionCount).toBe(2);

    const repairRequest = provider.completionRequests[1];
    const lastMessage = repairRequest?.messages[repairRequest.messages.length - 1];
    expect(lastMessage?.content).toContain('did not conform to the required schema');
  });

  it('rejects with schema_invalid after the repair also fails, retaining the raw response', async () => {
    const provider = MockProvider.fromOutcomes(
      [
        { kind: 'json', value: { name: 'N' } },
        { kind: 'json', value: { still: 'wrong' } },
      ],
      { id: 'mock', capabilities: COMPLETION_CAPS },
    );
    const session = new AiSession({
      config: completionConfig('off'),
      providers: [provider],
      sleeper: countingSleeper().sleeper,
    });

    let thrown: unknown;
    try {
      await session.call(summarySpec, input);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AiError);
    expect((thrown as AiError).kind).toBe('schema_invalid');
    expect((thrown as AiError).context.raw).toBeDefined();
    expect(provider.completionCount).toBe(2);
  });

  it('surfaces a refusal as a typed refusal error before validation', async () => {
    const provider = new MockProvider({
      id: 'mock',
      capabilities: COMPLETION_CAPS,
      onComplete: () => ({ kind: 'refusal' }),
    });
    const session = new AiSession({
      config: completionConfig('off'),
      providers: [provider],
      sleeper: countingSleeper().sleeper,
    });
    await expect(session.call(summarySpec, input)).rejects.toMatchObject({ kind: 'refusal' });
    expect(provider.completionCount).toBe(1);
  });

  it('replays a recorded repair round-trip with no provider calls', async () => {
    const recProvider = MockProvider.fromOutcomes(
      [
        { kind: 'json', value: { name: 'N' } },
        { kind: 'json', value: VALID },
      ],
      { id: 'mock', capabilities: COMPLETION_CAPS },
    );
    const store = new MemoryResponseStore();
    const recorder = new AiSession({
      config: completionConfig('record'),
      providers: [recProvider],
      store,
      sleeper: countingSleeper().sleeper,
    });
    await recorder.call(summarySpec, input);
    expect(store.size).toBe(2); // primary (invalid) + repair (valid)

    const replayProvider = MockProvider.fromOutcomes([{ kind: 'json', value: VALID }], {
      id: 'mock',
      capabilities: COMPLETION_CAPS,
    });
    const replayer = new AiSession({
      config: completionConfig('replay'),
      providers: [replayProvider],
      store: new MemoryResponseStore(store.snapshot()),
      sleeper: countingSleeper().sleeper,
    });
    const replayed = await replayer.call(summarySpec, input);
    expect(replayed.repaired).toBe(true);
    expect(replayed.value).toEqual(VALID);
    expect(replayProvider.completionCount).toBe(0);
  });
});
