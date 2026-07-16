import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import {
  addEdge,
  addGraph,
  addNode,
  createGraphSpace,
  type GraphId,
  type GraphSpace,
  type NodeId,
  type EdgeId,
  type SourceRef,
} from '@meridian/graph-core';
import type { GraphDeltaInput } from '@meridian/graph-store';

const dirs: string[] = [];

/** Fresh scratch path for one project file; the dir is removed after the suite. */
export function tmpProjectPath(name = 'project.meridian'): string {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-store-sqlite-'));
  dirs.push(dir);
  return join(dir, name);
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export const SRC: SourceRef = { origin: 'source', uri: 'file:///fixture.md', span: [0, 4] };
export const DERIVED: SourceRef = { origin: 'derived' };

export function gid(s: string): GraphId {
  return s as GraphId;
}
export function nid(s: string): NodeId {
  return s as NodeId;
}
export function eid(s: string): EdgeId {
  return s as EdgeId;
}

/**
 * Two-graph space: root graph `g-root` with nodes n-a (detail → g-child),
 * n-b, one edge a→b; child graph `g-child` with node n-c.
 */
export function twoLevelSpace(): GraphSpace {
  let space = createGraphSpace();
  space = addGraph(space, { id: gid('g-root'), label: 'Root', domain: 'test', provenance: DERIVED });
  space = addGraph(space, { id: gid('g-child'), label: 'Child', domain: 'test', provenance: DERIVED });
  space = addNode(space, gid('g-child'), { id: nid('n-c'), kind: 'test:item', label: 'C', provenance: SRC });
  space = addNode(space, gid('g-root'), {
    id: nid('n-a'),
    kind: 'test:item',
    label: 'A',
    attrs: { 'test:rank': 1 },
    provenance: SRC,
    detail: { graph: gid('g-child') },
  });
  space = addNode(space, gid('g-root'), { id: nid('n-b'), kind: 'test:item', label: 'B', provenance: SRC });
  space = addEdge(space, gid('g-root'), {
    id: eid('e-ab'),
    src: nid('n-a'),
    dst: nid('n-b'),
    kind: 'test:link',
    weight: 2,
    provenance: DERIVED,
  });
  return space;
}

/** Delta adding one fresh empty graph — the cheapest universal mutation. */
export function addGraphDelta(i: number, actor = 'test', volatile?: boolean): GraphDeltaInput {
  return {
    origin: { actor, ...(volatile ? { volatile } : {}) },
    ops: [
      {
        t: 'graph:add',
        graph: gid(`g-extra-${i}`),
        meta: { label: `Extra ${i}`, domain: 'test', provenance: { origin: 'derived' } },
      },
    ],
  };
}

/** One macrotask hop — lets the store's post-commit microtask chain land. */
export function settleTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
