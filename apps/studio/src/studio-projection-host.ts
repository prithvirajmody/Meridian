import {
  MAP_PROJECTION,
  MATRIX_PROJECTION,
  OUTLINE_PROJECTION,
  ProjectionRegistry,
  type Canvas2dInput,
  type Canvas2dSurface,
  type NodeLinkSurface,
  type ProjectionDiagnostic,
  type ProjectionHost,
  type ProjectionInstance,
  type ProjectionNavigationIntent,
  type ProjectionViewState,
  type VirtualListInput,
  type VirtualListKey,
  type VirtualListSurface,
  type ViewProjection,
} from '@meridian/projections';
import {
  mountOutlineVirtualList,
  mountProjectionCanvas,
  type OutlineVirtualKey,
} from '@meridian/renderer';
import {
  createFocusState,
  type CameraState,
  type FocusState,
  type NodeId,
  type RenderModel,
  type ViewportSize,
} from '@meridian/view-model';
import {
  StudioSceneBridge,
  type BridgeNavigationSink,
  type FrameProbeResult,
} from './studio-scene-bridge.js';
import { StudioStoreCommands, type StudioStore } from './store.js';

/** Structural seam used only to test the lifecycle coordinator without a GPU. */
export interface StudioMapBridge {
  mount(canvas: HTMLCanvasElement): Promise<void>;
  acceptSettledModel(model: RenderModel | null, sourceGeneration: number | null): void;
  renderTransient(model: RenderModel, camera: CameraState): void;
  captureViewState(): ProjectionViewState;
  restoreViewState(state: unknown): void;
  revealNode(nodeId: string | null): void;
  viewportSize(): ViewportSize;
  fit(): void;
  zoomBy(factor: number): void;
  setScale(scale: number): void;
  screenPointForNode(nodeId: string): { x: number; y: number } | null;
  runFrameProbe(frames?: number, warmup?: number): Promise<FrameProbeResult>;
  loseContext(): boolean;
  restoreContext(): boolean;
  destroy(): void;
}

/** Structural navigation facade: this coordinator never imports the driver. */
export interface StudioProjectionNavigationSink extends BridgeNavigationSink {
  expand(nodeId: NodeId): void;
  collapse(nodeId: NodeId): void;
  drillInto(nodeId: NodeId): void;
  drillOut(): void;
  flyTo(nodeId: NodeId): void;
}

export interface StudioProjectionHostOptions {
  readonly projections?: Iterable<ViewProjection>;
  readonly navigation?: () => StudioProjectionNavigationSink | null;
  readonly focus?: () => FocusState;
  readonly completeTransition?: () => void;
  readonly bridgeFactory?: (
    store: StudioStore,
    navigation: () => StudioProjectionNavigationSink | null,
  ) => StudioMapBridge;
}

interface ActiveProjection {
  readonly id: string;
  readonly instance: ProjectionInstance;
}

interface MountAttempt {
  readonly generation: number;
  bridge: StudioMapBridge | null;
  cleanup: (() => void) | null;
  activate: (() => void) | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectionKey(key: OutlineVirtualKey): VirtualListKey {
  switch (key) {
    case 'Up':
      return 'ArrowUp';
    case 'Down':
      return 'ArrowDown';
    case 'Left':
      return 'ArrowLeft';
    case 'Right':
      return 'ArrowRight';
    case 'Space':
      return ' ';
    case 'Home':
    case 'End':
    case 'Enter':
      return key;
  }
}

/**
 * Studio's capability-scoped projection host. It owns async instance staging,
 * fallback, and renderer-resource adaptation; projections never receive the
 * DOM element, Zustand store, navigator, or concrete scene bridge.
 */
export class StudioProjectionCoordinator {
  private readonly commands: StudioStoreCommands;
  private readonly registry: ProjectionRegistry;
  private readonly navigation: () => StudioProjectionNavigationSink | null;
  private readonly focus: () => FocusState;
  private readonly completeTransition: () => void;
  private readonly bridgeFactory: StudioProjectionHostOptions['bridgeFactory'];
  private readonly viewStates = new Map<string, ProjectionViewState>();
  private readonly unsubscribeStore: () => void;
  private active: ActiveProjection | null = null;
  private activeBridge: StudioMapBridge | null = null;
  private mountingBridge: StudioMapBridge | null = null;
  private readonly pendingCleanups = new Set<() => void>();
  private messageElement: HTMLElement | null = null;
  private generation = 0;
  private destroyed = false;
  private recovering = false;

