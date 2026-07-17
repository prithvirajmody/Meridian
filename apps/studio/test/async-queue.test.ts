import { describe, expect, it } from 'vitest';
import { BoundedAsyncQueue } from '../src/pipeline/async-queue.js';

describe('BoundedAsyncQueue', () => {
  it('holds a producer at capacity and preserves order', async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    await queue.push(1);
    let secondAccepted = false;
    const second = queue.push(2).then(() => { secondAccepted = true; });
    await Promise.resolve();
    expect(queue.buffered).toBe(1);
    expect(secondAccepted).toBe(false);

    const seen: number[] = [];
    const consume = (async () => {
      for await (const value of queue) {
        seen.push(value);
        if (seen.length === 2) queue.close();
      }
    })();
    await second;
    await consume;
    expect(seen).toEqual([1, 2]);
  });

  it('unblocks and rejects a waiting producer when staging fails', async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    await queue.push(1);
    const pending = queue.push(2);
    queue.fail(new Error('quota exceeded'));
    await expect(pending).rejects.toThrow('quota exceeded');
  });
});
