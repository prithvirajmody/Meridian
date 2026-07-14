import { useStore } from 'zustand';
import { worldToScreen } from '@meridian/view-model';
import type { StudioRuntime } from '../runtime.js';

export interface AiOriginOverlayProps {
  readonly runtime: StudioRuntime;
}

/**
 * On-graph visual distinction for AI-origin nodes (ADR-0031 §8.1.3). A DOM layer
 * over the canvas island projects each AI-origin node's settled center to screen
 * and marks it with a distinct badge — so AI-derived structure is visibly
 * different from evidence without touching the renderer's pixi goldens.
 *
 * When the provenance filter is `evidence-only`, the AI nodes are removed from the
 * published model, so they are not found here and the overlay is empty — the
 * badges vanish with the structure they mark.
 */
export function AiOriginOverlay({ runtime }: AiOriginOverlayProps) {
  const model = useStore(runtime.store, (state) => state.renderModel);
  const camera = useStore(runtime.store, (state) => state.camera);
  const viewport = useStore(runtime.store, (state) => state.viewport);
  const aiNodeIds = useStore(runtime.store, (state) => state.ai.summary.aiNodeIds);

  if (model === null || viewport === null || aiNodeIds.length === 0) return null;

  const indexById = new Map<string, number>(
    model.nodeIds.map((id, index) => [id as string, index] as const),
  );
  const badges: { id: string; x: number; y: number }[] = [];
  for (const id of aiNodeIds) {
    const index = indexById.get(id);
    if (index === undefined) continue; // filtered out ⇒ nothing to mark
    const cx = model.nodeRects[4 * index]! + model.nodeRects[4 * index + 2]! / 2;
    const cy = model.nodeRects[4 * index + 1]! + model.nodeRects[4 * index + 3]! / 2;
    const screen = worldToScreen({ x: cx, y: cy }, camera, viewport);
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) continue;
    badges.push({ id, x: screen.x, y: screen.y });
  }

  return (
    <div className="ai-origin-overlay" aria-hidden="true" data-testid="ai-origin-overlay">
      {badges.map((badge) => (
        <span
          key={badge.id}
          className="ai-origin-badge"
          data-testid="ai-origin-badge"
          data-node-id={badge.id}
          style={{ left: `${badge.x}px`, top: `${badge.y}px` }}
        >
          AI
        </span>
      ))}
    </div>
  );
}
