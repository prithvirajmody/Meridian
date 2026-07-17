import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { encodeProjectBundle, type RawModule } from '@meridian/adapter-code';
import type { CodeMapper } from '@meridian/adapter-code/worker-host';
import { describe, expect, it } from 'vitest';
import { StudioSession } from '../src/studio-session.js';
import { createStudioStore, StudioStoreCommands } from '../src/store.js';

const CORPUS_ROOT = fileURLToPath(new URL('../../../fixtures/corpora/markdown/', import.meta.url));
const CORPORA = [
  'basic.md',
  'links.md',
  'commonmark-edges.md',
  'pathological-nesting.md',
  'no-headings.md',
  'empty.md',
] as const;

describe('StudioSession full pipeline', () => {
  for (const corpus of CORPORA) {
    it(`opens ${corpus} via sniff → gate/store → LOD → layout → RenderModel`, async () => {
      const store = createStudioStore();
      const session = new StudioSession(store);
      try {
        await session.openText(corpus, await readFile(`${CORPUS_ROOT}${corpus}`, 'utf8'));
        const state = store.getState();
        expect(state.phase, state.message).toBe('ready');
        expect(state.adapter).toMatchObject({ domain: 'markdown', plugin: '@meridian/adapter-markdown' });
        expect(state.graphVersion).toBe('v1');
        expect(state.renderModel).not.toBeNull();
        expect(state.projectionModel).not.toBeNull();
        expect(state.projectionModel?.renderModel).toBe(state.renderModel);
        expect(state.projectionModel?.nodes.map((node) => node.id).sort()).toEqual(
          [...(state.renderModel?.nodeIds ?? [])].sort(),
        );
        expect(state.renderModel?.diagnostics).toEqual([]);
        expect(state.ingestProgress?.emissions).toBeGreaterThanOrEqual(1);
        expect(state.ingestProgress?.appliedOps).toBeGreaterThan(0);
        expect(state.ingestProgress?.peakBufferedOps).toBeLessThanOrEqual(1024);
        if (corpus === 'empty.md') expect(state.renderModel?.nodeIds).toHaveLength(0);
      } finally {
        await session.destroy();
      }
    });
  }

  it('populates selected node attributes/provenance from the snapshot, then rebuilds flags', async () => {
    const store = createStudioStore();
    const session = new StudioSession(store);
    try {
      await session.openText('basic.md', await readFile(`${CORPUS_ROOT}basic.md`, 'utf8'));
      const before = store.getState().renderModel!;
      const nodeId = before.nodeIds[0]!;
      new StudioStoreCommands(store).select(
        { kind: 'node', nodeId, screen: { x: 10, y: 10 }, world: { x: 0, y: 0 } },
        100,
      );
      const state = store.getState();
      expect(state.panel).toMatchObject({ kind: 'node', id: nodeId });
      expect(state.panel?.provenance.origin).toBe('source');
      expect(state.renderModel?.revision).not.toBe(before.revision);
      expect(state.projectionModel?.renderModel).toBe(state.renderModel);
      expect(state.projectionModel?.selection).toEqual(state.selection);
      expect(state.hover).toBeNull();
    } finally {
      await session.destroy();
    }
  });

  it('reports an unsupported source as a located pipeline error', async () => {
    const store = createStudioStore();
    const session = new StudioSession(store);
    try {
      await session.openText('binary.dat', '\u0000bad');
      expect(store.getState().phase).toBe('error');
      expect(store.getState().diagnostics.at(-1)).toMatchObject({
        source: 'pipeline',
        code: 'open-failed',
      });
    } finally {
      await session.destroy();
    }
  });

  it('cancels a superseded code parse and cannot publish stale progress', async () => {
    let started!: () => void;
    const mapStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let parseSignal: AbortSignal | undefined;
    const mapper: CodeMapper = {
      mapModule: (_request, opts): Promise<RawModule> => {
        parseSignal = opts?.signal;
        started();
        return new Promise((_resolve, reject) => {
          if (parseSignal === undefined) {
            reject(new Error('Studio did not propagate an ingest cancellation signal'));
            return;
          }
          if (parseSignal.aborted) {
            reject(parseSignal.reason);
            return;
          }
          parseSignal.addEventListener('abort', () => reject(parseSignal?.reason), { once: true });
        });
      },
      resolveBody: async () => undefined,
      dispose: async () => undefined,
    };
    const store = createStudioStore();
    const session = new StudioSession(store, { codeMapper: mapper });
    try {
      const stale = session.openText(
        'stale.meridian-code-project',
        encodeProjectBundle({
          root: 'stale',
          files: [{ path: 'src/stale.ts', text: 'export const stale = true;\n' }],
        }),
      );
      await mapStarted;
      const current = session.openText('current.md', '# Current\n\nOnly this source may publish.');
      await Promise.all([stale, current]);

      expect(parseSignal?.aborted).toBe(true);
      expect(store.getState()).toMatchObject({
        phase: 'ready',
        adapter: { domain: 'markdown', plugin: '@meridian/adapter-markdown' },
        source: { name: 'current.md' },
      });
      expect(store.getState().diagnostics).toEqual([]);
      expect(store.getState().ingestProgress?.stage).not.toBe('map');
    } finally {
      await session.destroy();
    }
  });
});
