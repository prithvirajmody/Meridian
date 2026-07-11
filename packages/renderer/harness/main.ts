import type { RenderModel } from '@meridian/view-model';
import {
  createCameraController,
  createScene,
  type RendererStats,
  type SceneAdapter,
} from '../src/index.js';
import { createHarnessFixture } from './fixture.js';

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const statsElement = document.querySelector<HTMLElement>('#stats')!;
const faultElement = document.querySelector<HTMLElement>('#fault')!;

const EMPTY_MODEL: RenderModel = {
  ...createHarnessFixture(1),
  revision: 'renderer-harness-empty',
  bounds: { x: 0, y: 0, width: 0, height: 0 },
  nodeIds: [],
  nodeRects: new Float64Array(),
  nodeColorKeys: [],
  nodeColorIds: new Uint16Array(),
  nodeFlags: new Uint8Array(),
  nodeCoveredLeaves: new Float64Array(),
  nodeDegrees: new Uint32Array(),
  labelTable: [],
  labelRefs: new Uint32Array(),
  labelClasses: new Uint8Array(),
  edgeColorKeys: [],
  edgeRouteOffsets: new Uint32Array([0]),
};

const model = createHarnessFixture();
let activeModel = model;
const camera = createCameraController({
  viewport: { width: canvas.clientWidth, height: canvas.clientHeight },
  devicePixelRatio: window.devicePixelRatio,
});
const scene = createScene();

function render(): void {
  scene.render(activeModel, camera.state());
}

scene.on('stats', (stats) => {
  statsElement.textContent = [
    `frame ${stats.frameCount} · ${stats.frameTimeMs.toFixed(2)} ms`,
    `draw calls ${stats.drawCalls} · visible ${stats.visibleNodes}/${stats.modelNodes}`,
    `labels ${stats.liveLabels} (bmp ${stats.bitmapLabelCount} · fb ${stats.fallbackLabelCount} · omit ${stats.omittedLabelCount})`,
    `pick ${stats.pickQueryTimeMs.toFixed(3)} ms · culled ${stats.culledNodes} · lost ${stats.contextLosses}`,
  ].join('\n');
});
scene.on('hover', (hit) => {
  if (hit === null) canvas.title = '';
  else canvas.title = hit.kind === 'node' ? `node ${hit.nodeId}` : `edge ${hit.edgeKey}`;
});
scene.on('fault', (fault) => {
  faultElement.textContent = `${fault.code}: ${fault.message}`;
});
camera.on('change', render);

// Do not top-level-await mount: module evaluation (and therefore document load)
// must finish even while Pixi fetches the local atlas. Browser probes can see
// the harness immediately and await this explicit readiness value with a useful
// timeout/error instead of hanging in page.goto().
const ready = scene.mount(canvas).then(() => {
  camera.fitToBounds(model.bounds, { padding: 56 });
  render();
});
void ready.catch((error: unknown) => {
  faultElement.textContent = `mount-failed: ${error instanceof Error ? error.message : String(error)}`;
});

const resizeObserver = new ResizeObserver(() => {
  camera.resize(
    { width: canvas.clientWidth, height: canvas.clientHeight },
    window.devicePixelRatio,
  );
});
void ready.then(() => resizeObserver.observe(canvas));

let previous: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (event) => {
  previous = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (event) => {
  if (previous === null) return;
  camera.panBy({ x: event.clientX - previous.x, y: event.clientY - previous.y });
  previous = { x: event.clientX, y: event.clientY };
});
canvas.addEventListener('pointerup', (event) => {
  previous = null;
  canvas.releasePointerCapture(event.pointerId);
  canvas.classList.remove('dragging');
});
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    camera.zoomAt(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      Math.exp(-event.deltaY * 0.0015),
    );
  },
  { passive: false },
);

document.querySelector('#fit')!.addEventListener('click', () => {
  void ready.then(() => camera.fitToBounds(model.bounds, { padding: 56 }));
});
document.querySelector('#zero')!.addEventListener('click', () => {
  void ready.then(() => {
    activeModel = EMPTY_MODEL;
    render();
  });
});
document.querySelector('#fixture')!.addEventListener('click', () => {
  void ready.then(() => {
    activeModel = model;
    camera.fitToBounds(model.bounds, { padding: 56 });
    render();
  });
});
function contextLossExtension(): WEBGL_lose_context | null {
  return canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context') ?? null;
}

document.querySelector('#lose')!.addEventListener('click', () => {
  contextLossExtension()?.loseContext();
});
document.querySelector('#restore')!.addEventListener('click', () => {
  contextLossExtension()?.restoreContext();
});

interface FpsProbeResult {
  readonly frames: number;
  /** Compatibility alias: the renderer-owned draw p95. */
  readonly p95FrameTimeMs: number;
  readonly p95DrawTimeMs: number;
  readonly meanDrawTimeMs: number;
  readonly maxDrawTimeMs: number;
  /** Wall-clock requestAnimationFrame cadence, including scheduling/jank. */
  readonly p95RafIntervalMs: number;
  readonly meanRafIntervalMs: number;
  readonly maxRafIntervalMs: number;
  readonly modelNodes: number;
  readonly visibleNodes: number;
  readonly drawCalls: number;
  readonly liveLabels: number;
  readonly minLiveLabels: number;
  readonly maxLiveLabels: number;
  readonly bitmapLabelCount: number;
  readonly maxBitmapLabelCount: number;
  readonly fallbackLabelCount: number;
  readonly omittedLabelCount: number;
}

