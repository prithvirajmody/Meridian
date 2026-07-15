import type { NodeId } from '@meridian/view-model';

export const OUTLINE_ROW_HEIGHT = 32;
export const OUTLINE_OVERSCAN = 4;

export type OutlineVirtualKey =
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Home'
  | 'End'
  | 'Enter'
  | 'Space';

/** Data-only row contract shared structurally with the outline projection. */
export interface OutlineVirtualRow {
  readonly key: string;
  readonly nodeId: NodeId;
  readonly parentId: NodeId | null;
  readonly label: string;
  readonly kind: string;
  readonly depth: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly coveredLeaves: number;
}

export interface OutlineVirtualSelection {
  readonly nodes: readonly NodeId[];
}

export interface OutlineVirtualFocus {
  readonly node: NodeId | null;
}

/** No DOM object crosses this frame boundary. */
export interface OutlineVirtualFrame {
  readonly revision: string;
  readonly rows: readonly OutlineVirtualRow[];
  readonly selection: OutlineVirtualSelection;
  readonly focus: OutlineVirtualFocus;
  readonly activeNodeId: NodeId | null;
  readonly emptyMessage: string | null;
}

/** Plain input intents emitted by delegated DOM listeners. */
export interface OutlineVirtualListInput {
  readonly onActivate: (nodeId: NodeId) => void;
  readonly onToggle: (nodeId: NodeId) => void;
  readonly onKey: (key: OutlineVirtualKey, activeNodeId: NodeId | null) => void;
}

export interface OutlineVirtualListViewState {
  readonly scrollTop: number;
}

/** Resource facade returned to Studio; the concrete elements stay private. */
export interface OutlineVirtualListSurface {
  render(frame: OutlineVirtualFrame): void;
  revealNode(nodeId: NodeId | null): void;
  captureViewState(): OutlineVirtualListViewState;
  restoreViewState(state: unknown): void;
  destroy(): void;
}

export interface VirtualWindow {
  readonly startIndex: number;
  /** Exclusive. */
  readonly endIndex: number;
  readonly offsetTop: number;
  readonly totalHeight: number;
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`renderer: ${name} must be a non-negative safe integer`);
  }
}

function nonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`renderer: ${name} must be finite and non-negative`);
  }
}

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`renderer: ${name} must be finite and greater than zero`);
  }
}

/**
 * O(1) fixed-row window calculation. The end index is exclusive and includes
 * the requested overscan, clipped to the available rows.
 */
export function computeVirtualWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = OUTLINE_ROW_HEIGHT,
  overscan = OUTLINE_OVERSCAN,
): VirtualWindow {
  nonNegativeInteger(rowCount, 'rowCount');
  nonNegativeFinite(scrollTop, 'scrollTop');
  nonNegativeFinite(viewportHeight, 'viewportHeight');
  positiveFinite(rowHeight, 'rowHeight');
  nonNegativeInteger(overscan, 'overscan');

  const totalHeight = rowCount * rowHeight;
  if (!Number.isFinite(totalHeight) || totalHeight > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('renderer: virtual-list total height exceeds the safe integer range');
  }
  if (rowCount === 0 || viewportHeight === 0) {
    return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight };
  }

  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const top = Math.min(scrollTop, maxScrollTop);
  const firstVisible = Math.min(rowCount - 1, Math.floor(top / rowHeight));
  const visibleEnd = Math.min(rowCount, Math.ceil((top + viewportHeight) / rowHeight));
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(rowCount, Math.max(firstVisible + 1, visibleEnd) + overscan);

  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * rowHeight,
    totalHeight,
  };
}

/**
 * Return the smallest scroll adjustment that makes a fixed-height row fully
 * visible. If the row is taller than the viewport and already covers it, no
 * arbitrary jump is introduced.
 */
