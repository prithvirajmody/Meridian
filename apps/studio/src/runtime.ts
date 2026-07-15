import { keyToNavCommand } from '@meridian/navigation';
import type { AbstractionProposal } from '@meridian/abstraction';
import {
  EMPTY_FOCUS,
  EMPTY_SELECTION,
  type NodeId,
  type ProjectionModel,
} from '@meridian/view-model';
import type { AutoAcceptRule, PendingProposal, ProvenanceView } from './store.js';
import { BrowserStudioLayoutService } from './browser-layout-worker.js';
import type {
  NavigatorRenderer,
  StudioNavigator,
  TransitionRecord,
} from './navigation/studio-navigator.js';
import {
  createEmptyRenderModel,
  createHostileLayoutRenderModel,
  createPerformanceRenderModel,
  createUnicodeRenderModel,
} from './performance-fixtures.js';
import type { FrameProbeResult } from './studio-scene-bridge.js';
import { StudioProjectionCoordinator } from './studio-projection-host.js';
import { StudioSession } from './studio-session.js';
import { ManualClock, realClock, type StudioClock } from './transition/clock.js';
import { createStudioStore, StudioStoreCommands, type StudioStore } from './store.js';

function createOutlineProjectionModel(rowCount: number): ProjectionModel {
  const count = Math.max(0, Math.min(100_000, Math.floor(rowCount)));
  return {
    cutLevel: 0,
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `outline-fixture:${index}` as NodeId,
      label: `Outline row ${String(index + 1).padStart(6, '0')}`,
      kind: 'fixture:outline-row',
      attrs: { 'fixture:index': index },
      graphId: null,
      parentId: null,
      detailGraphId: null,
      depth: 0,
      cutReason: null,
      coveredLeaves: 1,
      orderPath: [index],
    })),
    inducedEdges: [],
    selection: EMPTY_SELECTION,
    focus: EMPTY_FOCUS,
    domainMeta: { domain: 'test-fixture', label: 'Outline performance fixture' },
  };
}

export interface StudioTestState {
  readonly phase: string;
  readonly message: string;
  readonly adapter: ReturnType<StudioStore['getState']>['adapter'];
  readonly panel: ReturnType<StudioStore['getState']>['panel'];
  readonly hover: ReturnType<StudioStore['getState']>['hover'];
  readonly diagnostics: ReturnType<StudioStore['getState']>['diagnostics'];
  readonly metrics: ReturnType<StudioStore['getState']>['metrics'];
  readonly rendererStats: ReturnType<StudioStore['getState']>['rendererStats'];
  readonly camera: ReturnType<StudioStore['getState']>['camera'];
  readonly nav: ReturnType<StudioStore['getState']>['nav'];
  readonly modelRevision: string | null;
  readonly nodeIds: readonly string[];
  readonly edgeKeys: readonly string[];
  readonly debugEnabled: boolean;
}

export interface StudioAiTestState {
  readonly provenanceView: ProvenanceView;
  readonly aiNodeCount: number;
  readonly aiNodeIds: readonly string[];
  readonly proposals: readonly PendingProposal[];
  readonly autoAccept: Readonly<Record<string, AutoAcceptRule>>;
}

export interface MeridianStudioTestApi {
  openText(name: string, text: string): Promise<void>;
  openPerformanceFixture(side?: number): void;
  openUnicodeFixture(): void;
  openHostileLayoutFixture(): void;
  openEmptyFixture(): void;
  openOutlineFixture(rows?: number): void;
  /** Phase-10 test/support seam; Studio chrome lands with the 10F switcher. */
  switchProjection(id: 'map' | 'outline'): Promise<void>;
  projectionId(): string | null;
  state(): StudioTestState;
  fit(): void;
  zoomBy(factor: number): void;
  setScale(scale: number): void;
  screenPointForNode(nodeId: string): { x: number; y: number } | null;
  runFrameProbe(frames?: number, warmup?: number): Promise<FrameProbeResult>;
  loseContext(): boolean;
  restoreContext(): boolean;
  // ---- 6D navigation surface ----
  navActive(): boolean;
  navZoomBy(factor: number, x?: number, y?: number): void;
  navZoomTo(z: number): void;
  navPan(dx: number, dy: number): void;
  navDrillIn(nodeId: string): void;
  navDrillOut(): void;
  navBreadcrumb(depth: number): void;
  navToggleExpand(nodeId: string): void;
  navFlyTo(nodeId: string): void;
  navSearch(query: string): readonly { node: string; score: number; label: string }[];
  /** Node ids the current cut can expand in place (ADR-0012 frontier). */
  navExpandable(): readonly string[];
  navKey(key: string, selection?: string): void;
  navUrl(): string;
  navRestore(fragment: string): { ok: boolean; errors: readonly string[] };
  transitionTelemetry(): readonly TransitionRecord[];
  transitionActive(): boolean;
  mutateNodeLabel(nodeId: string, label: string): boolean;
  /** Manual clock only: advance the injected clock and tick the player. */
  clockAdvance(ms: number): void;
  clockIsManual(): boolean;
  // ---- 8F AI human-trust surface ----
  /** Submit an AI proposal (stands in for an AI service until 8D/8E wire in). */
  aiSubmitProposal(input: {
    readonly service: string;
    readonly title?: string;
    readonly proposal: AbstractionProposal;
  }): string;
  aiAccept(id: string): Promise<{ readonly ok: boolean; readonly errors: readonly string[] }>;
  /** Accept under a caller-supplied `AbortSignal` (test seam for deterministic
   * cancellation coverage — the panel's Cancel button uses the same signal path,
   * but its in-flight window is a single microtask and so not clickable from a
   * driver). Aborting before the pre-write yield leaves the graph untouched. */
  aiAcceptSignalled(
    id: string,
    signal: AbortSignal,
  ): Promise<{ readonly ok: boolean; readonly errors: readonly string[] }>;
  aiReject(id: string): void;
  aiSetAutoAccept(service: string, rule: AutoAcceptRule): void;
  aiSetProvenanceView(view: ProvenanceView): void;
  aiState(): StudioAiTestState;
}

