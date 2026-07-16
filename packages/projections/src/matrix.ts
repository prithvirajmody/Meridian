import {
  createFocusState,
  EMPTY_SELECTION,
  inducedEdgeKey,
  type FocusState,
  type NodeId,
  type ProjectionModel,
  type ProjectionNode,
  type SelectionState,
} from '@meridian/view-model';
import type {
  Canvas2dInput,
  Canvas2dLabel,
  Canvas2dLine,
  Canvas2dRect,
  Canvas2dSurface,
  ProjectionHost,
  ProjectionInstance,
  ProjectionViewState,
  ViewProjection,
} from './contracts.js';

export const MATRIX_MIN_CELL_PX = 2;
export const MATRIX_MAX_CELL_PX = 48;
export const MATRIX_LABEL_MIN_CELL_PX = 10;
export const MATRIX_GUTTER_LEFT_PX = 132;
export const MATRIX_GUTTER_TOP_PX = 8;

const EMPTY_MESSAGE = 'No visible nodes in this cut.';
const DEGRADED_MESSAGE =
  'This cut has no relationships to display as a matrix. Switch to another view.';

const COLOR_BACKGROUND = '#101318';
const COLOR_GRID_LINE = '#334155';
const COLOR_CLUSTER_BAND = 'rgba(148, 163, 184, 0.06)';
const COLOR_DIAGONAL = 'rgba(148, 163, 184, 0.16)';
const COLOR_SELECTED_BAND = 'rgba(245, 158, 11, 0.14)';
const COLOR_SELECTED_CELL = '#f59e0b';
const COLOR_FOCUS_BAND = 'rgba(56, 189, 248, 0.14)';
const COLOR_LABEL = '#cbd5e1';
const COLOR_CLUSTER_LABEL = '#94a3b8';

/** One contiguous block of rows/columns sharing a cluster. */
export interface MatrixCluster {
  readonly key: string;
  readonly label: string;
  readonly start: number;
  readonly count: number;
}

export interface MatrixOrdering {
  readonly nodeIds: readonly NodeId[];
  readonly clusters: readonly MatrixCluster[];
}

