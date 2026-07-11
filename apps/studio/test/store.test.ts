import { describe, expect, it } from 'vitest';
import { createPerformanceRenderModel } from '../src/performance-fixtures.js';
import { createStudioStore, StudioStoreCommands } from '../src/store.js';

describe('Studio Zustand value store', () => {
  it('starts a new open generation with serializable values and clears transients', () => {
    const store = createStudioStore(true);
    const commands = new StudioStoreCommands(store);
    commands.beginOpen({ generation: 1, name: 'a.md', bytes: 10 });
    commands.setHover(
      4,
      {
        kind: 'node',
        nodeId: 'node-a' as never,
        screen: { x: 1, y: 2 },
        world: { x: 3, y: 4 },
      },
      5,
    );
    commands.beginOpen({ generation: 2, name: 'b.md', bytes: 20 });

    const state = store.getState();
    expect(state.source).toEqual({ generation: 2, name: 'b.md', bytes: 20 });
    expect(state.hover).toBeNull();
    expect(state.renderModel).toBeNull();
    expect(state.debugEnabled).toBe(true);
    expect(state.phase).toBe('reading');
  });

  it('ignores a stale pipeline failure', () => {
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    commands.beginOpen({ generation: 2, name: 'current.md', bytes: 1 });
    commands.fail(1, 'stale', 'old failure');
    expect(store.getState().phase).toBe('reading');
    expect(store.getState().diagnostics).toEqual([]);
  });

  it('keeps hover generation-scoped and clears it on model replacement', () => {
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    commands.beginOpen({ generation: 1, name: 'fixture', bytes: 0 });
    commands.setHover(
      7,
      {
        kind: 'node',
        nodeId: 'perf:node:00000' as never,
        screen: { x: 0, y: 0 },
        world: { x: 0, y: 0 },
      },
      10,
    );
    commands.clearHover(6);
    expect(store.getState().hover?.sceneGeneration).toBe(7);
    commands.publishModel(createPerformanceRenderModel(2), 'v1', 12, 'ready');
    expect(store.getState().hover).toBeNull();
  });

  it('turns renderer selection into identity-based SelectionState', () => {
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    commands.select(
      {
        kind: 'node',
        nodeId: 'n-selected' as never,
        screen: { x: 10, y: 12 },
        world: { x: 2, y: 3 },
      },
      42,
    );
    expect(store.getState().selection).toEqual({
      nodes: ['n-selected'],
      edges: [],
      anchor: { kind: 'node', id: 'n-selected' },
    });
    expect(store.getState().selectionStartedAtMs).toBe(42);
  });

  it('records first-frame and panel-commit latency as values', () => {
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    commands.beginOpen({ generation: 1, name: 'fixture', bytes: 0 });
    commands.publishModel(createPerformanceRenderModel(2), 'v1', 100, 'ready');
    commands.rendererFrame(
      {
        frameTimeMs: 2,
        drawCalls: 1,
        frameCount: 1,
        modelNodes: 4,
        candidateNodes: 4,
        visibleNodes: 4,
        culledNodes: 0,
        modelEdges: 2,
        visibleEdges: 2,
        culledEdges: 0,
        modelEdgeSegments: 2,
        candidateEdgeSegments: 2,
        visibleEdgeSegments: 2,
        submittedNodeBatches: 1,
        submittedEdgeBatches: 1,
        liveLabels: 1,
        bitmapLabelCount: 1,
        fallbackLabelCount: 0,
        omittedLabelCount: 0,
        pickQueryTimeMs: 0.01,
        contextLosses: 0,
        bufferUploadBytes: 100,
      },
      112,
    );
    commands.select(
      {
        kind: 'node',
        nodeId: 'perf:node:00000' as never,
        screen: { x: 0, y: 0 },
        world: { x: 0, y: 0 },
      },
      200,
    );
    commands.recordInteractionCommitted(200, 207.5);
    expect(store.getState().metrics.firstRenderMs).toBe(12);
    expect(store.getState().metrics.interactionLatencyMs).toBe(7.5);
  });
});
