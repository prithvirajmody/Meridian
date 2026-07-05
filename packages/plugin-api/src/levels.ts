/**
 * Level-chain *declarations* (ARCHITECTURE.md §3.1 Abstraction, §7.2.1): a
 * parser's manifest may name its domain's ordered abstraction levels
 * (project→…→expression) so the abstraction engine can label cuts without a
 * change to the adapter's mapping code. This is plain declaration data —
 * strings only. The engine that *consumes* it (`@meridian/abstraction`'s
 * `buildLevelChain`) is downstream of the dependency law (§20) and so cannot
 * be imported here; its `LevelChainSpec` is the structural twin of this type,
 * bridged by the host. A domain that declares nothing gets a default
 * containment-depth chain (Phase 3).
 */

/** One named level. Index in the enclosing array is its position, coarse→fine. */
export interface LevelSpec {
  readonly name: string;
}

/** A domain's ordered, named abstraction levels, coarsest (index 0) first. */
export interface LevelChainSpec {
  readonly domain: string;
  readonly levels: readonly LevelSpec[];
}