interface MatrixCell {
  readonly row: number;
  readonly col: number;
  readonly weight: number;
  readonly keys: readonly string[];
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOrderPath(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

function copySelection(selection: SelectionState): SelectionState {
  return {
    nodes: [...selection.nodes],
    edges: [...selection.edges],
    ...(selection.anchor === undefined
      ? {}
      : selection.anchor.kind === 'node'
        ? { anchor: { kind: 'node' as const, id: selection.anchor.id } }
        : { anchor: { kind: 'edge' as const, key: selection.anchor.key } }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: ProjectionViewState): value is {
  readonly [key: string]: ProjectionViewState;
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ISOLATED_CLUSTER_KEY = '(isolated)';
const ROOTS_CLUSTER_KEY = '(roots)';

/**
 * Deterministic cluster ordering: containment groups when the cut spans more
 * than one parent, connected components otherwise; unconnected nodes trail.
 * Within a cluster, heavier nodes lead so dense blocks meet at the corner.
 */
export function orderMatrixNodes(model: ProjectionModel): MatrixOrdering {
  const nodes = model.nodes;
  const memberIds = new Set(nodes.map((node) => node.id));
  const degree = new Map<NodeId, number>();
  const neighbours = new Map<NodeId, Set<NodeId>>();
  for (const edge of model.inducedEdges) {
    if (!memberIds.has(edge.src) || !memberIds.has(edge.dst)) continue;
    degree.set(edge.src, (degree.get(edge.src) ?? 0) + edge.weight);
    degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + edge.weight);
    if (!neighbours.has(edge.src)) neighbours.set(edge.src, new Set());
    if (!neighbours.has(edge.dst)) neighbours.set(edge.dst, new Set());
    neighbours.get(edge.src)!.add(edge.dst);
    neighbours.get(edge.dst)!.add(edge.src);
  }

  const labelById = new Map(nodes.map((node) => [node.id, node.label] as const));
  const parentKeys = new Set(nodes.map((node) => node.parentId ?? ROOTS_CLUSTER_KEY));

  const clusterKeyOf = new Map<NodeId, string>();
  const clusterLabels = new Map<string, string>();
  if (parentKeys.size >= 2) {
    for (const node of nodes) {
      const key = node.parentId ?? ROOTS_CLUSTER_KEY;
      clusterKeyOf.set(node.id, key);
      if (!clusterLabels.has(key)) {
        clusterLabels.set(
          key,
          key === ROOTS_CLUSTER_KEY ? 'Top level' : (labelById.get(key as NodeId) ?? key),
        );
      }
    }
  } else {
    // Flat cut: connected components over the induced edges.
    const componentOf = new Map<NodeId, string>();
    const sortedIds = nodes.map((node) => node.id).sort(compareString);
    for (const id of sortedIds) {
      if (componentOf.has(id) || (neighbours.get(id)?.size ?? 0) === 0) continue;
      const stack = [id];
      componentOf.set(id, id);
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const next of [...(neighbours.get(current) ?? [])].sort(compareString)) {
          if (componentOf.has(next)) continue;
          componentOf.set(next, id);
          stack.push(next);
        }
      }
    }
    for (const node of nodes) {
      const key = componentOf.get(node.id) ?? ISOLATED_CLUSTER_KEY;
      clusterKeyOf.set(node.id, key);
      if (!clusterLabels.has(key)) {
        clusterLabels.set(
          key,
          key === ISOLATED_CLUSTER_KEY ? 'Unconnected' : (labelById.get(key as NodeId) ?? key),
        );
      }
    }
  }

  const byCluster = new Map<string, ProjectionNode[]>();
  for (const node of nodes) {
    const key = clusterKeyOf.get(node.id)!;
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key)!.push(node);
  }

  const clusterOrder = [...byCluster.keys()].sort((left, right) => {
    if (left === ISOLATED_CLUSTER_KEY) return right === ISOLATED_CLUSTER_KEY ? 0 : 1;
    if (right === ISOLATED_CLUSTER_KEY) return -1;
    const minPath = (key: string): readonly number[] =>
      byCluster
        .get(key)!
        .map((node) => node.orderPath)
        .reduce((minimum, path) => (compareOrderPath(path, minimum) < 0 ? path : minimum));
    return compareOrderPath(minPath(left), minPath(right)) || compareString(left, right);
  });

  const nodeIds: NodeId[] = [];
  const clusters: MatrixCluster[] = [];
  for (const key of clusterOrder) {
    const members = byCluster.get(key)!.sort((left, right) => {
      const weightDelta = (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0);
      if (weightDelta !== 0) return weightDelta;
      return compareOrderPath(left.orderPath, right.orderPath) || compareString(left.id, right.id);
    });
    clusters.push({
      key,
      label: clusterLabels.get(key)!,
      start: nodeIds.length,
      count: members.length,
    });
    for (const member of members) nodeIds.push(member.id);
  }

  return { nodeIds, clusters };
}

interface MatrixViewState {
  cellSize: number;
  offsetX: number;
  offsetY: number;
}

class MatrixProjectionInstance implements ProjectionInstance {
  private destroyed = false;
  private selection: SelectionState = EMPTY_SELECTION;
  private focus: FocusState = createFocusState();
  private ordering: MatrixOrdering | null = null;
  private indexOf = new Map<NodeId, number>();
  private cells: readonly MatrixCell[] = [];
  private maxWeight = 1;
  private labels: readonly string[] = [];
  private view: MatrixViewState = { cellSize: 12, offsetX: 0, offsetY: 0 };
  private fitted = false;
  private restored = false;
  private viewport: { width: number; height: number };
  private revision = 0;
  private pointer: { x: number; y: number; dragging: boolean } | null = null;

  constructor(
    private readonly host: ProjectionHost,
    private readonly surface: Canvas2dSurface,
  ) {
    const { width, height } = host.viewport();
    this.viewport = { width, height };
  }

  private assertAlive(method: string): void {
    if (this.destroyed) throw new Error(`projections: matrix.${method} called after destroy`);
  }

