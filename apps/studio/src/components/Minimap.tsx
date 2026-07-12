import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { StudioRuntime } from '../runtime.js';

export interface MinimapProps {
  readonly runtime: StudioRuntime;
}

const MAP_WIDTH = 168;
const MAP_HEIGHT = 112;
const MAX_MINIMAP_NODES = 400;

/**
 * The 6D minimap: a pure-SVG overview of the settled `RenderModel` bounds with
 * the camera viewport rectangle; clicking recenters the camera through the
 * navigator (values in, one verb out — no canvas, no Pixi; ADR-0022).
 */
export function Minimap({ runtime }: MinimapProps) {
  const model = useStore(runtime.store, (state) => state.renderModel);
  const camera = useStore(runtime.store, (state) => state.camera);
  const viewport = useStore(runtime.store, (state) => state.viewport);
  const nav = useStore(runtime.store, (state) => state.nav);

  const scene = useMemo(() => {
    if (model === null || model.nodeIds.length === 0) return null;
    const bounds = model.bounds;
    if (bounds.width <= 0 && bounds.height <= 0) return null;
    const scale = Math.min(
      MAP_WIDTH / Math.max(bounds.width, 1e-6),
      MAP_HEIGHT / Math.max(bounds.height, 1e-6),
    );
    const offsetX = (MAP_WIDTH - bounds.width * scale) / 2;
    const offsetY = (MAP_HEIGHT - bounds.height * scale) / 2;
    const toMap = (x: number, y: number): { x: number; y: number } => ({
      x: offsetX + (x - bounds.x) * scale,
      y: offsetY + (y - bounds.y) * scale,
    });
    // Cap the drawn set deterministically: largest rects first, NodeId ties.
    const order = model.nodeIds
      .map((id, index) => ({
        id,
        index,
        area: model.nodeRects[index * 4 + 2]! * model.nodeRects[index * 4 + 3]!,
      }))
      .sort((a, b) => b.area - a.area || (a.id < b.id ? -1 : 1))
      .slice(0, MAX_MINIMAP_NODES);
    const rects = order.map(({ id, index }) => {
      const lane = index * 4;
      const origin = toMap(model.nodeRects[lane]!, model.nodeRects[lane + 1]!);
      return {
        id,
        x: origin.x,
        y: origin.y,
        width: Math.max(1, model.nodeRects[lane + 2]! * scale),
        height: Math.max(1, model.nodeRects[lane + 3]! * scale),
      };
    });
    return { scale, toMap, rects, bounds, offsetX, offsetY };
  }, [model]);

  if (nav === null || scene === null) return null;

  const view =
    viewport === null
      ? null
      : (() => {
          const halfW = viewport.width / (2 * camera.scale);
          const halfH = viewport.height / (2 * camera.scale);
          const topLeft = scene.toMap(camera.center.x - halfW, camera.center.y - halfH);
          return {
            x: topLeft.x,
            y: topLeft.y,
            width: 2 * halfW * scene.scale,
            height: 2 * halfH * scene.scale,
          };
        })();

  return (
    <svg
      className="minimap"
      data-testid="minimap"
      width={MAP_WIDTH}
      height={MAP_HEIGHT}
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      role="img"
      aria-label="Graph overview minimap"
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        const world = {
          x: scene.bounds.x + (mx - scene.offsetX) / scene.scale,
          y: scene.bounds.y + (my - scene.offsetY) / scene.scale,
        };
        runtime.navigator()?.centerOn(world);
      }}
    >
      <rect className="minimap-backdrop" x={0} y={0} width={MAP_WIDTH} height={MAP_HEIGHT} />
      {scene.rects.map((rect) => (
        <rect
          key={rect.id}
          className="minimap-node"
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
        />
      ))}
      {view !== null ? (
        <rect
          className="minimap-viewport"
          data-testid="minimap-viewport"
          x={view.x}
          y={view.y}
          width={Math.max(2, view.width)}
          height={Math.max(2, view.height)}
        />
      ) : null}
    </svg>
  );
}
