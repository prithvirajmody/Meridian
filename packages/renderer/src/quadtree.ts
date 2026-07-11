/**
 * Pure world-space AABB quadtree used for viewport culling (ADR-0021).
 *
 * Construction canonicalizes entries before subdivision, so caller insertion
 * order cannot change the packed representation. Children are always allocated
 * in NW/NE/SW/SE order. An entry that crosses a split remains in its parent.
 */

export const QUADTREE_CAPACITY = 16;
export const QUADTREE_MAX_DEPTH = 12;

/** Closed world-space axis-aligned bounds. */
export interface Aabb {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** A model index and its exact world-space bounds. */
export interface QuadtreeItem {
  readonly index: number;
  readonly bounds: Aabb;
}

export interface QuadtreeOptions {
  readonly capacity?: number;
  readonly maxDepth?: number;
}

/**
 * Read-only packed tree. Typed-array contents are immutable by contract.
 *
 * - `nodeBounds`: `[minX,minY,maxX,maxY]` per node.
 * - `childOffsets`: first of four contiguous NW/NE/SW/SE children, or `-1`.
 * - `itemOffsets`: CSR offsets into `itemIndices` and `itemBounds`.
 * - `itemBounds`: exact `[minX,minY,maxX,maxY]` bounds parallel to indices.
 */
export interface PackedQuadtree {
  readonly nodeBounds: Float64Array;
  readonly childOffsets: Int32Array;
  readonly itemOffsets: Uint32Array;
  readonly itemIndices: Uint32Array;
  readonly itemBounds: Float64Array;
}

export interface QuadtreeQueryResult {
  /** Exact intersections, ordered by ascending model index. */
  readonly indices: Uint32Array;
  /** Items examined after loose-tree node pruning and before exact filtering. */
  readonly candidateCount: number;
}

interface CanonicalItem {
  readonly index: number;
  readonly bounds: Aabb;
}

interface MutableNode {
  readonly bounds: Aabb;
  readonly items: CanonicalItem[];
  children: readonly [MutableNode, MutableNode, MutableNode, MutableNode] | undefined;
}

function validateAabb(bounds: Aabb, name: string): Aabb {
  const coordinates = [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY];
  if (!coordinates.every(Number.isFinite)) {
    throw new RangeError(`renderer: ${name} coordinates must be finite`);
  }
  if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) {
    throw new RangeError(`renderer: ${name} must have non-negative extents`);
  }
  return {
    minX: Object.is(bounds.minX, -0) ? 0 : bounds.minX,
    minY: Object.is(bounds.minY, -0) ? 0 : bounds.minY,
    maxX: Object.is(bounds.maxX, -0) ? 0 : bounds.maxX,
    maxY: Object.is(bounds.maxY, -0) ? 0 : bounds.maxY,
  };
}

function validateOptions(options: QuadtreeOptions): Required<QuadtreeOptions> {
  const capacity = options.capacity ?? QUADTREE_CAPACITY;
  const maxDepth = options.maxDepth ?? QUADTREE_MAX_DEPTH;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('renderer: quadtree capacity must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError('renderer: quadtree maxDepth must be a non-negative safe integer');
  }
  return { capacity, maxDepth };
}

function compareItems(a: CanonicalItem, b: CanonicalItem): number {
  return (
    a.index - b.index ||
    a.bounds.minX - b.bounds.minX ||
    a.bounds.minY - b.bounds.minY ||
    a.bounds.maxX - b.bounds.maxX ||
    a.bounds.maxY - b.bounds.maxY
  );
}

function canonicalItems(items: readonly QuadtreeItem[]): CanonicalItem[] {
  const result = items.map((item, position) => {
    if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index > 0xffff_ffff) {
      throw new RangeError(`renderer: quadtree item ${position} index must be a uint32`);
    }
    return {
      index: item.index,
      bounds: validateAabb(item.bounds, `quadtree item ${position} bounds`),
    };
  });
  result.sort(compareItems);
  return result;
}

function enclosingBounds(items: readonly CanonicalItem[]): Aabb {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.bounds.minX);
    minY = Math.min(minY, item.bounds.minY);
    maxX = Math.max(maxX, item.bounds.maxX);
    maxY = Math.max(maxY, item.bounds.maxY);
  }
  return { minX, minY, maxX, maxY };
}

function childBounds(bounds: Aabb): readonly [Aabb, Aabb, Aabb, Aabb] | undefined {
  const midX = bounds.minX + (bounds.maxX - bounds.minX) / 2;
  const midY = bounds.minY + (bounds.maxY - bounds.minY) / 2;

  // A zero-width/height region cannot form four distinct quadrants. Extremely
  // large adjacent floats can also round their midpoint to an outer boundary.
  if (
    midX <= bounds.minX ||
    midX >= bounds.maxX ||
    midY <= bounds.minY ||
    midY >= bounds.maxY
  ) {
    return undefined;
  }

  return [
    { minX: bounds.minX, minY: bounds.minY, maxX: midX, maxY: midY },
    { minX: midX, minY: bounds.minY, maxX: bounds.maxX, maxY: midY },
    { minX: bounds.minX, minY: midY, maxX: midX, maxY: bounds.maxY },
    { minX: midX, minY: midY, maxX: bounds.maxX, maxY: bounds.maxY },
  ];
}