  render(model: ProjectionModel): void {
    this.assertAlive('render');
    this.selection = copySelection(model.selection);
    this.focus = createFocusState(model.focus.node);

    const ordering = orderMatrixNodes(model);
    this.ordering = ordering;
    this.indexOf = new Map(ordering.nodeIds.map((id, index) => [id, index] as const));
    const labelById = new Map(model.nodes.map((node) => [node.id, node.label] as const));
    this.labels = ordering.nodeIds.map((id) => labelById.get(id) ?? id);

    const cellMap = new Map<number, { weight: number; keys: string[] }>();
    const size = ordering.nodeIds.length;
    for (const edge of model.inducedEdges) {
      const row = this.indexOf.get(edge.src);
      const col = this.indexOf.get(edge.dst);
      if (row === undefined || col === undefined) continue;
      const slot = row * size + col;
      const existing = cellMap.get(slot);
      if (existing === undefined) {
        cellMap.set(slot, { weight: edge.weight, keys: [inducedEdgeKey(edge)] });
      } else {
        existing.weight += edge.weight;
        existing.keys.push(inducedEdgeKey(edge));
      }
    }
    const cells: MatrixCell[] = [];
    let maxWeight = 0;
    for (const [slot, cell] of cellMap) {
      const row = Math.floor(slot / size);
      const col = slot % size;
      maxWeight = Math.max(maxWeight, cell.weight);
      cells.push({ row, col, weight: cell.weight, keys: [...cell.keys].sort(compareString) });
    }
    cells.sort((left, right) => left.row - right.row || left.col - right.col);
    this.cells = cells;
    this.maxWeight = maxWeight > 0 ? maxWeight : 1;

    if (!this.fitted && !this.restored) this.fitCellSize();
    this.fitted = true;
    this.clampOffsets();
    this.publish();
  }

  applySelection(selection: SelectionState): void {
    this.assertAlive('applySelection');
    this.selection = copySelection(selection);
    if (this.ordering !== null) this.publish();
  }

  applyFocus(focus: FocusState): void {
    this.assertAlive('applyFocus');
    this.focus = createFocusState(focus.node);
    if (this.ordering !== null) this.publish();
  }

  revealFocus(): void {
    this.assertAlive('revealFocus');
    let target: NodeId | null = this.focus.node;
    if (target === null && this.selection.anchor?.kind === 'node') {
      target = this.selection.anchor.id;
    }
    if (target === null) return;
    const index = this.indexOf.get(target);
    if (index === undefined) return;
    const centre = index * this.view.cellSize + this.view.cellSize / 2;
    this.view.offsetX = centre - this.gridViewportWidth() / 2;
    this.view.offsetY = centre - this.gridViewportHeight() / 2;
    this.clampOffsets();
    this.publish();
  }

  captureViewState(): ProjectionViewState {
    this.assertAlive('captureViewState');
    return {
      version: 1,
      cellSize: this.view.cellSize,
      offsetX: this.view.offsetX,
      offsetY: this.view.offsetY,
    };
  }

