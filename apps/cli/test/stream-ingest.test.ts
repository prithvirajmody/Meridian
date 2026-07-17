/** CLI Phase-11 stream composition: host → bounded private store → IR gate. */
import { encodeCanonical } from '@meridian/graph-core';
import type { StorageBackend } from '@meridian/graph-store';
import {
  PLUGIN_API_VERSION,
  type MeridianPlugin,
  type PluginContext,
} from '@meridian/plugin-api';
import { createPluginHost } from '@meridian/plugin-host';
import { describe, expect, it } from 'vitest';
import { materializeStreamedSource } from '../src/stream-ingest.js';

const GRAPH_COUNT = 4_096;
const EMISSION_OPS = 511;

function ids(): PluginContext['ids'] {
  const id = (coordinates: { readonly domain: string; readonly source: string; readonly path: readonly string[] }) =>
    `${coordinates.domain}:${coordinates.source}:${coordinates.path.join('/')}`;
  return {
    nodeId: id,
    graphId: id,
    edgeId: ({ graph, kind, src, dst, occurrence }) =>
      `${graph}:${kind}:${src}:${dst}:${occurrence ?? 0}`,
  };
}

function syntheticPlugin(graphs = GRAPH_COUNT): MeridianPlugin {
  return {
    manifest: {
      name: '@meridian/test-million-loc',
      version: '1.0.0',
      apiVersion: `^${PLUGIN_API_VERSION}`,
      capabilities: [{ kind: 'domain-parser', id: 'synthetic-code' }],
      kinds: [],
      attrSchemas: {},
    },
    activate: () => ({
      parsers: [{
        domain: 'synthetic-code',
        sniff: () => 1,
        ingest: async (_source, sink) => {
          sink.progress({ stage: 'map', done: 0, total: graphs });
          for (let offset = 0; offset < graphs; offset += EMISSION_OPS) {
            const end = Math.min(graphs, offset + EMISSION_OPS);
            const ops = Array.from({ length: end - offset }, (_, local) => {
              const index = offset + local;
              return {
                t: 'graph:add',
                graph: `g-file-${String(index).padStart(5, '0')}`,
                meta: {
                  label: `packages/p${Math.floor(index / 32)}/file-${index}.ts`,
                  domain: 'synthetic-code',
                  provenance: { origin: 'source', uri: `repo/file-${index}.ts` },
                },
              };
            });
            sink.emitDelta({ ops, origin: { actor: 'synthetic-1m-loc' } });
            sink.progress({ stage: 'map', done: end, total: graphs });
            await sink.drain?.();
          }
        },
      }],
    }),
  };
}

function host(graphs = GRAPH_COUNT) {
  const value = createPluginHost({ ids: ids() });
  const registered = value.register(syntheticPlugin(graphs));
  expect(registered.ok).toBe(true);
  return value;
}

describe('CLI streamed materialization', () => {
  it('deterministically ingests a 1M-LOC-style monorepo with bounded staged ops', async () => {
    const progress: number[] = [];
    const run = () => materializeStreamedSource(
      host(),
      { uri: 'synthetic://1m-loc-monorepo', mediaType: 'application/x.synthetic-code' },
      {
        maxOpsPerBatch: 64,
        onParserProgress: (event) => {
          progress.push(event.done);
        },
      },
    );

    const first = await run();
    const second = await run();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.materialized.space.graphs.size).toBe(GRAPH_COUNT);
    expect(first.stageStats.inputOps).toBe(GRAPH_COUNT);
    expect(first.stageStats.peakBufferedOps).toBe(64);
    expect(first.stageStats.appliedOps).toBe(GRAPH_COUNT);
    expect(first.outcome.report.deltas).toBe(Math.ceil(GRAPH_COUNT / EMISSION_OPS));
    expect(progress).toContain(GRAPH_COUNT);
    expect(encodeCanonical(second.materialized.space)).toBe(encodeCanonical(first.materialized.space));
  }, 30_000);

  it('withholds staging and reports a durable ENOSPC-style backend failure', async () => {
    const backend = {
      async loadGraph() {
        return null;
      },
      async appendOps() {
        const error = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        throw error;
      },
      async persist() {},
      evictHint() {},
    } satisfies StorageBackend;

    const result = await materializeStreamedSource(
      host(1),
      { uri: 'synthetic://disk-full' },
      { backend, maxOpsPerBatch: 1 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('stage');
    expect(result.stageFailure?.code).toBe('storage-failed');
    expect(result.message).toContain('ENOSPC');
    expect('materialized' in result).toBe(false);
  });
});