function contains(outer: Aabb, inner: Aabb): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

function subdivide(
  node: MutableNode,
  depth: number,
  capacity: number,
  maxDepth: number,
): void {
  if (node.items.length <= capacity || depth >= maxDepth) return;
  const bounds = childBounds(node.bounds);
  if (bounds === undefined) return;

  const retained: CanonicalItem[] = [];
  const buckets: [CanonicalItem[], CanonicalItem[], CanonicalItem[], CanonicalItem[]] = [
    [],
    [],
    [],
    [],
  ];

  for (const item of node.items) {
    // First match is intentional for a zero-area item exactly on a split: the
    // fixed NW/NE/SW/SE order supplies the deterministic tie-break.
    const child = bounds.findIndex((candidate) => contains(candidate, item.bounds));
    if (child === -1) retained.push(item);
    else buckets[child]!.push(item);
  }

  node.items.length = 0;
  node.items.push(...retained);
  node.children = [
    { bounds: bounds[0], items: buckets[0], children: undefined },
    { bounds: bounds[1], items: buckets[1], children: undefined },
    { bounds: bounds[2], items: buckets[2], children: undefined },
    { bounds: bounds[3], items: buckets[3], children: undefined },
  ];

  for (const child of node.children) subdivide(child, depth + 1, capacity, maxDepth);
}

function appendBounds(target: number[], bounds: Aabb): void {
  target.push(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
}

/** Build a canonical packed tree. Empty input produces a canonical empty tree. */
export function buildQuadtree(
  input: readonly QuadtreeItem[],
  options: QuadtreeOptions = {},
): PackedQuadtree {
  const { capacity, maxDepth } = validateOptions(options);
  const items = canonicalItems(input);
  if (items.length === 0) {
    return {
      nodeBounds: new Float64Array(),
      childOffsets: new Int32Array(),
      itemOffsets: new Uint32Array([0]),
      itemIndices: new Uint32Array(),
      itemBounds: new Float64Array(),
    };
  }

  const root: MutableNode = {
    bounds: enclosingBounds(items),
    items: [...items],
    children: undefined,
  };
  subdivide(root, 0, capacity, maxDepth);

  // Breadth-first packing keeps each node's four children contiguous while
  // preserving the fixed quadrant order.
  const nodes: MutableNode[] = [root];
  const childOffsets: number[] = [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const children = nodes[nodeIndex]!.children;
    if (children === undefined) {
      childOffsets.push(-1);
    } else {
      childOffsets.push(nodes.length);
      nodes.push(...children);
    }
  }

  const nodeBounds: number[] = [];
  const itemOffsets: number[] = [0];
  const itemIndices: number[] = [];
  const itemBounds: number[] = [];
  for (const node of nodes) {
    appendBounds(nodeBounds, node.bounds);
    for (const item of node.items) {
      itemIndices.push(item.index);
      appendBounds(itemBounds, item.bounds);
    }
    itemOffsets.push(itemIndices.length);
  }

  return {
    nodeBounds: new Float64Array(nodeBounds),
    childOffsets: new Int32Array(childOffsets),
    itemOffsets: new Uint32Array(itemOffsets),
    itemIndices: new Uint32Array(itemIndices),
    itemBounds: new Float64Array(itemBounds),
  };
}

function packedBounds(values: Float64Array, index: number): Aabb {
  const offset = index * 4;
  return {
    minX: values[offset]!,
    minY: values[offset + 1]!,
    maxX: values[offset + 2]!,
    maxY: values[offset + 3]!,
  };
}

function intersects(a: Aabb, b: Aabb): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Return indices whose exact AABBs intersect the closed query bounds.
 * Results are ascending by model index, independent of tree traversal order.
 */
export function queryQuadtreeWithStats(
  tree: PackedQuadtree,
  query: Aabb,
): QuadtreeQueryResult {
  const bounds = validateAabb(query, 'quadtree query bounds');
  if (tree.childOffsets.length === 0) {
    return { indices: new Uint32Array(), candidateCount: 0 };
  }

  const result: number[] = [];
  let candidateCount = 0;
  const pending = [0];
  while (pending.length > 0) {
    const nodeIndex = pending.pop()!;
    if (!intersects(packedBounds(tree.nodeBounds, nodeIndex), bounds)) continue;

    const firstItem = tree.itemOffsets[nodeIndex]!;
    const lastItem = tree.itemOffsets[nodeIndex + 1]!;
    candidateCount += lastItem - firstItem;
    for (let item = firstItem; item < lastItem; item++) {
      if (intersects(packedBounds(tree.itemBounds, item), bounds)) {
        result.push(tree.itemIndices[item]!);
      }
    }

    const firstChild = tree.childOffsets[nodeIndex]!;
    if (firstChild !== -1) {
      // Reverse push order makes traversal itself NW/NE/SW/SE.
      pending.push(firstChild + 3, firstChild + 2, firstChild + 1, firstChild);
    }
  }

  result.sort((a, b) => a - b);
  return { indices: new Uint32Array(result), candidateCount };
}

export function queryQuadtree(tree: PackedQuadtree, query: Aabb): Uint32Array {
  return queryQuadtreeWithStats(tree, query).indices;
}