export function computeNearestScrollTop(
  rowIndex: number,
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = OUTLINE_ROW_HEIGHT,
): number {
  nonNegativeInteger(rowCount, 'rowCount');
  nonNegativeFinite(scrollTop, 'scrollTop');
  nonNegativeFinite(viewportHeight, 'viewportHeight');
  positiveFinite(rowHeight, 'rowHeight');
  if (rowCount === 0) return 0;
  nonNegativeInteger(rowIndex, 'rowIndex');
  if (rowIndex >= rowCount) {
    throw new RangeError('renderer: rowIndex must be less than rowCount');
  }

  const totalHeight = rowCount * rowHeight;
  if (!Number.isFinite(totalHeight) || totalHeight > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('renderer: virtual-list total height exceeds the safe integer range');
  }
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const top = Math.min(scrollTop, maxScrollTop);
  const bottom = top + viewportHeight;
  const rowTop = rowIndex * rowHeight;
  const rowBottom = rowTop + rowHeight;

  if (rowTop >= top && rowBottom <= bottom) return top;
  if (rowTop < top && rowBottom > bottom) return top;
  if (rowTop < top) return Math.min(maxScrollTop, rowTop);
  return Math.max(0, Math.min(maxScrollTop, rowBottom - viewportHeight));
}

interface PooledRow {
  readonly element: HTMLDivElement;
  readonly disclosure: HTMLSpanElement;
  readonly label: HTMLSpanElement;
  readonly metadata: HTMLSpanElement;
}

let nextInstanceId = 0;

function keyIntent(key: string): OutlineVirtualKey | null {
  switch (key) {
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'Home':
    case 'End':
    case 'Enter':
      return key;
    case ' ':
    case 'Spacebar':
      return 'Space';
    default:
      return null;
  }
}

function closestElement(target: EventTarget | null, selector: string): Element | null {
  if (target === null) return null;
  const candidate = target as Element & { readonly parentElement?: Element | null };
  if (typeof candidate.closest === 'function') return candidate.closest(selector);
  return candidate.parentElement?.closest(selector) ?? null;
}

function scrollState(value: unknown): OutlineVirtualListViewState | null {
  if (typeof value !== 'object' || value === null || !('scrollTop' in value)) return null;
  const top = (value as { readonly scrollTop?: unknown }).scrollTop;
  return typeof top === 'number' && Number.isFinite(top) && top >= 0
    ? { scrollTop: top }
    : null;
}

