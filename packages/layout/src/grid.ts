/**
 * The `grid` provider (ROADMAP Phase 4 §3): a deterministic, allocation-light
 * fallback that ignores edge *shape* and simply packs boxes. Each connected
 * component (ADR-0015) is arranged in a local row-major grid of
 * `ceil(√n)` columns over uniform cells sized to the component's largest box;
 * the components are then shelf-packed into the world plane. Pure and total
 * over every finite input — it cannot fail, which is why ADR-0017 makes it the
 * universal crash fallback.
 *
 * MAIN-THREAD for now (no worker until 4C). `signal` is accepted per the
 * `LayoutProvider` contract but ignored (no cancellation infrastructure in
 * 4B). Zero-size nodes place as degenerate point-rects (ADR-0015); a missing
 * size is treated defensively as zero.
 */
import type { NodeId } from '@meridian/view-model';
import type { Rect, Size } from './coords.js';
import { connectedComponents } from './components.js';
import { boundsOf, DEFAULT_SPACING, EMPTY_BOUNDS, packComponents, type LaidOutComponent } from './geometry.js';
import { stabilityScore } from './stability.js';
import type { LayoutInput, LayoutProvider, LayoutResult } from './types.js';

const ZERO_SIZE: Size = { width: 0, height: 0 };

/** Lay out one component's members in a local row-major grid. */
function gridComponent(
  members: readonly NodeId[],
  sizes: ReadonlyMap<NodeId, Size>,
  spacing: number,
): LaidOutComponent {
  const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
  let cellW = 0;
  let cellH = 0;
  for (const m of members) {
    const s = sizes.get(m) ?? ZERO_SIZE;
    if (s.width > cellW) cellW = s.width;
    if (s.height > cellH) cellH = s.height;
  }
  const local = new Map<NodeId, Rect>();
  members.forEach((m, i) => {
    const s = sizes.get(m) ?? ZERO_SIZE;
    const col = i % cols;
    const row = Math.floor(i / cols);
    local.set(m, { x: col * (cellW + spacing), y: row * (cellH + spacing), width: s.width, height: s.height });
  });
  return { local, members };
}

export const gridProvider: LayoutProvider = {
  id: 'grid',
  capabilities: { incremental: false, compound: false, deterministic: true },
  compute(input: LayoutInput, prev?: LayoutResult): Promise<LayoutResult> {
    const { cut, edges, sizes, hints } = input;
    const spacing = hints.spacing !== undefined && hints.spacing >= 0 ? hints.spacing : DEFAULT_SPACING;

    if (cut.members.length === 0) {
      const result: LayoutResult = { positions: new Map<NodeId, Rect>(), bounds: EMPTY_BOUNDS, stability: 1 };
      return Promise.resolve(result);
    }

    const components = connectedComponents(cut.members, edges).map((members) =>
      gridComponent(members, sizes, spacing),
    );
    const positions = packComponents(components, spacing);
    const bounds = boundsOf(positions.values());
    const draft: LayoutResult = { positions, bounds, stability: 1 };
    const { stability } = stabilityScore(prev, draft, hints);
    return Promise.resolve({ ...draft, stability });
  },
};
