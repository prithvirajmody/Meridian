import { describe, expect, it } from 'vitest';
import { queryQuadtree } from '../src/quadtree.js';
import { buildSpatialIndex } from '../src/spatial-index/build.js';
import {
  SpatialIndexHost,
  type SpatialIndexWorkerEndpoint,
} from '../src/spatial-index/host.js';
import {
  spatialIndexRequestTransfer,
  spatialIndexResponseTransfer,
  type SpatialIndexBuildRequest,
  type SpatialIndexWorkerRequest,
} from '../src/spatial-index/protocol.js';

class ControlledWorker implements SpatialIndexWorkerEndpoint {
  readonly posted: Array<{
    readonly message: SpatialIndexWorkerRequest;
    readonly transfer: readonly ArrayBuffer[];
  }> = [];
  terminated = false;
  private messageListener: (message: unknown) => void = () => undefined;
  private errorListener: (error: unknown) => void = () => undefined;

  postMessage(
    message: SpatialIndexWorkerRequest,
    transfer: readonly ArrayBuffer[] = [],
  ): void {
    this.posted.push({ message, transfer });
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListener = listener;
    return (): void => {
      this.messageListener = () => undefined;
    };
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListener = listener;
    return (): void => {
      this.errorListener = () => undefined;
    };
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(message: unknown): void {
    this.messageListener(message);
  }

  fail(error: unknown): void {
    this.errorListener(error);
  }
}

function request(
  requestId: number,
  revision = `revision-${requestId}`,
): SpatialIndexBuildRequest {
  return {
    type: 'build',
    requestId,
    modelRevision: revision,
    nodeRects: new Float64Array([
      0, 0, 10, 10,
      20, 20, 5, 5,
    ]),
    edgeSegments: new Float64Array([5, 5, 22.5, 22.5]),
  };
}

describe('spatial-index worker protocol', () => {
  it('builds packed node/edge trees and transfers every geometry buffer', () => {
    const input = request(7);
    expect(spatialIndexRequestTransfer(input)).toEqual([
      input.nodeRects.buffer,
      input.edgeSegments.buffer,
    ]);

    const response = buildSpatialIndex(input);
    expect(response).toMatchObject({
      type: 'built',
      requestId: 7,
      modelRevision: 'revision-7',
    });
    expect(
      queryQuadtree(response.nodeTree, { minX: 10, minY: 10, maxX: 10, maxY: 10 }),
    ).toEqual(new Uint32Array([0]));
    expect(
      queryQuadtree(response.edgeTree, { minX: 12, minY: 12, maxX: 12, maxY: 12 }),
    ).toEqual(new Uint32Array([0]));

    const returned = spatialIndexResponseTransfer(response);
    expect(returned).toHaveLength(10);
    expect(new Set(returned).size).toBe(10);
    expect(returned).toContain(response.nodeTree.nodeBounds.buffer);
    expect(returned).toContain(response.edgeTree.itemIndices.buffer);
  });

  it('rejects malformed geometry inside the worker-side pure build', () => {
    expect(() =>
      buildSpatialIndex({
        ...request(1),
        nodeRects: new Float64Array([0, 0, -1, 1]),
      }),
    ).toThrow('dimensions must be non-negative');
    expect(() =>
      buildSpatialIndex({
        ...request(1),
        edgeSegments: new Float64Array([0, 0, 1]),
      }),
    ).toThrow('complete four-lane records');
  });
});

describe('SpatialIndexHost latest-request semantics', () => {
  it('supersedes the pending request and drops its late response by request id', async () => {
    const worker = new ControlledWorker();
    const host = new SpatialIndexHost({ factory: () => worker });
    const firstInput = request(99, 'old');
    const first = host.build(firstInput);

    const firstPosted = worker.posted[0]!;
    expect(firstPosted.message).toMatchObject({ type: 'build', requestId: 1 });
    expect(firstPosted.transfer).toEqual([
      firstInput.nodeRects.buffer,
      firstInput.edgeSegments.buffer,
    ]);

    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const secondInput = request(99, 'new');
    const second = host.build(secondInput);
    await firstRejected;

    expect(worker.posted.map(({ message }) => [message.type, message.requestId])).toEqual([
      ['build', 1],
      ['cancel', 1],
      ['build', 2],
    ]);

    worker.respond(buildSpatialIndex({ ...firstInput, type: 'build', requestId: 1 }));
    expect(host.snapshotFor('old')).toBeNull();
    expect(host.stats().staleResponses).toBe(1);

    worker.respond(buildSpatialIndex({ ...secondInput, type: 'build', requestId: 2 }));
    const ready = await second;
    expect(ready).toMatchObject({ requestId: 2, modelRevision: 'new' });
    expect(host.snapshotFor('old')).toBeNull();
    expect(host.snapshotFor('new')).toBe(ready);
    expect(host.stats()).toMatchObject({
      dispatched: 2,
      completed: 1,
      superseded: 1,
      staleResponses: 1,
    });

    await host.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('cancels via AbortSignal and treats a later result as stale', async () => {
    const worker = new ControlledWorker();
    const host = new SpatialIndexHost({ factory: () => worker });
    const controller = new AbortController();
    const input = request(1, 'aborted');
    const pending = host.build(input, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.posted.map(({ message }) => message.type)).toEqual(['build', 'cancel']);
    worker.respond(buildSpatialIndex({ ...input, requestId: 1 }));
    expect(host.snapshotFor('aborted')).toBeNull();
    expect(host.stats()).toMatchObject({ aborted: 1, staleResponses: 1 });
    await host.dispose();
  });
});
