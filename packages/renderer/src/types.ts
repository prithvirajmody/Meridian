import type { CameraState, NodeId, Point, RenderModel } from '@meridian/view-model';

export type Unsubscribe = () => void;

export type PickResult =
  | {
      readonly kind: 'node';
      readonly nodeId: NodeId;
      readonly screen: Point;
      readonly world: Point;
    }
  | {
      readonly kind: 'edge';
      readonly edgeKey: string;
      readonly screen: Point;
      readonly world: Point;
    };

export interface RendererStats {
  readonly frameTimeMs: number;
  readonly drawCalls: number;
  readonly frameCount: number;
  readonly modelNodes: number;
  readonly candidateNodes: number;
  readonly visibleNodes: number;
  readonly culledNodes: number;
  readonly modelEdges: number;
  readonly visibleEdges: number;
  readonly culledEdges: number;
  readonly modelEdgeSegments: number;
  readonly candidateEdgeSegments: number;
  readonly visibleEdgeSegments: number;
  readonly submittedNodeBatches: number;
  readonly submittedEdgeBatches: number;
  readonly liveLabels: number;
  /** Labels drawn through the MSDF `BitmapText` fast path (ADR-0020). */
  readonly bitmapLabelCount: number;
  /** Labels drawn through the bounded shaped-Unicode `Text` fallback. */
  readonly fallbackLabelCount: number;
  /** Tier/collision/cap-eligible labels that were not drawn this frame. */
  readonly omittedLabelCount: number;
  /** Quadtree query time of the most recent pick, in milliseconds (ADR-0021). */
  readonly pickQueryTimeMs: number;
  readonly contextLosses: number;
  readonly bufferUploadBytes: number;
}

export type RendererFaultCode =
  | 'context-lost'
  | 'context-restore-failed'
  | 'mount-failed'
  | 'font-load-failed'
  | 'spatial-index-failed'
  | 'render-failed';

export interface RendererFault {
  readonly code: RendererFaultCode;
  readonly message: string;
}

export interface SceneEventPayloads {
  readonly hover: PickResult | null;
  readonly select: PickResult | null;
  readonly stats: RendererStats;
  readonly fault: RendererFault;
}

export interface SceneOptions {
  readonly background?: number;
  readonly maxDevicePixelRatio?: number;
  readonly maxBatchSize?: number;
  readonly antialias?: boolean;
  /**
   * URL of the locally-bundled MSDF atlas descriptor (ADR-0020). Served as a
   * static asset; never fetched from the network. Defaults to
   * `/fonts/meridian-msdf.fnt`.
   */
  readonly fontUrl?: string;
}

export interface SceneAdapter {
  mount(canvas: HTMLCanvasElement): Promise<void>;
  render(model: RenderModel, camera: CameraState): void;
  pick(screen: Point): PickResult | null;
  on<E extends keyof SceneEventPayloads>(
    event: E,
    listener: (payload: SceneEventPayloads[E]) => void,
  ): Unsubscribe;
  stats(): Readonly<RendererStats>;
  destroy(): void;
}

export interface SceneFactory {
  (options?: SceneOptions): SceneAdapter;
}