  constructor(
    private readonly element: HTMLElement,
    private readonly store: StudioStore,
    options: StudioProjectionHostOptions = {},
  ) {
    this.commands = new StudioStoreCommands(store);
    this.registry = new ProjectionRegistry(
      options.projections ?? [MAP_PROJECTION, OUTLINE_PROJECTION, MATRIX_PROJECTION],
    );
    this.navigation = options.navigation ?? (() => null);
    this.focus = options.focus ?? (() => createFocusState());
    this.completeTransition = options.completeTransition ?? (() => undefined);
    this.bridgeFactory =
      options.bridgeFactory ??
      ((targetStore, navigation) => new StudioSceneBridge(targetStore, { navigation }));
    this.unsubscribeStore = store.subscribe((state, previous) => {
      if (state.projectionModel !== previous.projectionModel) {
        if (state.projectionModel === null) {
          this.bridgeForUse()?.acceptSettledModel(null, state.source?.generation ?? null);
        } else {
          this.callActive('render', (instance) => instance.render(state.projectionModel!));
        }
      }
      if (state.selection !== previous.selection) {
        this.callActive('selection', (instance) => instance.applySelection(state.selection));
      }
      if (state.nav?.focus !== previous.nav?.focus) {
        this.callActive('focus', (instance) => instance.applyFocus(this.focus()));
      }
    });
  }

  activeId(): string | null {
    return this.active?.id ?? null;
  }

  /** Initial mount and the future switch entry share one transaction. */
  async switchProjection(id = 'map'): Promise<void> {
    if (this.destroyed || this.active?.id === id) return;
    const switching = this.active !== null;
    if (switching) this.completeTransition();

    const outgoing = this.active;
    if (outgoing !== null) {
      try {
        this.viewStates.set(outgoing.id, outgoing.instance.captureViewState());
      } catch (error) {
        this.commands.projectionFault(
          'view-state-capture-failed',
          `${outgoing.id}: ${errorMessage(error)}`,
        );
      }
    }

    const projection = this.registry.get(id);
    if (projection === undefined) {
      this.commands.projectionFault('unknown-projection', `Unknown projection "${id}"`);
      await this.fallbackFrom(id, switching);
      return;
    }

    const generation = ++this.generation;
    const attempt: MountAttempt = {
      generation,
      bridge: null,
      cleanup: null,
      activate: null,
    };
    const host = this.hostFor(attempt);
    let instance: ProjectionInstance | null = null;
    try {
      instance = await projection.mount(host);
      if (this.destroyed || generation !== this.generation) {
        instance.destroy();
        return;
      }

      const saved = this.viewStates.get(id);
      if (saved !== undefined) {
        try {
          instance.restoreViewState(saved);
        } catch (error) {
          this.viewStates.delete(id);
          this.commands.projectionFault(
            'view-state-restore-failed',
            `${id}: ${errorMessage(error)}`,
          );
        }
      }

      const state = this.store.getState();
      if (state.projectionModel !== null) instance.render(state.projectionModel);
      instance.applySelection(state.selection);
      instance.applyFocus(this.focus());
      if (switching) instance.revealFocus();

      attempt.activate?.();
      outgoing?.instance.destroy();
      this.active = { id, instance };
      this.activeBridge = attempt.bridge;
      if (this.mountingBridge === attempt.bridge) this.mountingBridge = null;
      this.clearMessage();
    } catch (error) {
      try {
        instance?.destroy();
      } catch {
        // The original located lifecycle failure remains the useful diagnostic.
      }
      attempt.cleanup?.();
      if (this.destroyed || generation !== this.generation) return;
      this.commands.projectionFault('projection-mount-failed', `${id}: ${errorMessage(error)}`);
      await this.fallbackFrom(id, switching);
    }
  }

