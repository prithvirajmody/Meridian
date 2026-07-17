/** Phase-11 code ingest: a million-line-equivalent monorepo is emitted as
 * dependency-safe bounded deltas when the host advertises backpressure. */
import { createHash } from 'node:crypto';
import { createGraphSpace, decode, encodeCanonical, type GraphDocument } from '@meridian/graph-core';
import { createStore, decodeDeltaInput } from '@meridian/graph-store';
import type { DeltaWire } from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import {
  CODE_PROJECT_MEDIA_TYPE,
  createCodePlugin,
  encodeProjectBundle,
  type CodeMapper,
} from '../src/index.js';
import { CODE_STREAM_OPS_PER_DELTA } from '../src/plugin.js';
import { testContext } from './support.js';

/** Pinned synthetic fixture v1: generation inputs + encoded-bundle checksum are
 * reviewed constants, so the scale gate cannot silently shrink. */
const SYNTHETIC_FIXTURE_ID = 'phase11-code-monorepo-1m-loc-v1';
const FILES = 1_000;
const LINES_PER_FILE = 1_000;
const FIXTURE_SHA256 = '158a80e54f69cd30e4a76fab2bbbb86a289be8530d21d05d181cd93b51b2e886';
/** Deliberately generous extra-heap ceiling for fixture decode + truth doc +
 * streamed store. Version it with the fixture if its shape legitimately grows. */
const MAX_HEAP_DELTA_BYTES = 256 * 1024 * 1024;
const MILLION_LOC_BUNDLE = encodeProjectBundle({
  root: 'synthetic-monorepo',
  files: Array.from({ length: FILES }, (_, index) => ({
    path: `packages/p${String(index).padStart(4, '0')}/src/index.ts`,
    text: '// synthetic\n'.repeat(LINES_PER_FILE),
  })),
});

/** Parsing correctness is covered by the grammar suites. This scale test uses
 * the mapper seam to isolate document construction, delta batching, and drain. */
const mapper: CodeMapper = {
  async mapModule(request) {
    return {
      source: request.source,
      language: request.language,
      label: request.label,
      span: [0, request.text.length],
      decls: [],
      imports: [],
      hasErrors: false,
      errorCount: 0,
    };
  },
  async resolveBody() {
    return undefined;
  },
  async dispose() {},
};

describe('code adapter streaming backpressure', () => {
  it('streams a deterministic 1M-LOC monorepo with a bounded peak op queue', async () => {
    (globalThis as { gc?: () => void }).gc?.();
    const heapBaseline = process.memoryUsage().heapUsed;
    let peakHeap = heapBaseline;
    const sampleHeap = (): void => {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    };
    expect(SYNTHETIC_FIXTURE_ID).toBe('phase11-code-monorepo-1m-loc-v1');
    expect(createHash('sha256').update(MILLION_LOC_BUNDLE).digest('hex')).toBe(FIXTURE_SHA256);

    const parser = createCodePlugin({ mapper }).activate(testContext()).parsers![0]!;
    const source = {
      uri: 'synthetic-monorepo',
      mediaType: CODE_PROJECT_MEDIA_TYPE,
      text: MILLION_LOC_BUNDLE,
    };

    const documents: GraphDocument[] = [];
    await parser.ingest(source, {
      emitDocument: (document) => documents.push(document),
      emitDelta: () => undefined,
      progress: sampleHeap,
    });
    sampleHeap();
    expect(documents).toHaveLength(1);
    const expected = decode(documents[0]!);
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;

    const store = createStore(createGraphSpace());
    let pending: DeltaWire[] = [];
    let pendingOps = 0;
    let peakBufferedOps = 0;
    let maxEnvelopeOps = 0;
    let progressSinceDrain = 0;
    let maxProgressSinceDrain = 0;
    let drains = 0;

    await parser.ingest(source, {
      emitDocument: () => {
        throw new Error('streaming code ingest must emit deltas, not a monolithic document');
      },
      emitDelta: (wire) => {
        pending.push(wire);
        pendingOps += wire.ops.length;
        peakBufferedOps = Math.max(peakBufferedOps, pendingOps);
        maxEnvelopeOps = Math.max(maxEnvelopeOps, wire.ops.length);
        sampleHeap();
      },
      progress: () => {
        progressSinceDrain += 1;
        sampleHeap();
      },
      drain: async () => {
        drains += 1;
        maxProgressSinceDrain = Math.max(maxProgressSinceDrain, progressSinceDrain);
        progressSinceDrain = 0;
        const accepted = pending;
        pending = [];
        pendingOps = 0;
        for (const wire of accepted) {
          const decoded = decodeDeltaInput(wire);
          expect(decoded.ok).toBe(true);
          if (!decoded.ok) continue;
          const applied = store.apply(decoded.delta);
          expect(applied.ok).toBe(true);
          sampleHeap();
        }
      },
    });

    expect(drains).toBeGreaterThan(30);
    expect(maxProgressSinceDrain).toBeLessThanOrEqual(33); // initial + 32 files
    expect(maxEnvelopeOps).toBeLessThanOrEqual(CODE_STREAM_OPS_PER_DELTA);
    expect(peakBufferedOps).toBeLessThanOrEqual(CODE_STREAM_OPS_PER_DELTA);
    expect(peakHeap - heapBaseline).toBeLessThanOrEqual(MAX_HEAP_DELTA_BYTES);
    console.log(
      `[11E] ${SYNTHETIC_FIXTURE_ID}: ${FILES * LINES_PER_FILE} LOC · ` +
        `peak buffered ${peakBufferedOps} ops · heap delta ${((peakHeap - heapBaseline) / 1024 / 1024).toFixed(1)} MiB ` +
        `(ceiling ${MAX_HEAP_DELTA_BYTES / 1024 / 1024} MiB)`,
    );
    expect(encodeCanonical(store.snapshot())).toBe(encodeCanonical(expected.space));
  }, 30_000);
});
