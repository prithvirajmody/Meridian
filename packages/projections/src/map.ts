import {
  createFocusState,
  EMPTY_SELECTION,
  type FocusState,
  type NodeId,
  type ProjectionModel,
  type SelectionState,
} from '@meridian/view-model';
import type {
  NodeLinkSurface,
  ProjectionHost,
  ProjectionInstance,
  ProjectionViewState,
  ViewProjection,
} from './contracts.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copySelection(selection: SelectionState): SelectionState {
  return {
    nodes: [...selection.nodes],
    edges: [...selection.edges],
    ...(selection.anchor === undefined
      ? {}
      : selection.anchor.kind === 'node'
        ? { anchor: { kind: 'node' as const, id: selection.anchor.id } }
        : { anchor: { kind: 'edge' as const, key: selection.anchor.key } }),
  };
}

class MapProjectionInstance implements ProjectionInstance {
  private destroyed = false;
  private selection: SelectionState = EMPTY_SELECTION;
  private focus: FocusState = createFocusState();

  constructor(
    private readonly host: ProjectionHost,
    private readonly surface: NodeLinkSurface,
  ) {}

  private assertAlive(method: string): void {
    if (this.destroyed) {
      throw new Error(`projections: map.${method} called after destroy`);
    }
  }

  render(model: ProjectionModel): void {
    this.assertAlive('render');
    this.selection = copySelection(model.selection);
    this.focus = createFocusState(model.focus.node);
    if (model.renderModel === undefined) {
      const message = 'Map projection requires layout before it can render.';
      this.host.reportDiagnostic({
        projectionId: 'map',
        code: 'missing-render-model',
        phase: 'render',
        message,
      });
      this.host.showDegraded(message);
      return;
    }
    this.surface.render(model.renderModel);
  }

  applySelection(selection: SelectionState): void {
    this.assertAlive('applySelection');
    this.selection = copySelection(selection);
  }

  applyFocus(focus: FocusState): void {
    this.assertAlive('applyFocus');
    this.focus = createFocusState(focus.node);
  }

  revealFocus(): void {
    this.assertAlive('revealFocus');
    let target: NodeId | null = this.focus.node;
    if (target === null && this.selection.anchor?.kind === 'node') {
      target = this.selection.anchor.id;
    }
    this.surface.revealNode(target);
  }

  captureViewState(): ProjectionViewState {
    this.assertAlive('captureViewState');
    return this.surface.captureViewState();
  }

  restoreViewState(state: ProjectionViewState): void {
    this.assertAlive('restoreViewState');
    this.surface.restoreViewState(state);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.surface.destroy();
  }
}

/** Behavior-preserving adapter over the existing node-link scene medium. */
export class MapProjection implements ViewProjection {
  readonly id = 'map';
  readonly label = 'Map';

  suitability(model: ProjectionModel): number {
    return model.renderModel === undefined ? 0 : 1;
  }

  async mount(host: ProjectionHost): Promise<ProjectionInstance> {
    try {
      const surface = await host.nodeLink.mount();
      return new MapProjectionInstance(host, surface);
    } catch (error) {
      host.reportDiagnostic({
        projectionId: this.id,
        code: 'mount-failed',
        phase: 'mount',
        message: errorMessage(error),
      });
      throw error;
    }
  }
}

export const MAP_PROJECTION: ViewProjection = new MapProjection();
