import type { NodeId, RenderModel } from '@meridian/view-model';
import { createCameraController, createScene, type SceneAdapter } from '../src/index.js';

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const statsElement = document.querySelector<HTMLElement>('#stats')!;
const faultElement = document.querySelector<HTMLElement>('#fault')!;

function fixture(side = 64): RenderModel {
  const count = side * side;
  const nodeIds = Array.from({ length: count }, (_, index) => `fixture:${index}` as NodeId);
  const nodeRects = new Float64Array(count * 4);
  const labelRefs = new Uint32Array(count);
  const labelClasses = new Uint8Array(count);
  const edgePairs: number[] = [];
  const edgeKeys: string[] = [];
  for (let index = 0; index < count; index++) {
    const column = index % side;
    const row = Math.floor(index / side);
    nodeRects.set([column * 48, row * 36, 20, 14], index * 4);
    labelRefs[index] = index;
    labelClasses[index] = index % 32 === 0 ? 3 : 0;
    if (column + 1 < side) {
      edgePairs.push(index, index + 1);
      edgeKeys.push(`${nodeIds[index]}→${nodeIds[index + 1]}→fixture:next`);
    }
  }
  const edgeCount = edgeKeys.length;
  return {
    revision: `renderer-harness-${side}`,
    bounds: { x: 0, y: 0, width: (side - 1) * 48 + 20, height: (side - 1) * 36 + 14 },
    nodeIds,
    nodeRects,
    nodeColorKeys: ['fixture:node'],
    nodeColorIds: new Uint16Array(count),
    nodeFlags: new Uint8Array(count),
    nodeCoveredLeaves: new Float64Array(count).fill(1),
    nodeDegrees: new Uint32Array(count).fill(2),
    labelTable: nodeIds,
    labelRefs,
    labelClasses,
    edgeKeys,
    edgeIndices: Uint32Array.from(edgePairs),
    edgeColorKeys: ['fixture:edge'],
    edgeColorIds: new Uint16Array(edgeCount),
    edgeWeights: new Float64Array(edgeCount).fill(1),
    edgeMultiplicities: new Uint32Array(edgeCount).fill(1),
    edgeFlags: new Uint8Array(edgeCount),
    edgeRouteOffsets: new Uint32Array(edgeCount + 1),
    edgeRoutePoints: new Float64Array(),
    diagnostics: [],
  };
}

const EMPTY_MODEL: RenderModel = {
  ...fixture(1),
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

const model = fixture();
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
    `culled ${stats.culledNodes} · contexts lost ${stats.contextLosses}`,
  ].join('\n');
});
scene.on('fault', (fault) => {
  faultElement.textContent = `${fault.code}: ${fault.message}`;
});
camera.on('change', render);

await scene.mount(canvas);
camera.fitToBounds(model.bounds, { padding: 56 });
render();

const resizeObserver = new ResizeObserver(() => {
  camera.resize(
    { width: canvas.clientWidth, height: canvas.clientHeight },
    window.devicePixelRatio,
  );
});
resizeObserver.observe(canvas);

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
  camera.fitToBounds(model.bounds, { padding: 56 });
});
document.querySelector('#zero')!.addEventListener('click', () => {
  activeModel = EMPTY_MODEL;
  render();
});
document.querySelector('#fixture')!.addEventListener('click', () => {
  activeModel = model;
  camera.fitToBounds(model.bounds, { padding: 56 });
  render();
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

declare global {
  interface Window {
    __MERIDIAN_HARNESS__: {
      readonly scene: SceneAdapter;
      fixture(): void;
      zero(): void;
      loseContext(): boolean;
      restoreContext(): boolean;
    };
  }
}

window.__MERIDIAN_HARNESS__ = {
  scene,
  fixture: () => {
    activeModel = model;
    render();
  },
  zero: () => {
    activeModel = EMPTY_MODEL;
    render();
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
};
