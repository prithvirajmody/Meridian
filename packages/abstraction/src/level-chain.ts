/**
 * Level chains (ARCHITECTURE.md §3.1 Abstraction, §5.1; roadmap Phase 3 §5,
 * §7). A `LevelChain` names the ordered abstraction levels of a space,
 * coarsest (index 0) to finest. A domain contributes names through its parser
 * manifest (`LevelChainSpec`, mirrored in `@meridian/plugin-api`); a domain
 * that declares nothing gets a **default containment-depth chain** built here
 * from the forest itself, so any parsed corpus zooms with zero adapter
 * changes (the Phase 3B exit criterion).
 *
 * A level *index* is a containment depth (ADR-0012): the chain supplies the
 * names and how many levels are nameable; `buildCut` maps depths to nodes.
 * This module is a pure function of a snapshot (P8).
 */
import { type GraphSpace } from '@meridian/graph-core';
import { forestRootGraphs, maxDepth } from './forest.js';

/** One named level, coarse→fine by array position. Structural twin of
 * `@meridian/plugin-api`'s `LevelSpec` (the dependency law forbids importing
 * it here, §20); the host bridges a manifest's declaration into this shape. */
export interface LevelSpec {
  readonly name: string;
}

/** A domain's declared, ordered level names (coarsest first). */
export interface LevelChainSpec {
  readonly domain: string;
  readonly levels: readonly LevelSpec[];
}

/** A built level with its resolved index. */
export interface LevelInfo {
  readonly index: number;
  readonly name: string;
}

/** The concrete chain over a space: named levels plus their count. */
export interface LevelChain {
  readonly domain: string;
  readonly levels: readonly LevelInfo[];
  /** Number of nameable levels (`levels.length`). Advisory: `buildCut`
   * accepts any level ≥ 0 and yields all leaves past the deepest node. */
  readonly depth: number;
}

/** Fallback domain label when a space has no root graph to read one from. */
const DEFAULT_DOMAIN = 'core';

/** Domain of the space's first (sorted) root graph, or the fallback. */
function domainOf(space: GraphSpace): string {
  const roots = forestRootGraphs(space);
  return roots.length > 0 ? roots[0]!.meta.domain : DEFAULT_DOMAIN;
}

/**
 * Build the level chain for a space. With `spec`, its names and count are
 * used verbatim (a domain declaring its levels through its manifest). Without
 * `spec`, a default containment-depth chain is synthesized: one level per
 * distinct depth present in the forest, named `level-0 … level-N` (no domain
 * vocabulary — the core is domain-blind, P1). An empty space yields a
 * zero-level chain.
 */
export function buildLevelChain(space: GraphSpace, spec?: LevelChainSpec): LevelChain {
  if (spec !== undefined) {
    return {
      domain: spec.domain,
      levels: spec.levels.map((level, index) => ({ index, name: level.name })),
      depth: spec.levels.length,
    };
  }
  const count = maxDepth(space) + 1; // -1 → 0 levels for an empty forest
  const levels: LevelInfo[] = [];
  for (let index = 0; index < count; index++) levels.push({ index, name: `level-${index}` });
  return { domain: domainOf(space), levels, depth: count };
}
