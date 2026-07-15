import {
  createFocusState,
  EMPTY_SELECTION,
  type FocusState,
  type NodeId,
  type ProjectionModel,
  type SelectionState,
} from '@meridian/view-model';
import type {
  Canvas2dFrame,
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

export const TIMELINE_GUTTER_LEFT_PX = 120;
export const TIMELINE_AXIS_HEIGHT_PX = 28;
export const TIMELINE_LANE_MIN_PX = 24;
export const TIMELINE_LANE_MAX_PX = 64;
const MIN_WINDOW_SPAN_MS = 1_000;
const INSTANT_PAD_MS = 30_000;

const EMPTY_MESSAGE = 'No visible nodes in this cut.';
const ATEMPORAL_MESSAGE =
  'This domain declares no time attributes, so there is nothing to plot on a timeline. Switch to another view.';
const NO_DATA_MESSAGE =
  'No node in this cut carries a usable timestamp, so the timeline has nothing to plot. Switch to another view.';

const COLOR_BACKGROUND = '#101318';
const COLOR_LANE_BAND = 'rgba(148, 163, 184, 0.06)';
const COLOR_AXIS_LINE = '#334155';
const COLOR_BAR = 'rgba(125, 211, 252, 0.85)';
const COLOR_BAR_SELECTED = '#f59e0b';
const COLOR_FOCUS_RING = '#38bdf8';
const COLOR_LABEL = '#cbd5e1';
const COLOR_AXIS_LABEL = '#94a3b8';

const SINGLE_LANE_KEY = '(all)';
const UNSET_LANE_KEY = '(none)';

interface TimelineEvent {
  readonly id: NodeId;
  readonly start: number;
  readonly end: number;
  readonly lane: string;
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

/** Deterministic UTC tick label sized to the visible span. */
export function timelineTickLabel(timeMs: number, spanMs: number): string {
  const iso = new Date(timeMs).toISOString();
  if (spanMs >= 48 * 3_600_000) return iso.slice(0, 10);
  if (spanMs >= 3_600_000) return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  return iso.slice(11, 19);
}

/** Pure event extraction: declared lane attr → swimlanes, else one lane. */
export function timelineEvents(model: ProjectionModel): {
  readonly events: readonly TimelineEvent[];
  readonly lanes: readonly string[];
  readonly untimed: number;
} {
  const laneAttribute = model.domainMeta.temporal?.laneAttribute;
  const events: TimelineEvent[] = [];
  for (const node of model.nodes) {
    if (node.temporal === null) continue;
    let lane = SINGLE_LANE_KEY;
    if (laneAttribute !== undefined) {
      const raw = node.attrs[laneAttribute];
      lane =
        typeof raw === 'string' && raw.length > 0
          ? raw
          : typeof raw === 'number' || typeof raw === 'boolean'
            ? String(raw)
            : UNSET_LANE_KEY;
    }
    events.push({ id: node.id, start: node.temporal.start, end: node.temporal.end, lane });
  }
  events.sort((left, right) => left.start - right.start || compareString(left.id, right.id));
  const lanes = [...new Set(events.map((event) => event.lane))].sort((left, right) => {
    if (left === UNSET_LANE_KEY) return right === UNSET_LANE_KEY ? 0 : 1;
    if (right === UNSET_LANE_KEY) return -1;
    return compareString(left, right);
  });
  return { events, lanes, untimed: model.nodes.length - events.length };
}

interface TimelineWindow {
  start: number;
  end: number;
}

class TimelineProjectionInstance implements ProjectionInstance {
  private destroyed = false;
  private selection: SelectionState = EMPTY_SELECTION;
  private focus: FocusState = createFocusState();
  private model: ProjectionModel | null = null;
  private events: readonly TimelineEvent[] = [];
  private lanes: readonly string[] = [];
  private laneIndex = new Map<string, number>();
  private eventById = new Map<NodeId, TimelineEvent>();
  private untimed = 0;
  private window: TimelineWindow = { start: 0, end: 1 };
  private extent: TimelineWindow = { start: 0, end: 1 };
  private laneOffset = 0;
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
    if (this.destroyed) throw new Error(`projections: timeline.${method} called after destroy`);
  }

  render(model: ProjectionModel): void {
    this.assertAlive('render');
    this.model = model;
    this.selection = copySelection(model.selection);
    this.focus = createFocusState(model.focus.node);

    const { events, lanes, untimed } = timelineEvents(model);
    this.events = events;
    this.lanes = lanes;
    this.laneIndex = new Map(lanes.map((lane, index) => [lane, index] as const));
    this.eventById = new Map(events.map((event) => [event.id, event] as const));
    this.untimed = untimed;

    if (events.length > 0) {
      let start = Infinity;
      let end = -Infinity;
      for (const event of events) {
        start = Math.min(start, event.start);
        end = Math.max(end, event.end);
      }
      if (start === end) {
        start -= INSTANT_PAD_MS;
        end += INSTANT_PAD_MS;
      }
      const pad = (end - start) * 0.02;
      this.extent = { start: start - pad, end: end + pad };
      if (!this.fitted && !this.restored) {
        this.window = { ...this.extent };
      }
      this.fitted = true;
      this.clampWindow();
    }
    this.clampLaneOffset();
    this.publish();
  }

  applySelection(selection: SelectionState): void {
    this.assertAlive('applySelection');
    this.selection = copySelection(selection);
    if (this.model !== null) this.publish();
  }

  applyFocus(focus: FocusState): void {
    this.assertAlive('applyFocus');
    this.focus = createFocusState(focus.node);
    if (this.model !== null) this.publish();
  }

  revealFocus(): void {
    this.assertAlive('revealFocus');
    let target: NodeId | null = this.focus.node;
    if (target === null && this.selection.anchor?.kind === 'node') {
      target = this.selection.anchor.id;
    }
    if (target === null) return;
    const event = this.eventById.get(target);
    if (event === undefined) return;
    const middle = (event.start + event.end) / 2;
    if (middle < this.window.start || middle > this.window.end) {
      const span = this.window.end - this.window.start;
      this.window = { start: middle - span / 2, end: middle + span / 2 };
      this.clampWindow();
    }
    const laneIndex = this.laneIndex.get(event.lane) ?? 0;
    const laneHeight = this.laneHeight();
    const laneTop = laneIndex * laneHeight;
    const plotHeight = this.plotHeight();
    if (laneTop < this.laneOffset) this.laneOffset = laneTop;
    else if (laneTop + laneHeight > this.laneOffset + plotHeight) {
      this.laneOffset = laneTop + laneHeight - plotHeight;
    }
    this.clampLaneOffset();
    this.publish();
  }

  captureViewState(): ProjectionViewState {
    this.assertAlive('captureViewState');
    return {
      version: 1,
      windowStart: this.window.start,
      windowEnd: this.window.end,
      laneOffset: this.laneOffset,
    };
  }

  restoreViewState(state: ProjectionViewState): void {
    this.assertAlive('restoreViewState');
    const version = isRecord(state) ? state['version'] : undefined;
    const windowStart = isRecord(state) ? state['windowStart'] : undefined;
    const windowEnd = isRecord(state) ? state['windowEnd'] : undefined;
    const laneOffset = isRecord(state) ? state['laneOffset'] : undefined;
    const finite = (value: ProjectionViewState | undefined): value is number =>
      typeof value === 'number' && Number.isFinite(value);
    if (
      version !== 1 ||
      !finite(windowStart) ||
      !finite(windowEnd) ||
      windowEnd <= windowStart ||
      !finite(laneOffset) ||
      laneOffset < 0
    ) {
      this.host.reportDiagnostic({
        projectionId: 'timeline',
        code: 'invalid-view-state',
        phase: 'view-state',
        message: 'Saved timeline view state was malformed and has been reset.',
      });
      this.restored = false;
      return;
    }
    this.window = { start: windowStart, end: windowEnd };
    this.laneOffset = laneOffset;
    this.restored = true;
    if (this.model !== null) {
      this.clampWindow();
      this.clampLaneOffset();
      this.publish();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.surface.destroy();
  }

  private plotWidth(): number {
    return Math.max(1, this.viewport.width - TIMELINE_GUTTER_LEFT_PX);
  }

  private plotHeight(): number {
    return Math.max(1, this.viewport.height - TIMELINE_AXIS_HEIGHT_PX);
  }

  private laneHeight(): number {
    const count = Math.max(1, this.lanes.length);
    return Math.min(
      TIMELINE_LANE_MAX_PX,
      Math.max(TIMELINE_LANE_MIN_PX, this.plotHeight() / count),
    );
  }

  private clampWindow(): void {
    const fullSpan = Math.max(MIN_WINDOW_SPAN_MS, this.extent.end - this.extent.start);
    let span = this.window.end - this.window.start;
    span = Math.min(Math.max(span, MIN_WINDOW_SPAN_MS), fullSpan * 4);
    // The window may drift at most one span beyond the data extent.
    let start = this.window.start;
    if (start < this.extent.start - span) start = this.extent.start - span;
    if (start > this.extent.end) start = this.extent.end;
    this.window = { start, end: start + span };
  }

  private clampLaneOffset(): void {
    const total = this.lanes.length * this.laneHeight();
    this.laneOffset = Math.min(Math.max(0, this.laneOffset), Math.max(0, total - this.plotHeight()));
  }

  private toX(timeMs: number): number {
    const span = this.window.end - this.window.start;
    return (
      TIMELINE_GUTTER_LEFT_PX + ((timeMs - this.window.start) / span) * this.plotWidth()
    );
  }

  private publish(): void {
    const model = this.model;
    if (model === null) return;
    const revision = `timeline-${++this.revision}`;
    const message =
      model.nodes.length === 0
        ? EMPTY_MESSAGE
        : model.domainMeta.temporal === undefined
          ? ATEMPORAL_MESSAGE
          : this.events.length === 0
            ? NO_DATA_MESSAGE
            : null;
    if (message !== null) {
      this.surface.render({
        revision,
        background: COLOR_BACKGROUND,
        rects: [],
        lines: [],
        labels: [],
        message,
      });
      return;
    }

    const rects: Canvas2dRect[] = [];
    const lines: Canvas2dLine[] = [];
    const labels: Canvas2dLabel[] = [];
    const laneHeight = this.laneHeight();
    const span = this.window.end - this.window.start;

    for (const [lane, index] of this.laneIndex) {
      const y = TIMELINE_AXIS_HEIGHT_PX + index * laneHeight - this.laneOffset;
      if (y + laneHeight < TIMELINE_AXIS_HEIGHT_PX || y > this.viewport.height) continue;
      if (index % 2 === 1) {
        rects.push({
          x: 0,
          y,
          width: this.viewport.width,
          height: laneHeight,
          fill: COLOR_LANE_BAND,
        });
      }
      labels.push({
        x: TIMELINE_GUTTER_LEFT_PX - 8,
        y: y + laneHeight / 2,
        text: lane === SINGLE_LANE_KEY ? 'All' : lane === UNSET_LANE_KEY ? '(no lane)' : lane,
        color: COLOR_LABEL,
        size: 12,
        align: 'right',
      });
    }

    lines.push({
      x1: TIMELINE_GUTTER_LEFT_PX,
      y1: TIMELINE_AXIS_HEIGHT_PX,
      x2: this.viewport.width,
      y2: TIMELINE_AXIS_HEIGHT_PX,
      color: COLOR_AXIS_LINE,
      width: 1,
    });
    const ticks = 6;
    for (let index = 0; index <= ticks; index++) {
      const time = this.window.start + (span * index) / ticks;
      const x = this.toX(time);
      lines.push({
        x1: x,
        y1: TIMELINE_AXIS_HEIGHT_PX - 4,
        x2: x,
        y2: this.viewport.height,
        color: index === 0 ? COLOR_AXIS_LINE : 'rgba(51, 65, 85, 0.45)',
        width: 1,
      });
      labels.push({
        x: Math.min(x + 4, this.viewport.width - 4),
        y: TIMELINE_AXIS_HEIGHT_PX / 2,
        text: timelineTickLabel(time, span),
        color: COLOR_AXIS_LABEL,
        size: 10,
        align: index === ticks ? 'right' : 'left',
      });
    }
    if (this.untimed > 0) {
      labels.push({
        x: TIMELINE_GUTTER_LEFT_PX - 8,
        y: TIMELINE_AXIS_HEIGHT_PX / 2,
        text: `${this.untimed} untimed`,
        color: COLOR_AXIS_LABEL,
        size: 10,
        align: 'right',
      });
    }

    const selectedNodes = new Set(this.selection.nodes);
    for (const event of this.events) {
      if (event.end < this.window.start || event.start > this.window.end) continue;
      const laneIndex = this.laneIndex.get(event.lane) ?? 0;
      const y = TIMELINE_AXIS_HEIGHT_PX + laneIndex * laneHeight - this.laneOffset + 6;
      const height = Math.max(4, laneHeight - 12);
      if (y + height < TIMELINE_AXIS_HEIGHT_PX || y > this.viewport.height) continue;
      const x = this.toX(event.start);
      const width = Math.max(3, this.toX(event.end) - x);
      if (this.focus.node === event.id) {
        rects.push({
          x: x - 2,
          y: y - 2,
          width: width + 4,
          height: height + 4,
          fill: COLOR_FOCUS_RING,
        });
      }
      rects.push({
        x,
        y,
        width,
        height,
        fill: selectedNodes.has(event.id) ? COLOR_BAR_SELECTED : COLOR_BAR,
      });
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

  private hitTest(x: number, y: number): TimelineEvent | null {
    if (this.events.length === 0 || x < TIMELINE_GUTTER_LEFT_PX || y < TIMELINE_AXIS_HEIGHT_PX) {
      return null;
    }
    const laneHeight = this.laneHeight();
    // Later-drawn bars win, so scan in reverse draw order.
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index]!;
      if (event.end < this.window.start || event.start > this.window.end) continue;
      const laneIndex = this.laneIndex.get(event.lane) ?? 0;
      const top = TIMELINE_AXIS_HEIGHT_PX + laneIndex * laneHeight - this.laneOffset + 6;
      const height = Math.max(4, laneHeight - 12);
      const left = this.toX(event.start);
      const width = Math.max(3, this.toX(event.end) - left);
      if (x >= left && x <= left + width && y >= top && y <= top + height) return event;
    }
    return null;
  }

  /** Wired during async mount before the instance itself is returned. */
  readonly input = (input: Canvas2dInput): void => {
    if (this.destroyed) return;
    if (input.type === 'resize') {
      this.viewport = { width: Math.max(0, input.width), height: Math.max(0, input.height) };
      this.clampLaneOffset();
      if (this.model !== null) this.publish();
      return;
    }
    if (this.events.length === 0) return;
    if (input.type === 'wheel') {
      const factor = Math.exp(input.deltaY * 0.001);
      const span = this.window.end - this.window.start;
      const fullSpan = Math.max(MIN_WINDOW_SPAN_MS, this.extent.end - this.extent.start);
      const nextSpan = Math.min(Math.max(span * factor, MIN_WINDOW_SPAN_MS), fullSpan * 4);
      if (nextSpan !== span) {
        const ratio = Math.max(0, input.x - TIMELINE_GUTTER_LEFT_PX) / this.plotWidth();
        const anchorTime = this.window.start + ratio * span;
        const start = anchorTime - nextSpan * ratio;
        this.window = { start, end: start + nextSpan };
        this.clampWindow();
        this.publish();
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
      this.pointer = { x: input.x, y: input.y, dragging: true };
      const span = this.window.end - this.window.start;
      const shift = (-deltaX / this.plotWidth()) * span;
      this.window = { start: this.window.start + shift, end: this.window.end + shift };
      this.laneOffset -= deltaY;
      this.clampWindow();
      this.clampLaneOffset();
      this.publish();
      return;
    }
    if (input.action === 'up' && this.pointer !== null) {
      const wasDrag = this.pointer.dragging;
      this.pointer = null;
      if (!wasDrag) {
        const hit = this.hitTest(input.x, input.y);
        if (hit !== null) this.host.selectNode(hit.id, 'replace');
      }
      return;
    }
    if (input.action === 'leave') this.pointer = null;
  };
}

export class TimelineProjection implements ViewProjection {
  readonly id = 'timeline';
  readonly label = 'Timeline';

  suitability(model: ProjectionModel): number {
    if (model.domainMeta.temporal === undefined || model.nodes.length === 0) return 0;
    const timed = model.nodes.filter((node) => node.temporal !== null).length;
    if (timed === 0) return 0;
    return Math.min(0.9, 0.55 + 0.35 * (timed / model.nodes.length));
  }

  async mount(host: ProjectionHost): Promise<ProjectionInstance> {
    const holder: { current: TimelineProjectionInstance | null } = { current: null };
    try {
      const surface = await host.canvas2d.mount((input) => holder.current?.input(input));
      const instance = new TimelineProjectionInstance(host, surface);
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

export const TIMELINE_PROJECTION: ViewProjection = new TimelineProjection();