/** Mount the concrete, renderer-owned virtual DOM tree into `container`. */
export function mountOutlineVirtualList(
  container: HTMLElement,
  input: OutlineVirtualListInput,
): OutlineVirtualListSurface {
  const document = container.ownerDocument;
  const view = document.defaultView;
  const instanceId = ++nextInstanceId;

  const scroller = document.createElement('div');
  scroller.className = 'meridian-outline-virtual-list';
  scroller.setAttribute('role', 'tree');
  scroller.setAttribute('aria-label', 'Outline');
  scroller.tabIndex = 0;
  scroller.style.position = 'relative';
  scroller.style.boxSizing = 'border-box';
  scroller.style.width = '100%';
  scroller.style.height = '100%';
  scroller.style.minHeight = '0';
  scroller.style.overflow = 'auto';
  scroller.style.overscrollBehavior = 'contain';

  const spacer = document.createElement('div');
  spacer.className = 'meridian-outline-virtual-spacer';
  spacer.style.position = 'relative';
  spacer.style.width = '100%';
  spacer.style.height = '0px';

  const empty = document.createElement('div');
  empty.className = 'meridian-outline-empty';
  empty.setAttribute('role', 'status');
  empty.hidden = true;

  scroller.append(spacer, empty);
  container.append(scroller);

  let destroyed = false;
  let frame: OutlineVirtualFrame | null = null;
  let indexedRows: readonly OutlineVirtualRow[] | null = null;
  let rowIndex = new Map<NodeId, number>();
  const pool: PooledRow[] = [];
  let animationFrame: number | null = null;
  let microtaskPending = false;
  let pendingScrollTop: number | null = null;

  function assertAlive(method: string): void {
    if (destroyed) throw new Error(`renderer: outline virtual list.${method} called after destroy`);
  }

  function createPooledRow(slot: number): PooledRow {
    const element = document.createElement('div');
    element.id = `meridian-outline-${instanceId}-row-${slot}`;
    element.className = 'meridian-outline-row';
    element.setAttribute('role', 'treeitem');
    element.style.position = 'absolute';
    element.style.left = '0';
    element.style.right = '0';
    element.style.height = `${OUTLINE_ROW_HEIGHT}px`;
    element.style.boxSizing = 'border-box';
    element.style.display = 'flex';
    element.style.alignItems = 'center';
    element.style.overflow = 'hidden';
    element.style.whiteSpace = 'nowrap';

    const disclosure = document.createElement('span');
    disclosure.className = 'meridian-outline-disclosure';
    disclosure.setAttribute('aria-hidden', 'true');
    disclosure.setAttribute('data-outline-action', 'toggle');
    disclosure.style.flex = '0 0 18px';
    disclosure.style.textAlign = 'center';

    const label = document.createElement('span');
    label.className = 'meridian-outline-label';
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';

    const metadata = document.createElement('span');
    metadata.className = 'meridian-outline-metadata';
    metadata.setAttribute('aria-hidden', 'true');
    metadata.style.marginInlineStart = '8px';
    metadata.style.opacity = '0.7';

    element.append(disclosure, label, metadata);
    spacer.append(element);
    return { element, disclosure, label, metadata };
  }

  function resizePool(required: number, hardLimit: number): void {
    while (pool.length > hardLimit) pool.pop()!.element.remove();
    while (pool.length < required) pool.push(createPooledRow(pool.length));
  }

  function rebuildIndex(rows: readonly OutlineVirtualRow[]): void {
    if (rows === indexedRows) return;
    const next = new Map<NodeId, number>();
    for (let index = 0; index < rows.length; index++) {
      const nodeId = rows[index]!.nodeId;
      if (!next.has(nodeId)) next.set(nodeId, index);
    }
    indexedRows = rows;
    rowIndex = next;
  }

  function paintRow(
    pooled: PooledRow,
    row: OutlineVirtualRow,
    index: number,
    selected: ReadonlySet<NodeId>,
    currentFrame: OutlineVirtualFrame,
  ): void {
    const { element, disclosure, label, metadata } = pooled;
    element.hidden = false;
    element.setAttribute('data-outline-row-index', String(index));
    element.setAttribute('data-outline-row-key', row.key);
    element.setAttribute('aria-level', String(Math.max(0, Math.floor(row.depth)) + 1));
    element.setAttribute('aria-selected', selected.has(row.nodeId) ? 'true' : 'false');
    element.style.top = `${index * OUTLINE_ROW_HEIGHT}px`;
    element.style.paddingInlineStart = `${Math.max(0, Math.floor(row.depth)) * 16}px`;
    element.title = row.label;

    if (row.expandable) {
      element.setAttribute('aria-expanded', row.expanded ? 'true' : 'false');
      disclosure.textContent = row.expanded ? '▾' : '▸';
      disclosure.style.visibility = 'visible';
    } else {
      element.removeAttribute('aria-expanded');
      disclosure.textContent = '';
      disclosure.style.visibility = 'hidden';
    }

    if (currentFrame.focus.node === row.nodeId) {
      element.setAttribute('aria-current', 'true');
    } else {
      element.removeAttribute('aria-current');
    }
    if (currentFrame.activeNodeId === row.nodeId) {
      element.setAttribute('data-outline-active', 'true');
    } else {
      element.removeAttribute('data-outline-active');
    }

    // User/domain strings are assigned only through textContent or inert
    // attribute APIs; no markup is parsed by this surface.
    label.textContent = row.label;
    metadata.textContent =
      row.coveredLeaves > 1 ? `${row.kind} · ${row.coveredLeaves}` : row.kind;
  }

  function paint(): void {
    if (animationFrame !== null && view !== null) view.cancelAnimationFrame(animationFrame);
    animationFrame = null;
    microtaskPending = false;
    if (destroyed || frame === null) return;
    const currentFrame = frame;
    let window = computeVirtualWindow(
      currentFrame.rows.length,
      Math.max(0, scroller.scrollTop),
      Math.max(0, scroller.clientHeight),
    );
    spacer.style.height = `${window.totalHeight}px`;
    if (pendingScrollTop !== null) {
      const top = Math.min(
        pendingScrollTop,
        Math.max(0, window.totalHeight - scroller.clientHeight),
      );
      pendingScrollTop = null;
      if (top !== scroller.scrollTop) {
        scroller.scrollTop = top;
        window = computeVirtualWindow(
          currentFrame.rows.length,
          top,
          Math.max(0, scroller.clientHeight),
        );
      }
    }
    scroller.setAttribute('data-outline-revision', currentFrame.revision);

    const isEmpty = currentFrame.rows.length === 0;
    empty.hidden = !isEmpty;
    empty.textContent = isEmpty ? (currentFrame.emptyMessage ?? '') : '';

    const required = window.endIndex - window.startIndex;
    const hardLimit = Math.min(
      currentFrame.rows.length,
      Math.ceil(scroller.clientHeight / OUTLINE_ROW_HEIGHT) + 1 + OUTLINE_OVERSCAN * 2,
    );
    resizePool(required, Math.max(required, hardLimit));

    const selected = new Set(currentFrame.selection.nodes);
    let activeDescendant: string | null = null;
    for (let slot = 0; slot < pool.length; slot++) {
      const pooled = pool[slot]!;
      if (slot >= required) {
        pooled.element.hidden = true;
        pooled.element.removeAttribute('data-outline-row-index');
        continue;
      }
      const index = window.startIndex + slot;
      const row = currentFrame.rows[index]!;
      paintRow(pooled, row, index, selected, currentFrame);
      if (row.nodeId === currentFrame.activeNodeId) activeDescendant = pooled.element.id;
    }

    if (activeDescendant === null) {
      scroller.removeAttribute('aria-activedescendant');
    } else {
      scroller.setAttribute('aria-activedescendant', activeDescendant);
    }
  }

  function schedulePaint(): void {
    if (destroyed || animationFrame !== null || microtaskPending) return;
    if (view !== null && typeof view.requestAnimationFrame === 'function') {
      animationFrame = view.requestAnimationFrame(paint);
      return;
    }
    microtaskPending = true;
    queueMicrotask(() => {
      if (!microtaskPending) return;
      paint();
    });
  }

  function activeRowFromEvent(event: Event): OutlineVirtualRow | null {
    if (frame === null) return null;
    const rowElement = closestElement(event.target, '[data-outline-row-index]');
    if (rowElement === null || !spacer.contains(rowElement)) return null;
    const rawIndex = rowElement.getAttribute('data-outline-row-index');
    if (rawIndex === null) return null;
    const index = Number(rawIndex);
    return Number.isSafeInteger(index) ? (frame.rows[index] ?? null) : null;
  }

  const onScroll = (): void => schedulePaint();
  const onKeyDown = (event: KeyboardEvent): void => {
    const intent = keyIntent(event.key);
    if (intent === null) return;
    event.preventDefault();
    event.stopPropagation();
    input.onKey(intent, frame?.activeNodeId ?? null);
  };
  const onClick = (event: MouseEvent): void => {
    const row = activeRowFromEvent(event);
    if (row === null) return;
    const toggle = closestElement(event.target, '[data-outline-action="toggle"]');
    if (toggle !== null && row.expandable) {
      input.onToggle(row.nodeId);
      return;
    }
    scroller.focus({ preventScroll: true });
    input.onActivate(row.nodeId);
  };

  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('keydown', onKeyDown);
  scroller.addEventListener('click', onClick);

  const ResizeObserverConstructor = view?.ResizeObserver;
  const resizeObserver =
    ResizeObserverConstructor === undefined
      ? null
      : new ResizeObserverConstructor(() => {
          schedulePaint();
        });
  resizeObserver?.observe(scroller);
  const onWindowResize = (): void => schedulePaint();
  if (resizeObserver === null) view?.addEventListener('resize', onWindowResize);

  return {
    render(nextFrame): void {
      assertAlive('render');
      rebuildIndex(nextFrame.rows);
      frame = nextFrame;
      paint();
    },

    revealNode(nodeId): void {
      assertAlive('revealNode');
      if (nodeId === null || frame === null) return;
      const index = rowIndex.get(nodeId);
      if (index === undefined) return;
      const top = computeNearestScrollTop(
        index,
        frame.rows.length,
        Math.max(0, scroller.scrollTop),
        Math.max(0, scroller.clientHeight),
      );
      if (top !== scroller.scrollTop) scroller.scrollTop = top;
      schedulePaint();
    },

    captureViewState(): OutlineVirtualListViewState {
      assertAlive('captureViewState');
      return { scrollTop: Math.max(0, scroller.scrollTop) };
    },

    restoreViewState(state): void {
      assertAlive('restoreViewState');
      const restored = scrollState(state);
      if (restored === null) return;
      pendingScrollTop = restored.scrollTop;
      schedulePaint();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (animationFrame !== null && view !== null) view.cancelAnimationFrame(animationFrame);
      animationFrame = null;
      resizeObserver?.disconnect();
      if (resizeObserver === null) view?.removeEventListener('resize', onWindowResize);
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('keydown', onKeyDown);
      scroller.removeEventListener('click', onClick);
      scroller.remove();
      frame = null;
      indexedRows = null;
      pendingScrollTop = null;
      rowIndex.clear();
      pool.length = 0;
    },
  };
}
