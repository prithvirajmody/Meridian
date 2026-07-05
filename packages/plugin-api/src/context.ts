/**
 * The injected plugin context (ADR-0009 rule 2): capability-scoped facades,
 * no store references, no ambient authority. v1 provides deterministic ID
 * derivation (U4 binds parsers from Phase 2) and a logger.
 */
import type { SemanticCoords } from '@meridian/graph-core';

/** Coordinates for a deterministic edge ID (ADR-0002). */
export interface EdgeCoords {
  readonly graph: string;
  readonly kind: string;
  readonly src: string;
  readonly dst: string;
  readonly occurrence?: string;
}

/**
 * Deterministic ID derivation, wire-typed (plain strings): parsers build
 * document JSON, so brands would only be cast away at the boundary.
 */
export interface IdFacade {
  nodeId(coords: SemanticCoords): string;
  graphId(coords: SemanticCoords): string;
  edgeId(coords: EdgeCoords): string;
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface PluginContext {
  /** The running contract version (ADR-0010). */
  readonly apiVersion: string;
  readonly ids: IdFacade;
  readonly log: PluginLogger;
}