interface Distribution {
  readonly p95: number;
  readonly mean: number;
  readonly max: number;
}

function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) return { p95: 0, mean: 0, max: 0 };
  const ordered = [...samples].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(ordered.length * 0.95) - 1);
  return {
    p95: ordered[p95Index]!,
    mean: ordered.reduce((sum, value) => sum + value, 0) / ordered.length,
    max: ordered.at(-1)!,
  };
}

function nextAnimationFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * Local frame-budget probe (ADR-0020/0021). Drives a deterministic pan/zoom over
 * the active model and reports both renderer draw cost and wall-clock RAF
 * cadence. The camera starts inside the connected-label tier, so this cannot
 * accidentally benchmark a 10k model while drawing zero labels.
 * The formal CI FPS gate lands in 5F; this is a manual/headless measurement.
 */
async function runFpsProbe(frames = 200, warmup = 40): Promise<FpsProbeResult> {
  await ready;
  if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isSafeInteger(warmup) || warmup < 0) {
    throw new RangeError('renderer harness: FPS frame/warmup counts must be non-negative integers');
  }
  activeModel = model;
  camera.fitToBounds(model.bounds, { padding: 56 });
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  render();
  const labelVisibleScale = 0.75; // 14 world px × 0.75 = 10.5 CSS px: summary tier.
  camera.zoomAt({ x: cx, y: cy }, labelVisibleScale / camera.state().scale);
  await nextAnimationFrame();
  await nextAnimationFrame();

  const statsSamples: RendererStats[] = [];
  const rafTimestamps: number[] = [];
  const off = scene.on('stats', (stats) => statsSamples.push(stats));
  let i = 0;
  await new Promise<void>((resolve) => {
    const step = (timestamp: number): void => {
      rafTimestamps.push(timestamp);
      if (i >= frames + warmup) {
        resolve();
        return;
      }
      camera.panBy({ x: Math.sin(i * 0.15) * 26, y: Math.cos(i * 0.11) * 18 });
      if (i % 10 === 0) camera.zoomAt({ x: cx, y: cy }, i % 20 === 0 ? 1.1 : 0.92);
      i += 1;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  off();
  const measuredStats = statsSamples.slice(warmup);
  const draw = distribution(measuredStats.map((stats) => stats.frameTimeMs));
  const rafIntervals = rafTimestamps.slice(1).map((timestamp, index) => timestamp - rafTimestamps[index]!);
  const raf = distribution(rafIntervals.slice(warmup));
  const liveLabels = measuredStats.map((stats) => stats.liveLabels);
  const stats = scene.stats();
  return {
    frames: Math.min(measuredStats.length, Math.max(0, rafIntervals.length - warmup)),
    p95FrameTimeMs: draw.p95,
    p95DrawTimeMs: draw.p95,
    meanDrawTimeMs: draw.mean,
    maxDrawTimeMs: draw.max,
    p95RafIntervalMs: raf.p95,
    meanRafIntervalMs: raf.mean,
    maxRafIntervalMs: raf.max,
    modelNodes: stats.modelNodes,
    visibleNodes: stats.visibleNodes,
    drawCalls: stats.drawCalls,
    liveLabels: stats.liveLabels,
    minLiveLabels: liveLabels.length === 0 ? 0 : Math.min(...liveLabels),
    maxLiveLabels: liveLabels.length === 0 ? 0 : Math.max(...liveLabels),
    bitmapLabelCount: stats.bitmapLabelCount,
    maxBitmapLabelCount:
      measuredStats.length === 0 ? 0 : Math.max(...measuredStats.map((sample) => sample.bitmapLabelCount)),
    fallbackLabelCount: stats.fallbackLabelCount,
    omittedLabelCount: stats.omittedLabelCount,
  };
}

declare global {
  interface Window {
    __MERIDIAN_HARNESS__: {
      readonly scene: SceneAdapter;
      readonly ready: Promise<void>;
      fixture(): void;
      zero(): void;
      loseContext(): boolean;
      restoreContext(): boolean;
      runFpsProbe(frames?: number, warmup?: number): Promise<FpsProbeResult>;
    };
  }
}

window.__MERIDIAN_HARNESS__ = {
  scene,
  ready,
  fixture: () => {
    void ready.then(() => {
      activeModel = model;
      render();
    });
  },
  zero: () => {
    void ready.then(() => {
      activeModel = EMPTY_MODEL;
      render();
    });
  },
  loseContext: () => {
    const extension = contextLossExtension();
    if (extension === null) return false;
    extension.loseContext();
    return true;
  },
  restoreContext: () => {
    const extension = contextLossExtension();
    if (extension === null) return false;
    extension.restoreContext();
    return true;
  },
  runFpsProbe,
};
