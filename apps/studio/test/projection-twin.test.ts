/**
 * ADR-0037 structural-twin pin: a projection authored purely against
 * `@meridian/plugin-api` types must be assignable to the internal
 * `ViewProjection` contract, and the internal host must satisfy the public
 * facade. If either shape drifts, this file stops compiling.
 */
import { describe, expect, it } from 'vitest';
import type {
  ProjectionModelView,
  ProjectionSelection,
  ViewProjectionExport,
  ViewProjectionHost,
  ViewProjectionInstance,
} from '@meridian/plugin-api';
import type {
  ProjectionHost,
  ProjectionViewState,
  ViewProjection,
} from '@meridian/projections';
import { EMPTY_FOCUS, EMPTY_SELECTION, type ProjectionModel } from '@meridian/view-model';
import { createPerformanceRenderModel } from '../src/performance-fixtures.js';
import { StudioProjectionCoordinator } from '../src/studio-projection-host.js';
import { createStudioStore, StudioStoreCommands } from '../src/store.js';

// ----------------------------------------------------- compile-time pins

/** Public-authored projections bridge into the internal registry. */
export function pinExportAssignableToInternal(exported: ViewProjectionExport): ViewProjection {
  return exported;
}

/** The internal host satisfies the capability-scoped public facade. */
export function pinInternalHostSatisfiesFacade(host: ProjectionHost): ViewProjectionHost {
  return host;
}

/** The internal model satisfies the public model slice. */
export function pinInternalModelSatisfiesSlice(model: ProjectionModel): ProjectionModelView {
  return model;
}

// ------------------------------------------------------- runtime bridge

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

/** A minimal plugin-authored projection: consumes the public model slice and
 * the projection-neutral intents; mounts no medium (data-only smoke). */
function pluginAuthoredProjection(seen: {
  models: ProjectionModelView[];
  selections: ProjectionSelection[];
}): ViewProjectionExport {
  return {
    id: 'plugin-smoke',
    label: 'Plugin smoke',
    suitability: (model) => (model.nodes.length > 0 ? 0.25 : 0),
    mount: async (host: ViewProjectionHost): Promise<ViewProjectionInstance> => {
      host.now();
      host.viewport();
      let state: ProjectionViewState = null;
      return {
        render: (model) => {
          seen.models.push(model);
        },
        applySelection: (selection) => {
          seen.selections.push(selection);
        },
        applyFocus: () => undefined,
        revealFocus: () => undefined,
        captureViewState: () => state,
        restoreViewState: (next) => {
          state = next;
        },
        destroy: () => undefined,
      };
    },
  };
}

describe('view-projection structural twin (ADR-0037)', () => {
  it('a plugin-authored projection mounts through the real coordinator and receives the model', async () => {
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    const renderModel = createPerformanceRenderModel(2);
    commands.setProjectionModel({
      cutLevel: 0,
      nodes: [],
      inducedEdges: [],
      selection: EMPTY_SELECTION,
      focus: EMPTY_FOCUS,
      domainMeta: { domain: 'test', label: 'Test' },
      diagnostics: [],
      renderModel,
    });
    const seen: { models: ProjectionModelView[]; selections: ProjectionSelection[] } = {
      models: [],
      selections: [],
    };
    const element = new FakeElement(new FakeDocument(), 'div');
    const coordinator = new StudioProjectionCoordinator(
      element as unknown as HTMLElement,
      store,
      { projections: [] },
    );
    coordinator.registerProjection(pluginAuthoredProjection(seen));

    await coordinator.switchProjection('plugin-smoke');

    expect(coordinator.activeId()).toBe('plugin-smoke');
    expect(store.getState().projectionId).toBe('plugin-smoke');
    expect(seen.models).toHaveLength(1);
    expect(seen.models[0]!.domainMeta).toEqual({ domain: 'test', label: 'Test' });
    expect(seen.selections.at(-1)).toEqual(EMPTY_SELECTION);
    coordinator.destroy();
  });
});
