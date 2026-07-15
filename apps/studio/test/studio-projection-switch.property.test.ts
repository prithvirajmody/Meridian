import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAP_PROJECTION,
  type ProjectionHost,
  type ProjectionInstance,
  type ProjectionViewState,
  type ViewProjection,
} from '@meridian/projections';
import { EMPTY_FOCUS, EMPTY_SELECTION, type ProjectionModel } from '@meridian/view-model';
import { createPerformanceRenderModel } from '../src/performance-fixtures.js';
import {
  StudioProjectionCoordinator,
  type StudioMapBridge,
} from '../src/studio-projection-host.js';
import { createStudioStore } from '../src/store.js';
import type { RenderModel } from '@meridian/view-model';

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent: string | null = null;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

class FakeBridge implements StudioMapBridge {
  viewState: ProjectionViewState = { camera: { center: { x: 0, y: 0 }, scale: 1 } };
  mount(): Promise<void> {
    return Promise.resolve();
  }
  acceptSettledModel(): void {}
  renderTransient(): void {}
  captureViewState(): ProjectionViewState {
    return this.viewState;
  }
  restoreViewState(state: ProjectionViewState): void {
    this.viewState = state;
  }
  revealNode(): void {}
  viewportSize(): { width: number; height: number } {
    return { width: 800, height: 600 };
  }
  fit(): void {}
  zoomBy(): void {}
  setScale(): void {}
  screenPointForNode(): { x: number; y: number } | null {
    return null;
  }
  async runFrameProbe(): Promise<never> {
    throw new Error('not used');
  }
  loseContext(): boolean {
    return false;
  }
  restoreContext(): boolean {
    return false;
  }
  destroy(): void {}
}

function projectionModel(renderModel: RenderModel): ProjectionModel {
  return {
    cutLevel: 0,
    nodes: [],
    inducedEdges: [],
    selection: EMPTY_SELECTION,
    focus: EMPTY_FOCUS,
    domainMeta: { domain: 'test', label: 'Test' },
    diagnostics: [],
    renderModel,
  };
}

interface SwitchWorld {
  readonly violations: string[];
  /** Live (mounted, not destroyed) instances per projection id. */
  readonly live: Map<string, number>;
  /** Last view state each id's active incarnation captured. */
  readonly captured: Map<string, ProjectionViewState>;
}

/**
 * A stateful fake projection: every incarnation captures a unique view state
 * and asserts that a restore hands back exactly what its predecessor
 * captured (ADR-0036 per-projection view-state survival). Lifecycle misuse
 * (calls after destroy, double destroy) is recorded as a violation.
 */
function statefulProjection(id: string, world: SwitchWorld): ViewProjection {
  let captureCounter = 0;
  return {
    id,
    label: id,
    suitability: () => 0.5,
    mount: async (_host: ProjectionHost): Promise<ProjectionInstance> => {
      await Promise.resolve();
      let destroyed = false;
      const guard = (method: string): void => {
        if (destroyed) world.violations.push(`${id}.${method} called after destroy`);
      };
      world.live.set(id, (world.live.get(id) ?? 0) + 1);
      return {
        render: () => guard('render'),
        applySelection: () => guard('applySelection'),
        applyFocus: () => guard('applyFocus'),
        revealFocus: () => guard('revealFocus'),
        captureViewState: () => {
          guard('captureViewState');
          const state = { id, capture: ++captureCounter };
          world.captured.set(id, state);
          return state;
        },
        restoreViewState: (state) => {
          guard('restoreViewState');
          const expected = world.captured.get(id);
          if (JSON.stringify(state) !== JSON.stringify(expected)) {
            world.violations.push(
              `${id} restored ${JSON.stringify(state)} but last captured ${JSON.stringify(expected)}`,
            );
          }
        },
        destroy: () => {
          if (destroyed) {
            world.violations.push(`${id}.destroy called twice`);
            return;
          }
          destroyed = true;
          world.live.set(id, (world.live.get(id) ?? 0) - 1);
        },
      };
    },
  };
}

const TARGETS = ['map', 'outline', 'matrix', 'timeline', 'bomb'] as const;

describe('random projection switch sequences (ADR-0036 property)', () => {
  it('always converges on the final request, preserves identity, and round-trips view state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            target: fc.constantFrom(...TARGETS),
            awaited: fc.boolean(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (steps) => {
          const world: SwitchWorld = { violations: [], live: new Map(), captured: new Map() };
          const store = createStudioStore();
          const selection = {
            nodes: ['held' as never],
            edges: ['a→b→k'],
            anchor: { kind: 'node' as const, id: 'held' as never },
          };
          store.setState({ selection });
          store.setState({
            projectionModel: {
              ...projectionModel(createPerformanceRenderModel(2)),
              selection,
            },
          });
          const focus = { node: 'focused' as never };
          const bomb: ViewProjection = {
            id: 'bomb',
            label: 'Bomb',
            suitability: () => 1,
            mount: async () => {
              await Promise.resolve();
              throw new Error('bomb projection always fails to mount');
            },
          };
          const element = new FakeElement(new FakeDocument(), 'div');
          const coordinator = new StudioProjectionCoordinator(
            element as unknown as HTMLElement,
            store,
            {
              projections: [
                MAP_PROJECTION,
                statefulProjection('outline', world),
                statefulProjection('matrix', world),
                statefulProjection('timeline', world),
                bomb,
              ],
              bridgeFactory: () => new FakeBridge(),
              focus: () => focus,
            },
          );

          const pending: Promise<void>[] = [];
          for (const step of steps) {
            const promise = coordinator.switchProjection(step.target);
            pending.push(promise);
            if (step.awaited) await promise;
          }
          await Promise.all(pending);
          await new Promise((resolve) => setTimeout(resolve, 0));

          const last = steps.at(-1)!.target;
          const expected = last === 'bomb' ? 'map' : last;
          expect(coordinator.activeId()).toBe(expected);
          expect(store.getState().projectionId).toBe(expected);

          // Identity state survives every switch untouched, by reference.
          expect(store.getState().selection).toBe(selection);

          // Exactly the active instance is alive; nothing leaked or double-died.
          expect(world.violations).toEqual([]);
          for (const [id, count] of world.live) {
            expect(
              count,
              `live instances of ${id} with active=${coordinator.activeId()}`,
            ).toBe(id === coordinator.activeId() ? 1 : 0);
          }

          coordinator.destroy();
          for (const [id, count] of world.live) {
            expect(count, `live instances of ${id} after destroy`).toBe(0);
          }
          expect(world.violations).toEqual([]);
          expect(store.getState().projectionId).toBeNull();
        },
      ),
      { numRuns: 60 },
    );
  }, 30_000);
});
