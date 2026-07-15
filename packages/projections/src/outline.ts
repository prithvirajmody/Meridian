import {
  createFocusState,
  EMPTY_SELECTION,
  type FocusState,
  type NodeId,
  type ProjectionModel,
  type SelectionState,
} from '@meridian/view-model';
import type {
  ProjectionHost,
  ProjectionInstance,
  ProjectionViewState,
  ViewProjection,
  VirtualListFrame,
  VirtualListInput,
  VirtualListKey,
  VirtualListRow,
  VirtualListSurface,
} from './contracts.js';

const EMPTY_MESSAGE = 'No visible nodes in this cut.';

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOrderPath(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
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

function isRecord(value: ProjectionViewState): value is {
  readonly [key: string]: ProjectionViewState;
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class OutlineProjectionInstance implements ProjectionInstance {
  private destroyed = false;
  private rows: readonly VirtualListRow[] = [];
  private selection: SelectionState = EMPTY_SELECTION;
  private focus: FocusState = createFocusState();
  private activeNodeId: NodeId | null = null;
  private priorActiveParent: NodeId | null = null;
  private restoredActive = false;
  private revision = 0;

  constructor(
    private readonly host: ProjectionHost,
    private readonly surface: VirtualListSurface,
  ) {}

  private assertAlive(method: string): void {
    if (this.destroyed) throw new Error(`projections: outline.${method} called after destroy`);
  }

  render(model: ProjectionModel): void {
    this.assertAlive('render');
    const previousRows = this.rows;
    const previousActive = this.activeNodeId;
    this.selection = copySelection(model.selection);
    this.focus = createFocusState(model.focus.node);

    const ordered = [...model.nodes].sort(
      (left, right) =>
        compareOrderPath(left.orderPath, right.orderPath) || compareString(left.id, right.id),
    );
    const depths = ordered
      .map((node) => node.depth)
      .filter((depth): depth is number => depth !== null && Number.isFinite(depth));
    const minimumDepth = depths.reduce((minimum, depth) => Math.min(minimum, depth), Infinity);
    const normalizedMinimumDepth = Number.isFinite(minimumDepth) ? minimumDepth : 0;
    this.rows = ordered.map((node): VirtualListRow => ({
      key: node.id,
      nodeId: node.id,
      parentId: node.parentId,
      label: node.label,
      kind: node.kind,
      depth: Math.max(0, (node.depth ?? normalizedMinimumDepth) - normalizedMinimumDepth),
      expandable: node.detailGraphId !== null,
      expanded: false,
      coveredLeaves: node.coveredLeaves,
    }));

    this.priorActiveParent =
      previousRows.find((row) => row.nodeId === previousActive)?.parentId ?? null;
    const restoredWasStale =
      this.restoredActive &&
      previousActive !== null &&
      !this.rows.some((row) => row.nodeId === previousActive);
    this.activeNodeId = this.reconcileActive(previousActive);
    if (restoredWasStale) {
      this.host.reportDiagnostic({
        projectionId: 'outline',
        code: 'invalid-view-state',
        phase: 'view-state',
        message: `Saved active row "${previousActive}" is not visible; a deterministic fallback was used.`,
      });
    }
    this.restoredActive = false;
    this.publish();
  }

  applySelection(selection: SelectionState): void {
    this.assertAlive('applySelection');
    this.selection = copySelection(selection);
    if (this.rows.length > 0) this.publish();
  }

  applyFocus(focus: FocusState): void {
    this.assertAlive('applyFocus');
    this.focus = createFocusState(focus.node);
    if (this.rows.length > 0) this.publish();
  }

  revealFocus(): void {
    this.assertAlive('revealFocus');
    const target = this.visibilityTarget();
    if (target !== null) this.surface.revealNode(target);
  }

  captureViewState(): ProjectionViewState {
    this.assertAlive('captureViewState');
    const state = this.surface.captureViewState();
    const scrollTop = isRecord(state) ? state['scrollTop'] : undefined;
    return {
      version: 1,
      scrollTop:
        typeof scrollTop === 'number' && Number.isFinite(scrollTop) && scrollTop >= 0
          ? scrollTop
          : 0,
      activeNodeId: this.activeNodeId,
    };
  }

  restoreViewState(state: ProjectionViewState): void {
    this.assertAlive('restoreViewState');
    const scrollTop = isRecord(state) ? state['scrollTop'] : undefined;
    const version = isRecord(state) ? state['version'] : undefined;
    const activeNodeId = isRecord(state) ? state['activeNodeId'] : undefined;
    if (
      version !== 1 ||
      typeof scrollTop !== 'number' ||
      !Number.isFinite(scrollTop) ||
      scrollTop < 0 ||
      !(activeNodeId === null || typeof activeNodeId === 'string')
    ) {
      this.host.reportDiagnostic({
        projectionId: 'outline',
        code: 'invalid-view-state',
        phase: 'view-state',
        message: 'Saved outline view state was malformed and has been reset.',
      });
      this.activeNodeId = null;
      this.restoredActive = false;
      this.surface.restoreViewState({ scrollTop: 0 });
      return;
    }
    this.activeNodeId = activeNodeId as NodeId | null;
    this.restoredActive = activeNodeId !== null;
    this.surface.restoreViewState({ scrollTop });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.surface.destroy();
  }

  private reconcileActive(previous: NodeId | null): NodeId | null {
    const visible = (id: NodeId | null): id is NodeId =>
      id !== null && this.rows.some((row) => row.nodeId === id);
    if (visible(previous)) return previous;
    if (previous !== null) {
      const firstChild = this.rows.find((row) => row.parentId === previous)?.nodeId;
      if (firstChild !== undefined) return firstChild;
    }
    if (visible(this.priorActiveParent)) return this.priorActiveParent;
    if (visible(this.focus.node)) return this.focus.node;
    const anchor = this.selection.anchor;
    if (anchor?.kind === 'node' && visible(anchor.id)) return anchor.id;
    return this.rows[0]?.nodeId ?? null;
  }

  private visibilityTarget(): NodeId | null {
    if (this.focus.node !== null && this.rows.some((row) => row.nodeId === this.focus.node)) {
      return this.focus.node;
    }
    const anchor = this.selection.anchor;
    if (anchor?.kind === 'node' && this.rows.some((row) => row.nodeId === anchor.id)) {
      return anchor.id;
    }
    return null;
  }

  private publish(): void {
    const frame: VirtualListFrame = {
      revision: `outline-${++this.revision}`,
      rows: this.rows,
      selection: this.selection,
      focus: this.focus,
      activeNodeId: this.activeNodeId,
      emptyMessage: this.rows.length === 0 ? EMPTY_MESSAGE : null,
    };
    this.surface.render(frame);
  }

  private readonly input = (input: VirtualListInput): void => {
    if (this.destroyed) return;
    if (input.type === 'activate') {
      if (!this.rows.some((row) => row.nodeId === input.nodeId)) return;
      this.activeNodeId = input.nodeId;
      this.publish();
      this.host.selectNode(input.nodeId, 'replace');
      return;
    }
    if (input.type === 'toggle') {
      const row = this.rows.find((candidate) => candidate.nodeId === input.nodeId);
      if (row?.expandable === true) {
        this.activeNodeId = row.nodeId;
        this.host.navigate({ kind: 'expand', nodeId: row.nodeId });
      }
      return;
    }
    this.key(input.key);
  };

  private key(key: VirtualListKey): void {
    if (this.rows.length === 0) return;
    let index = this.rows.findIndex((row) => row.nodeId === this.activeNodeId);
    if (index < 0) index = 0;
    if (key === 'ArrowUp') index = Math.max(0, index - 1);
    else if (key === 'ArrowDown') index = Math.min(this.rows.length - 1, index + 1);
    else if (key === 'Home') index = 0;
    else if (key === 'End') index = this.rows.length - 1;
    else if (key === 'ArrowRight') {
      const row = this.rows[index]!;
      if (row.expandable) this.host.navigate({ kind: 'expand', nodeId: row.nodeId });
      return;
    } else if (key === 'ArrowLeft') {
      const parentId = this.rows[index]!.parentId;
      if (parentId !== null) this.host.navigate({ kind: 'collapse', nodeId: parentId });
      return;
    } else if (key === 'Enter' || key === ' ') {
      this.host.selectNode(this.rows[index]!.nodeId, 'replace');
      return;
    }
    this.activeNodeId = this.rows[index]!.nodeId;
    this.publish();
    this.surface.revealNode(this.activeNodeId);
  }

  /** Passed during async mount before the instance itself is returned. */
  static inputSink(instance: { current: OutlineProjectionInstance | null }): (input: VirtualListInput) => void {
    return (input) => instance.current?.input(input);
  }
}

export class OutlineProjection implements ViewProjection {
  readonly id = 'outline';
  readonly label = 'Outline';

  suitability(model: ProjectionModel): number {
    if (model.nodes.length === 0) return 0.5;
    const nested = model.nodes.filter((node) => (node.depth ?? 0) > 0).length;
    return Math.min(0.95, 0.8 + (nested / model.nodes.length) * 0.15);
  }

  async mount(host: ProjectionHost): Promise<ProjectionInstance> {
    const holder: { current: OutlineProjectionInstance | null } = { current: null };
    try {
      const surface = await host.virtualList.mount(OutlineProjectionInstance.inputSink(holder));
      const instance = new OutlineProjectionInstance(host, surface);
      holder.current = instance;
      return instance;
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

export const OUTLINE_PROJECTION: ViewProjection = new OutlineProjection();