  private async fallbackFrom(failedId: string, switching: boolean): Promise<void> {
    if (failedId !== 'map' && this.registry.get('map') !== undefined) {
      // Invalidate every completion belonging to the failed attempt.
      this.generation++;
      await this.switchProjection('map');
      return;
    }
    if (switching) this.active?.instance.destroy();
    this.active = null;
    this.activeBridge = null;
    this.showTerminalFailure();
  }

  private hostFor(attempt: MountAttempt): ProjectionHost {
    return {
      nodeLink: { mount: () => this.mountNodeLink(attempt) },
      virtualList: {
        mount: (onInput) => this.mountVirtualList(attempt, onInput),
      },
      canvas2d: {
        mount: (onInput) => this.mountCanvas2d(attempt, onInput),
      },
      viewport: () => {
        const viewport = this.bridgeForUse()?.viewportSize() ?? {
          width: this.element.clientWidth,
          height: this.element.clientHeight,
        };
        return {
          ...viewport,
          devicePixelRatio: this.element.ownerDocument.defaultView?.devicePixelRatio ?? 1,
        };
      },
      now: () => this.element.ownerDocument.defaultView?.performance.now() ?? Date.now(),
      selectNode: (nodeId, mode) => this.selectNode(nodeId, mode),
      selectEdges: (keys, anchorKey) => this.selectEdges(keys, anchorKey),
      focusNode: (nodeId) => {
        if (nodeId !== null) this.navigation()?.flyTo(nodeId);
      },
      navigate: (intent) => this.navigate(intent),
      reportDiagnostic: (diagnostic) => {
        if (!this.destroyed && attempt.generation === this.generation) {
          this.reportDiagnostic(diagnostic);
        }
      },
      showDegraded: (message) => {
        if (!this.destroyed && attempt.generation === this.generation) {
          this.showDegraded(message);
        }
      },
    };
  }

  private async mountVirtualList(
    attempt: MountAttempt,
    onInput: (input: VirtualListInput) => void,
  ): Promise<VirtualListSurface> {
    if (this.destroyed || attempt.generation !== this.generation) {
      throw new Error('Studio projection mount is stale');
    }
    const root = this.element.ownerDocument.createElement('div');
    root.className = 'projection-surface projection-surface-outline';
    root.setAttribute('data-testid', 'outline-projection');
    root.style.visibility = 'hidden';
    this.element.append(root);

    let cleaned = false;
    const renderer = mountOutlineVirtualList(root, {
      onActivate: (nodeId) => onInput({ type: 'activate', nodeId, source: 'pointer' }),
      onToggle: (nodeId) => onInput({ type: 'toggle', nodeId }),
      onKey: (key) => onInput({ type: 'key', key: projectionKey(key) }),
    });
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      this.pendingCleanups.delete(cleanup);
      renderer.destroy();
      root.remove();
    };
    attempt.cleanup = cleanup;
    attempt.activate = () => {
      root.style.visibility = 'visible';
    };
    this.pendingCleanups.add(cleanup);

    if (this.destroyed || attempt.generation !== this.generation) {
      cleanup();
      throw new Error('Studio projection mount completed after it became stale');
    }

    return {
      render: (frame) => renderer.render(frame),
      captureViewState: () => {
        const state = renderer.captureViewState();
        return { scrollTop: state.scrollTop };
      },
      restoreViewState: (state) => renderer.restoreViewState(state),
      revealNode: (nodeId) => renderer.revealNode(nodeId),
      destroy: cleanup,
    };
  }

