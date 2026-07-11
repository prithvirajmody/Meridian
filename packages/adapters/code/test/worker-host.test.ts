/**
 * 7B worker hosting: parsing runs inside a worker through the ADR-0017-pattern
 * host — both grammars, concurrency, AbortSignal cancellation over the control
 * port, crash → located error → respawn.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ParseWorkerHost } from '../src/index.js';
import { makeNodeFactory } from './node-factory.js';

const hosts: ParseWorkerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

function makeHost(parseDelayMs?: number) {
  const { factory, workers } = makeNodeFactory(
    parseDelayMs === undefined ? {} : { parseDelayMs },
  );
  const host = new ParseWorkerHost({ factory });
  hosts.push(host);
  return { host, workers };
}

describe('ParseWorkerHost (Node worker_threads)', () => {
  it('parses both languages in the worker, concurrently, with correct outcomes', async () => {
    const { host, workers } = makeHost();
    const [ts, py, broken] = await Promise.all([
      host.parse('typescript', 'const x: number = 1;\n'),
      host.parse('python', 'def f():\n    return 1\n'),
      host.parse('typescript', 'const = {{{'),
    ]);
    expect(ts.rootType).toBe('program');
    expect(ts.hasErrors).toBe(false);
    expect(py.rootType).toBe('module');
    expect(py.hasErrors).toBe(false);
    expect(broken.hasErrors).toBe(true);
    expect(workers).toHaveLength(1); // one long-lived worker serves all three
    expect(host.stats().completed).toBe(3);
  });

  it('pre-aborted signal rejects with AbortError before dispatch', async () => {
    const { host } = makeHost();
    const controller = new AbortController();
    controller.abort();
    await expect(
      host.parse('typescript', 'const x = 1;', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.stats().dispatched).toBe(0);
  });

  it('mid-flight abort rejects with AbortError and the worker acks the cancel', async () => {
    const { host } = makeHost(150);
    await host.warm('typescript');
    const controller = new AbortController();
    const pending = host.parse('typescript', 'const x = 1;', { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // The cancel ack travels the control port, not the RPC port.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(host.stats().cancelled).toBe(1);
    expect(host.stats().cancelAcks).toBe(1);
  });

  it('worker death mid-request → located error; next parse gets a fresh worker', async () => {
    const { host, workers } = makeHost(500);
    await host.warm('python');
    const doomed = host.parse('python', 'x = 1\n');
    // Attach the expectation before the rejection fires so the reject never
    // sits unhandled across the terminate await.
    const doomedRejects = expect(doomed).rejects.toThrow('parse worker crashed mid-request');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await workers[0]!.terminate(); // kill the worker out from under the host
    await doomedRejects;
    const recovered = await host.parse('python', 'y = 2\n');
    expect(recovered.hasErrors).toBe(false);
    expect(workers).toHaveLength(2); // respawned
    expect(host.stats().crashes).toBe(1);
    expect(host.stats().respawns).toBe(1);
  });

  it('dispose rejects in-flight requests and further use throws', async () => {
    const { host } = makeHost(300);
    await host.warm('typescript');
    const orphan = host.parse('typescript', 'const x = 1;');
    const orphanRejects = expect(orphan).rejects.toThrow('disposed with request in flight');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await host.dispose();
    await orphanRejects;
    await expect(host.parse('typescript', 'const y = 2;')).rejects.toThrow('disposed');
  });
});
