/**
 * Tiny bounded async hand-off used between a synchronous-ish plugin sink and
 * the private streamed-store staging loop. A producer cannot get more than
 * `capacity` emissions ahead of the consumer; failure closes both sides and
 * releases every waiter.
 */
export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<() => void> = [];
  private readonly writers: Array<() => void> = [];
  private closed = false;
  private failure: unknown;
  private iterated = false;

  constructor(readonly capacity = 1) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('bounded async queue capacity must be a positive safe integer');
    }
  }

  async push(value: T): Promise<void> {
    this.assertOpen();
    while (this.values.length >= this.capacity) {
      await new Promise<void>((resolve) => this.writers.push(resolve));
      this.assertOpen();
    }
    this.values.push(value);
    this.readers.shift()?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseAll();
  }

  fail(cause: unknown): void {
    if (this.closed) return;
    this.failure = cause;
    this.closed = true;
    this.values.length = 0;
    this.releaseAll();
  }

  get buffered(): number {
    return this.values.length;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iterated) throw new Error('bounded async queue supports one consumer');
    this.iterated = true;
    for (;;) {
      if (this.values.length > 0) {
        const value = this.values.shift()!;
        this.writers.shift()?.();
        yield value;
        continue;
      }
      if (this.failure !== undefined) throw this.failure;
      if (this.closed) return;
      await new Promise<void>((resolve) => this.readers.push(resolve));
    }
  }

  private assertOpen(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.closed) throw new Error('bounded async queue is closed');
  }

  private releaseAll(): void {
    for (const resolve of this.readers.splice(0)) resolve();
    for (const resolve of this.writers.splice(0)) resolve();
  }
}