  private async mountCanvas2d(
    attempt: MountAttempt,
    onInput: (input: Canvas2dInput) => void,
  ): Promise<Canvas2dSurface> {
    if (this.destroyed || attempt.generation !== this.generation) {
      throw new Error('Studio projection mount is stale');
    }
    const root = this.element.ownerDocument.createElement('div');
    root.className = 'projection-surface projection-surface-canvas2d';
    root.setAttribute('data-testid', 'canvas2d-projection');
    root.style.visibility = 'hidden';
    this.element.append(root);

    let cleaned = false;
    const surface = mountProjectionCanvas(root, onInput);
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      this.pendingCleanups.delete(cleanup);
      surface.destroy();
      root.remove();
    };
    attempt.cleanup = cleanup;
    attempt.activate = () => {
      root.style.visibility = 'visible';
    };
    this.pendingCleanups.add(cleanup);

    if (this.destroyed || attempt.generation !== this.generation) {
      cleanup();
      throw new Error('Studio projection mount completed after it became stale');
    }

    return {
      render: (frame) => surface.render(frame),
      destroy: cleanup,
    };
  }

  private selectEdges(keys: readonly string[], anchorKey?: string): void {
    if (keys.length === 0) return;
    const anchor = anchorKey !== undefined && keys.includes(anchorKey) ? anchorKey : keys[0]!;
    this.commands.replaceSelection({
      nodes: [],
      edges: [...keys],
      anchor: { kind: 'edge', key: anchor },
    });
  }

  private selectNode(nodeId: NodeId, mode: 'replace' | 'toggle'): void {
    if (mode === 'replace') {
      this.commands.replaceSelection({
        nodes: [nodeId],
        edges: [],
        anchor: { kind: 'node', id: nodeId },
      });
      return;
    }
    const current = this.store.getState().selection;
    const selected = current.nodes.includes(nodeId);
    this.commands.replaceSelection({
      nodes: selected
        ? current.nodes.filter((id) => id !== nodeId)
        : [...current.nodes, nodeId],
      edges: [...current.edges],
      ...(!selected
        ? { anchor: { kind: 'node' as const, id: nodeId } }
        : current.anchor?.kind === 'node' && current.anchor.id === nodeId
          ? {}
          : current.anchor === undefined
            ? {}
            : { anchor: current.anchor }),
    });
  }

  private navigate(intent: ProjectionNavigationIntent): void {
    const navigation = this.navigation();
    if (navigation === null) return;
    switch (intent.kind) {
      case 'focus':
        navigation.flyTo(intent.nodeId);
        break;
      case 'expand':
        navigation.expand(intent.nodeId);
        break;
      case 'collapse':
        navigation.collapse(intent.nodeId);
        break;
      case 'drill-in':
        navigation.drillInto(intent.nodeId);
        break;
      case 'drill-out':
        navigation.drillOut();
        break;
    }
  }

  private async mountNodeLink(attempt: MountAttempt): Promise<NodeLinkSurface> {
    if (this.destroyed || attempt.generation !== this.generation) {
      throw new Error('Studio projection mount is stale');
    }
    const canvas = this.element.ownerDocument.createElement('canvas');
    canvas.setAttribute('aria-label', 'Meridian graph canvas');
    canvas.setAttribute('data-testid', 'graph-canvas');
    this.element.append(canvas);

    const bridge = this.bridgeFactory!(this.store, this.navigation);
    attempt.bridge = bridge;
    this.mountingBridge = bridge;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      this.pendingCleanups.delete(cleanup);
      bridge.destroy();
      canvas.remove();
      if (this.activeBridge === bridge) this.activeBridge = null;
      if (this.mountingBridge === bridge) this.mountingBridge = null;
    };
    attempt.cleanup = cleanup;
    this.pendingCleanups.add(cleanup);

    try {
      await bridge.mount(canvas);
    } catch (error) {
      cleanup();
      throw error;
    }
    if (this.destroyed || attempt.generation !== this.generation) {
      cleanup();
      throw new Error('Studio projection mount completed after it became stale');
    }

    return {
      render: (model) => {
        this.clearMessage();
        bridge.acceptSettledModel(model, this.store.getState().source?.generation ?? null);
      },
      captureViewState: () => bridge.captureViewState(),
      restoreViewState: (state) => bridge.restoreViewState(state),
      revealNode: (nodeId: NodeId | null) => bridge.revealNode(nodeId),
      destroy: cleanup,
    };
  }

  private reportDiagnostic(diagnostic: ProjectionDiagnostic): void {
    this.commands.projectionFault(
      `${diagnostic.projectionId}:${diagnostic.code}`,
      `${diagnostic.phase}: ${diagnostic.message}`,
    );
  }

  private showDegraded(message: string): void {
    this.showMessage('projection-degraded', message, 'status');
  }

  private showTerminalFailure(): void {
    this.showMessage(
      'projection-failure',
      'Unable to display this view.',
      'alert',
    );
  }

  private showMessage(testId: string, message: string, role: string): void {
    this.clearMessage();
    const element = this.element.ownerDocument.createElement('div');
    element.setAttribute('data-testid', testId);
    element.setAttribute('role', role);
    element.textContent = message;
    this.element.append(element);
    this.messageElement = element;
  }

  private clearMessage(): void {
    this.messageElement?.remove();
    this.messageElement = null;
  }

  private callActive(
    phase: 'render' | 'selection' | 'focus',
    call: (instance: ProjectionInstance) => void,
  ): void {
    const active = this.active;
    if (active === null || this.destroyed) return;
    try {
      call(active.instance);
    } catch (error) {
      this.commands.projectionFault(
        `projection-${phase}-failed`,
        `${active.id}: ${errorMessage(error)}`,
      );
      if (!this.recovering) {
        this.recovering = true;
        void this.recoverActive(active.id).finally(() => {
          this.recovering = false;
        });
      }
    }
  }

  private async recoverActive(failedId: string): Promise<void> {
    this.generation++;
    const failed = this.active;
    this.active = null;
    this.activeBridge = null;
    try {
      failed?.instance.destroy();
    } catch {
      // The triggering lifecycle error is already located.
    }
    if (failedId !== 'map' && this.registry.get('map') !== undefined) {
      await this.switchProjection('map');
    } else {
      this.showTerminalFailure();
    }
  }

  private bridgeForUse(): StudioMapBridge | null {
    return this.activeBridge ?? this.mountingBridge;
  }

  renderTransient(model: RenderModel, camera: CameraState): void {
    this.bridgeForUse()?.renderTransient(model, camera);
  }

  viewportSize(): ViewportSize {
    return this.bridgeForUse()?.viewportSize() ?? { width: 0, height: 0 };
  }

  fit(): void {
    this.requireBridge().fit();
  }

  zoomBy(factor: number): void {
    this.requireBridge().zoomBy(factor);
  }

  setScale(scale: number): void {
    this.requireBridge().setScale(scale);
  }

  screenPointForNode(nodeId: string): { x: number; y: number } | null {
    return this.requireBridge().screenPointForNode(nodeId);
  }

  runFrameProbe(frames?: number, warmup?: number): Promise<FrameProbeResult> {
    return this.requireBridge().runFrameProbe(frames, warmup);
  }

  loseContext(): boolean {
    return this.requireBridge().loseContext();
  }

  restoreContext(): boolean {
    return this.requireBridge().restoreContext();
  }

  private requireBridge(): StudioMapBridge {
    const bridge = this.bridgeForUse();
    if (bridge === null) throw new Error('Studio canvas bridge is not mounted');
    return bridge;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    this.unsubscribeStore();
    try {
      this.active?.instance.destroy();
    } finally {
      this.active = null;
      this.activeBridge = null;
      for (const cleanup of [...this.pendingCleanups]) cleanup();
      this.mountingBridge = null;
      this.clearMessage();
    }
  }
}
