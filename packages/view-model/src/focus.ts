import type { NodeId } from '@meridian/graph-core';

/**
 * Presentation-neutral focus identity derived from navigation's active
 * context. This is a value contract, not a focus store or second authority.
 */
export interface FocusState {
  readonly node: NodeId | null;
}

export const EMPTY_FOCUS: FocusState = { node: null };

/** Normalize navigation's optional focus into the projection value shape. */
export function createFocusState(node?: NodeId | null): FocusState {
  return { node: node ?? null };
}
