/**
 * Test helpers: minimal, hand-built `LayoutInput` pieces. Providers read only
 * `cut.members`, `edges`, `sizes`, and `hints`, so a `Cut` here is a thin stand
 * with an empty trace — the real cut geometry (I5 coverage) is the abstraction
 * engine's concern, exercised in its own suite and end-to-end in the CLI
 * golden pipeline.
 */
import type { Cut, InducedEdge } from '@meridian/abstraction';
import { asEdgeId, asNodeId, type NodeId } from '@meridian/graph-core';
import type { Rect, Size } from '../src/index.js';

export function n(id: string): NodeId {
  return asNodeId(id);
}

/** A minimal cut carrying just the member set (ascending, as `buildCut` emits). */
export function cutOf(...ids: string[]): Cut {
  const members = ids.map(n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    level: 0,
    members,
    trace: new Map(),
    coverage: { leaves: 0, coveredLeaves: 0, covers: true },
  };
}

export function edge(src: string, dst: string, kind = 'rel:x'): InducedEdge {
  return {
    src: n(src),
    dst: n(dst),
    kind,
    weight: 1,
    multiplicity: 1,
    samples: [asEdgeId(`e:${src}:${dst}:${kind}`)],
  };
}

export function sizes(entries: Record<string, Size>): ReadonlyMap<NodeId, Size> {
  const m = new Map<NodeId, Size>();
  for (const [id, s] of Object.entries(entries)) m.set(n(id), s);
  return m;
}

/** Uniform size for every id. */
export function uniformSizes(ids: string[], size: Size): ReadonlyMap<NodeId, Size> {
  const m = new Map<NodeId, Size>();
  for (const id of ids) m.set(n(id), size);
  return m;
}

export function rectOf(positions: ReadonlyMap<NodeId, Rect>, id: string): Rect {
  const r = positions.get(n(id));
  if (r === undefined) throw new Error(`no position for ${id}`);
  return r;
}