export class StudioRuntime {
  readonly store: StudioStore;
  readonly session: StudioSession;
  readonly clock: StudioClock;
  private projectionHost: StudioProjectionCoordinator | null = null;
  private navigatorRenderer: NavigatorRenderer | null = null;
  /** The hash the page arrived with — captured before any replaceState so a
   * linked view survives the navigator's own boot-time URL emission. */
  private pendingRestoreHash: string;

  constructor(debugEnabled: boolean, options: { readonly manualClock?: boolean } = {}) {
    this.store = createStudioStore(debugEnabled);
    this.pendingRestoreHash = typeof location !== 'undefined' ? location.hash : '';
    this.clock = options.manualClock === true ? new ManualClock() : realClock();
    this.session = new StudioSession(this.store, {
      layoutService: new BrowserStudioLayoutService(),
      clock: this.clock,
      viewportProvider: () => {
        const size = this.projectionHost?.viewportSize();
        return size !== undefined && size.width > 0 && size.height > 0
          ? size
          : { width: 1280, height: 800 };
      },
      onUrl: (fragment) => {
        if (typeof history !== 'undefined' && typeof location !== 'undefined') {
          history.replaceState(null, '', `${location.pathname}${location.search}${fragment}`);
        }
      },
      onNavigatorReady: (navigator) => {
        this.attachNavigatorRenderer(navigator);
        // Restore the linked view (#g=…&z=…&focus=…) the page arrived with,
        // once — later opens start fresh.
        if (this.pendingRestoreHash.length > 1) {
          const fragment = this.pendingRestoreHash;
          this.pendingRestoreHash = '';
          navigator.restoreFromFragment(fragment);
        }
      },
    });
  }

  navigator(): StudioNavigator | null {
    return this.session.nav();
  }

  private attachNavigatorRenderer(navigator: StudioNavigator): void {
    const host = this.projectionHost;
    if (host === null) return;
    if (this.navigatorRenderer !== null) navigator.detachRenderer(this.navigatorRenderer);
    const renderer: NavigatorRenderer = {
      render: (model, camera) => host.renderTransient(model, camera),
    };
    this.navigatorRenderer = renderer;
    navigator.attachRenderer(renderer);
  }

  createProjectionHost(element: HTMLElement): StudioProjectionCoordinator {
    const host = new StudioProjectionCoordinator(element, this.store, {
      navigation: () => this.navigator(),
      focus: () => {
        const focus = this.navigator()?.context().focus;
        return { node: focus ?? null };
      },
      completeTransition: () => this.navigator()?.completeTransitionForProjectionSwitch(),
    });
    this.projectionHost = host;
    void host.switchProjection('map');
    const navigator = this.navigator();
    if (navigator !== null) this.attachNavigatorRenderer(navigator);
    return host;
  }

  releaseProjectionHost(host: StudioProjectionCoordinator): void {
    const navigator = this.navigator();
    if (navigator !== null && this.navigatorRenderer !== null) {
      navigator.detachRenderer(this.navigatorRenderer);
    }
    this.navigatorRenderer = null;
    host.destroy();
    if (this.projectionHost === host) this.projectionHost = null;
  }