  restoreViewState(state: ProjectionViewState): void {
    this.assertAlive('restoreViewState');
    const version = isRecord(state) ? state['version'] : undefined;
    const cellSize = isRecord(state) ? state['cellSize'] : undefined;
    const offsetX = isRecord(state) ? state['offsetX'] : undefined;
    const offsetY = isRecord(state) ? state['offsetY'] : undefined;
    const validCell =
      typeof cellSize === 'number' &&
      Number.isFinite(cellSize) &&
      cellSize >= MATRIX_MIN_CELL_PX &&
      cellSize <= MATRIX_MAX_CELL_PX;
    const validOffset = (value: ProjectionViewState | undefined): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (version !== 1 || !validCell || !validOffset(offsetX) || !validOffset(offsetY)) {
      this.host.reportDiagnostic({
        projectionId: 'matrix',
        code: 'invalid-view-state',
        phase: 'view-state',
        message: 'Saved matrix view state was malformed and has been reset.',
      });
      this.restored = false;
      return;
    }
    this.view = { cellSize, offsetX, offsetY };
    this.restored = true;
    if (this.ordering !== null) {
      this.clampOffsets();
      this.publish();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.surface.destroy();
  }

  private gridViewportWidth(): number {
    return Math.max(0, this.viewport.width - MATRIX_GUTTER_LEFT_PX);
  }

  private gridViewportHeight(): number {
    return Math.max(0, this.viewport.height - MATRIX_GUTTER_TOP_PX);
  }

  private fitCellSize(): void {
    const count = this.ordering?.nodeIds.length ?? 0;
    if (count === 0) return;
    const fit = Math.min(this.gridViewportWidth() / count, this.gridViewportHeight() / count);
    this.view.cellSize = Math.min(
      MATRIX_MAX_CELL_PX,
      Math.max(MATRIX_MIN_CELL_PX, Math.floor(fit * 100) / 100),
    );
    this.view.offsetX = 0;
    this.view.offsetY = 0;
  }

  private clampOffsets(): void {
    const count = this.ordering?.nodeIds.length ?? 0;
    const gridSize = count * this.view.cellSize;
    this.view.offsetX = Math.min(
      Math.max(0, this.view.offsetX),
      Math.max(0, gridSize - this.gridViewportWidth()),
    );
    this.view.offsetY = Math.min(
      Math.max(0, this.view.offsetY),
      Math.max(0, gridSize - this.gridViewportHeight()),
    );
  }

  private cellIntensity(weight: number): string {
    const ratio = Math.min(1, weight / this.maxWeight);
    return `rgba(125, 211, 252, ${(0.3 + 0.7 * ratio).toFixed(3)})`;
  }

  private publish(): void {
    const ordering = this.ordering;
    if (ordering === null) return;
    const count = ordering.nodeIds.length;
    const revision = `matrix-${++this.revision}`;
    if (count === 0) {
      this.surface.render({
        revision,
        background: COLOR_BACKGROUND,
        rects: [],
        lines: [],
        labels: [],
        message: EMPTY_MESSAGE,
      });
      return;
    }
    if (this.cells.length === 0) {
      this.surface.render({
        revision,
        background: COLOR_BACKGROUND,
        rects: [],
        lines: [],
        labels: [],
        message: DEGRADED_MESSAGE,
      });
      return;
    }

    const cell = this.view.cellSize;
    const originX = MATRIX_GUTTER_LEFT_PX - this.view.offsetX;
    const originY = MATRIX_GUTTER_TOP_PX - this.view.offsetY;
    const rowStart = Math.max(0, Math.floor(this.view.offsetY / cell));
    const rowEnd = Math.min(count, Math.ceil((this.view.offsetY + this.gridViewportHeight()) / cell));
    const colStart = Math.max(0, Math.floor(this.view.offsetX / cell));
    const colEnd = Math.min(count, Math.ceil((this.view.offsetX + this.gridViewportWidth()) / cell));
    const gridRight = Math.min(this.viewport.width, originX + count * cell);
    const gridBottom = Math.min(this.viewport.height, originY + count * cell);

    const rects: Canvas2dRect[] = [];
    const lines: Canvas2dLine[] = [];
    const labels: Canvas2dLabel[] = [];

    // Alternating cluster bands orient the eye toward block structure.
    ordering.clusters.forEach((cluster, parity) => {
      if (parity % 2 === 0) return;
      const from = Math.max(cluster.start, rowStart);
      const to = Math.min(cluster.start + cluster.count, rowEnd);
      if (from < to) {
        rects.push({
          x: MATRIX_GUTTER_LEFT_PX,
          y: originY + from * cell,
          width: Math.max(0, gridRight - MATRIX_GUTTER_LEFT_PX),
          height: (to - from) * cell,
          fill: COLOR_CLUSTER_BAND,
        });
      }
      const colFrom = Math.max(cluster.start, colStart);
      const colTo = Math.min(cluster.start + cluster.count, colEnd);
      if (colFrom < colTo) {
        rects.push({
          x: originX + colFrom * cell,
          y: MATRIX_GUTTER_TOP_PX,
          width: (colTo - colFrom) * cell,
          height: Math.max(0, gridBottom - MATRIX_GUTTER_TOP_PX),
          fill: COLOR_CLUSTER_BAND,
        });
      }
    });

    const selectedNodes = new Set(this.selection.nodes);
    const focusIndex = this.focus.node === null ? undefined : this.indexOf.get(this.focus.node);
    const bandTargets: Array<{ index: number; fill: string }> = [];
    for (const id of selectedNodes) {
      const index = this.indexOf.get(id);
      if (index !== undefined) bandTargets.push({ index, fill: COLOR_SELECTED_BAND });
    }
    if (focusIndex !== undefined) bandTargets.push({ index: focusIndex, fill: COLOR_FOCUS_BAND });
    for (const band of bandTargets) {
      if (band.index >= rowStart && band.index < rowEnd) {
        rects.push({
          x: MATRIX_GUTTER_LEFT_PX,
          y: originY + band.index * cell,
          width: Math.max(0, gridRight - MATRIX_GUTTER_LEFT_PX),
          height: cell,
          fill: band.fill,
        });
      }
      if (band.index >= colStart && band.index < colEnd) {
        rects.push({
          x: originX + band.index * cell,
          y: MATRIX_GUTTER_TOP_PX,
          width: cell,
          height: Math.max(0, gridBottom - MATRIX_GUTTER_TOP_PX),
          fill: band.fill,
        });
      }
    }

    const diagonalStart = Math.max(rowStart, colStart);
    const diagonalEnd = Math.min(rowEnd, colEnd);
    for (let index = diagonalStart; index < diagonalEnd; index++) {
      rects.push({
        x: originX + index * cell,
        y: originY + index * cell,
        width: cell,
        height: cell,
        fill: COLOR_DIAGONAL,
      });
    }

    const selectedEdges = new Set(this.selection.edges);
    const cellInset = cell >= 6 ? 1 : 0;
    for (const entry of this.cells) {
      if (entry.row < rowStart || entry.row >= rowEnd) continue;
      if (entry.col < colStart || entry.col >= colEnd) continue;
      const selected = entry.keys.some((key) => selectedEdges.has(key));
      rects.push({
        x: originX + entry.col * cell + cellInset,
        y: originY + entry.row * cell + cellInset,
        width: Math.max(1, cell - cellInset * 2),
        height: Math.max(1, cell - cellInset * 2),
        fill: selected ? COLOR_SELECTED_CELL : this.cellIntensity(entry.weight),
      });
    }

    for (const cluster of ordering.clusters) {
      if (cluster.start === 0) continue;
      const rowY = originY + cluster.start * cell;
      if (rowY >= MATRIX_GUTTER_TOP_PX && rowY <= gridBottom) {
        lines.push({
          x1: MATRIX_GUTTER_LEFT_PX,
          y1: rowY,
          x2: gridRight,
          y2: rowY,
          color: COLOR_GRID_LINE,
          width: 1,
        });
      }
      const colX = originX + cluster.start * cell;
      if (colX >= MATRIX_GUTTER_LEFT_PX && colX <= gridRight) {
        lines.push({
          x1: colX,
          y1: MATRIX_GUTTER_TOP_PX,
          x2: colX,
          y2: gridBottom,
          color: COLOR_GRID_LINE,
          width: 1,
        });
      }
    }

    if (cell >= MATRIX_LABEL_MIN_CELL_PX) {
      const characters = Math.max(3, Math.floor((MATRIX_GUTTER_LEFT_PX - 12) / 6.5));
      for (let row = rowStart; row < rowEnd; row++) {
        const text = this.labels[row]!;
        labels.push({
          x: MATRIX_GUTTER_LEFT_PX - 8,
          y: originY + row * cell + cell / 2,
          text: text.length > characters ? `${text.slice(0, characters - 1)}…` : text,
          color: COLOR_LABEL,
          size: Math.min(12, cell - 2),
          align: 'right',
        });
      }
    } else {
      for (const cluster of ordering.clusters) {
        const from = Math.max(cluster.start, rowStart);
        const to = Math.min(cluster.start + cluster.count, rowEnd);
        if (from >= to) continue;
        labels.push({
          x: MATRIX_GUTTER_LEFT_PX - 8,
          y: originY + ((cluster.start + cluster.count / 2) * cell),
          text: cluster.label,
          color: COLOR_CLUSTER_LABEL,
          size: 11,
          align: 'right',
        });
      }
    }

    this.surface.render({
      revision,
      background: COLOR_BACKGROUND,
      rects,
      lines,
      labels,
      message: null,
    });
  }

  private hitTest(x: number, y: number): { row: number; col: number } | null {
    const count = this.ordering?.nodeIds.length ?? 0;
    if (count === 0) return null;
    const cell = this.view.cellSize;
    const row = Math.floor((y - MATRIX_GUTTER_TOP_PX + this.view.offsetY) / cell);
    if (row < 0 || row >= count || y < MATRIX_GUTTER_TOP_PX) return null;
    if (x < MATRIX_GUTTER_LEFT_PX) return { row, col: -1 };
    const col = Math.floor((x - MATRIX_GUTTER_LEFT_PX + this.view.offsetX) / cell);
    if (col < 0 || col >= count) return null;
    return { row, col };
  }

  private click(x: number, y: number): void {
    const ordering = this.ordering;
    if (ordering === null || this.cells.length === 0) return;
    const hit = this.hitTest(x, y);
    if (hit === null) return;
    if (hit.col === -1 || hit.row === hit.col) {
      this.host.selectNode(ordering.nodeIds[hit.row]!, 'replace');
      return;
    }
    const count = ordering.nodeIds.length;
    const slot = hit.row * count + hit.col;
    const entry = this.cells.find((candidate) => candidate.row * count + candidate.col === slot);
    if (entry !== undefined) this.host.selectEdges(entry.keys, entry.keys[0]);
  }

  /** Wired during async mount before the instance itself is returned. */
  readonly input = (input: Canvas2dInput): void => {
    if (this.destroyed) return;
    if (input.type === 'resize') {
      this.viewport = { width: Math.max(0, input.width), height: Math.max(0, input.height) };
      this.clampOffsets();
      if (this.ordering !== null) this.publish();
      return;
    }
    if (input.type === 'wheel') {
      const factor = Math.exp(-input.deltaY * 0.001);
      const next = Math.min(
        MATRIX_MAX_CELL_PX,
        Math.max(MATRIX_MIN_CELL_PX, this.view.cellSize * factor),
      );
      if (next !== this.view.cellSize) {
        const gridX = (input.x - MATRIX_GUTTER_LEFT_PX + this.view.offsetX) / this.view.cellSize;
        const gridY = (input.y - MATRIX_GUTTER_TOP_PX + this.view.offsetY) / this.view.cellSize;
        this.view.cellSize = next;
        this.view.offsetX = gridX * next - (input.x - MATRIX_GUTTER_LEFT_PX);
        this.view.offsetY = gridY * next - (input.y - MATRIX_GUTTER_TOP_PX);
        this.clampOffsets();
        if (this.ordering !== null) this.publish();
      }
      return;
    }
    if (input.action === 'down' && input.primary) {
      this.pointer = { x: input.x, y: input.y, dragging: false };
      return;
    }
    if (input.action === 'move' && this.pointer !== null) {
      const deltaX = input.x - this.pointer.x;
      const deltaY = input.y - this.pointer.y;
      if (!this.pointer.dragging && Math.abs(deltaX) + Math.abs(deltaY) < 4) return;
      this.pointer.dragging = true;
      this.view.offsetX -= deltaX;
      this.view.offsetY -= deltaY;
      this.pointer = { x: input.x, y: input.y, dragging: true };
      this.clampOffsets();
      if (this.ordering !== null) this.publish();
      return;
    }
    if (input.action === 'up' && this.pointer !== null) {
      const wasDrag = this.pointer.dragging;
      this.pointer = null;
      if (!wasDrag) this.click(input.x, input.y);
      return;
    }
    if (input.action === 'leave') this.pointer = null;
  };
}

export class MatrixProjection implements ViewProjection {
  readonly id = 'matrix';
  readonly label = 'Matrix';

  suitability(model: ProjectionModel): number {
    if (model.nodes.length < 2 || model.inducedEdges.length === 0) return 0;
    const density = Math.min(1, model.inducedEdges.length / model.nodes.length);
    return Math.min(0.8, 0.45 + 0.35 * density);
  }

  async mount(host: ProjectionHost): Promise<ProjectionInstance> {
    const holder: { current: MatrixProjectionInstance | null } = { current: null };
    try {
      const surface = await host.canvas2d.mount((input) => holder.current?.input(input));
      const instance = new MatrixProjectionInstance(host, surface);
      holder.current = instance;
      return instance;
    } catch (error) {
      host.reportDiagnostic({
        projectionId: this.id,
        code: 'mount-failed',
        phase: 'mount',
        message: errorMessage(error),
      });
      throw error;
    }
  }
}

export const MATRIX_PROJECTION: ViewProjection = new MatrixProjection();
