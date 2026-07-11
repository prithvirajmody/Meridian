import { BrowserStudioLayoutService } from './browser-layout-worker.js';
import {
  createEmptyRenderModel,
  createHostileLayoutRenderModel,
  createPerformanceRenderModel,
  createUnicodeRenderModel,
} from './performance-fixtures.js';
import { StudioSceneBridge, type FrameProbeResult } from './studio-scene-bridge.js';
import { StudioSession } from './studio-session.js';
import { createStudioStore, type StudioStore } from './store.js';

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
  readonly modelRevision: string | null;
  readonly nodeIds: readonly string[];
  readonly edgeKeys: readonly string[];
  readonly debugEnabled: boolean;
}

export interface MeridianStudioTestApi {
  openText(name: string, text: string): Promise<void>;
  openPerformanceFixture(side?: number): void;
  openUnicodeFixture(): void;
  openHostileLayoutFixture(): void;
  openEmptyFixture(): void;
  state(): StudioTestState;
  fit(): void;
  zoomBy(factor: number): void;
  setScale(scale: number): void;
  screenPointForNode(nodeId: string): { x: number; y: number } | null;
  runFrameProbe(frames?: number, warmup?: number): Promise<FrameProbeResult>;
  loseContext(): boolean;
  restoreContext(): boolean;
}

export class StudioRuntime {
  readonly store: StudioStore;
  readonly session: StudioSession;
  private bridge: StudioSceneBridge | null = null;

  constructor(debugEnabled: boolean) {
    this.store = createStudioStore(debugEnabled);
    this.session = new StudioSession(this.store, {
      layoutService: new BrowserStudioLayoutService(),
    });
  }

  createBridge(canvas: HTMLCanvasElement): StudioSceneBridge {
    const bridge = new StudioSceneBridge(this.store);
    this.bridge = bridge;
    void bridge.mount(canvas);
    return bridge;
  }

  releaseBridge(bridge: StudioSceneBridge): void {
    bridge.destroy();
    if (this.bridge === bridge) this.bridge = null;
  }

  testApi(): MeridianStudioTestApi {
    const bridge = (): StudioSceneBridge => {
      if (this.bridge === null) throw new Error('Studio canvas bridge is not mounted');
      return this.bridge;
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
    };
  }

  async destroy(): Promise<void> {
    this.bridge?.destroy();
    this.bridge = null;
    await this.session.destroy();
  }
}