  testApi(): MeridianStudioTestApi {
    const bridge = (): StudioProjectionCoordinator => {
      if (this.projectionHost === null) throw new Error('Studio canvas bridge is not mounted');
      return this.projectionHost;
    };
    const nav = (): StudioNavigator => {
      const navigator = this.navigator();
      if (navigator === null) throw new Error('Studio navigator is not active (open a corpus first)');
      return navigator;
    };
    const viewportCenter = (): { x: number; y: number } => {
      const size = bridge().viewportSize();
      return { x: size.width / 2, y: size.height / 2 };
    };
    return {
      openText: (name, text) => this.session.openText(name, text),
      openPerformanceFixture: (side = 100) =>
        this.session.publishFixture(createPerformanceRenderModel(side), 'performance-10k'),
      openUnicodeFixture: () =>
        this.session.publishFixture(createUnicodeRenderModel(), 'unicode-labels'),
      openHostileLayoutFixture: () =>
        this.session.publishFixture(createHostileLayoutRenderModel(), 'hostile-layout'),
      openEmptyFixture: () =>
        this.session.publishFixture(createEmptyRenderModel(), 'empty-render-model'),
      openOutlineFixture: (rows = 100_000) => {
        this.session.publishFixture(createEmptyRenderModel(), 'outline-100k');
        new StudioStoreCommands(this.store).setProjectionModel(
          createOutlineProjectionModel(rows),
        );
      },
      switchProjection: async (id) => bridge().switchProjection(id),
      projectionId: () => this.projectionHost?.activeId() ?? null,
      state: () => {
        const state = this.store.getState();
        return {
          phase: state.phase,
          message: state.message,
          adapter: state.adapter,
          panel: state.panel,
          hover: state.hover,
          diagnostics: state.diagnostics,
          metrics: state.metrics,
          rendererStats: state.rendererStats,
          camera: state.camera,
          nav: state.nav,
          modelRevision: state.renderModel?.revision ?? null,
          nodeIds: state.renderModel?.nodeIds ?? [],
          edgeKeys: state.renderModel?.edgeKeys ?? [],
          debugEnabled: state.debugEnabled,
        };
      },
      fit: () => bridge().fit(),
      zoomBy: (factor) => bridge().zoomBy(factor),
      setScale: (scale) => bridge().setScale(scale),
      screenPointForNode: (nodeId) => bridge().screenPointForNode(nodeId),
      runFrameProbe: (frames, warmup) => bridge().runFrameProbe(frames, warmup),
      loseContext: () => bridge().loseContext(),
      restoreContext: () => bridge().restoreContext(),
      navActive: () => this.navigator() !== null,
      navZoomBy: (factor, x, y) => {
        const screen = x === undefined || y === undefined ? viewportCenter() : { x, y };
        nav().wheelZoom(factor, screen);
      },
      navZoomTo: (z) => nav().zoomTo(z),
      navPan: (dx, dy) => nav().pan({ x: dx, y: dy }),
      navDrillIn: (nodeId) => nav().drillInto(nodeId as NodeId),
      navDrillOut: () => nav().drillOut(),
      navBreadcrumb: (depth) => nav().breadcrumbTo(depth),
      navToggleExpand: (nodeId) => nav().toggleExpand(nodeId as NodeId),
      navFlyTo: (nodeId) => nav().flyTo(nodeId as NodeId),
      navSearch: (query) => nav().search(query),
      navExpandable: () => [...nav().currentLod().frontier.expandable],
      navKey: (key, selection) => {
        const command = keyToNavCommand(key);
        if (command !== null) nav().dispatchKey(command.verb, selection as NodeId | undefined);
      },
      navUrl: () => nav().urlFragment(),
      navRestore: (fragment) => nav().restoreFromFragment(fragment),
      transitionTelemetry: () => nav().telemetry(),
      transitionActive: () => nav().inFlight(),
      mutateNodeLabel: (nodeId, label) => this.session.mutateNodeLabel(nodeId, label),
      clockAdvance: (ms) => {
        if (!(this.clock instanceof ManualClock)) {
          throw new Error('clockAdvance requires ?clock=manual');
        }
        this.clock.advance(ms);
        this.navigator()?.tick();
      },
      clockIsManual: () => this.clock.manual,
      aiSubmitProposal: (input) => this.session.aiTrust.submit(input),
      aiAccept: (id) => this.session.aiTrust.accept(id),
      aiAcceptSignalled: (id, signal) => this.session.aiTrust.accept(id, signal),
      aiReject: (id) => this.session.aiTrust.reject(id),
      aiSetAutoAccept: (service, rule) => this.session.aiTrust.setAutoAccept(service, rule),
      aiSetProvenanceView: (view) => this.session.setProvenanceView(view),
      aiState: () => {
        const ai = this.store.getState().ai;
        return {
          provenanceView: ai.provenanceView,
          aiNodeCount: ai.summary.aiNodeCount,
          aiNodeIds: ai.summary.aiNodeIds,
          proposals: ai.proposals,
          autoAccept: ai.autoAccept,
        };
      },
    };
  }

  async destroy(): Promise<void> {
    this.projectionHost?.destroy();
    this.projectionHost = null;
    this.navigatorRenderer = null;
    await this.session.destroy();
  }
}
