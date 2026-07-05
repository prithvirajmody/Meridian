/**
 * Random containment forests for the I5 property suite. A generated tree is
 * materialized into a real `GraphSpace` through graph-core's public
 * constructors (bottom-up, because `addNode`'s detail must reference an
 * existing root graph, U3/U2). Depth and breadth are bounded so runs stay
 * fast; the shapes cover ragged hierarchies (mixed depths) and orphan nodes
 * (depth-0 leaves) naturally.
 */
import fc from 'fast-check';
import {
  addGraph,
  addNode,
  asGraphId,
  asNodeId,
  type GraphId,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';

const SRC: SourceRef = { origin: 'source', uri: 'test://forest' };

/** A node in the abstract shape: `children` empty ⇒ a leaf. */
export interface TreeNode {
  readonly children: readonly TreeNode[];
}

const treeArb: fc.Arbitrary<TreeNode> = fc.letrec<{ node: TreeNode }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 4, depthSize: 'small' },
    fc.constant<TreeNode>({ children: [] }),
    fc.record({ children: fc.array(tie('node'), { maxLength: 3 }) }),
  ),
})).node;

/** A forest: the top-level nodes of the (single) root graph. */
export const forestShapeArb: fc.Arbitrary<readonly TreeNode[]> = fc.array(treeArb, {
  maxLength: 4,
});

/** Materialize a shape into a valid GraphSpace. IDs are assigned from a
 * counter in post-order so every detail graph exists (and is a root) before
 * the node that claims it. */
export function materialize(shape: readonly TreeNode[]): GraphSpace {
  let counter = 0;
  const nextId = (): string => `x${counter++}`;
  const rootGraphId = asGraphId('g-root');
  let space = addGraph(
    { graphs: new Map(), roots: [] },
    { id: rootGraphId, label: 'root', domain: 'test', provenance: SRC },
  );

  const addChildren = (parentGraph: GraphId, children: readonly TreeNode[]): void => {
    for (const child of children) {
      if (child.children.length > 0) {
        const detailGraphId = asGraphId(`g-${nextId()}`);
        space = addGraph(space, {
          id: detailGraphId,
          label: 'detail',
          domain: 'test',
          provenance: SRC,
        });
        addChildren(detailGraphId, child.children); // populate before claiming (U3)
        space = addNode(space, parentGraph, {
          id: asNodeId(`n-${nextId()}`),
          kind: 'test:group',
          label: 'group',
          detail: { graph: detailGraphId },
          provenance: SRC,
        });
      } else {
        space = addNode(space, parentGraph, {
          id: asNodeId(`n-${nextId()}`),
          kind: 'test:leaf',
          label: 'leaf',
          provenance: SRC,
        });
      }
    }
  };

  addChildren(rootGraphId, shape);
  return space;
}

/** A random valid containment forest as a GraphSpace. */
export const forestSpaceArb: fc.Arbitrary<GraphSpace> = forestShapeArb.map(materialize);
