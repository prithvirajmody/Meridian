import {
  EMPTY_SELECTION,
  type NodeId,
  type ProjectionModel,
  type ProjectionNode,
  type SelectionState,
  type TemporalDomainHints,
} from '@meridian/view-model';
import { describe, expect, it, vi } from 'vitest';
import {
  TIMELINE_AXIS_HEIGHT_PX,
  TIMELINE_GUTTER_LEFT_PX,
  TimelineProjection,
  timelineEvents,
  timelineTickLabel,
  type Canvas2dFrame,
  type Canvas2dInput,
  type Canvas2dSurface,
  type ProjectionDiagnostic,
  type ProjectionHost,
} from '../src/index.js';

const HINTS: TemporalDomainHints = {
  startAttribute: 't:start',
  laneAttribute: 't:lane',
};

function id(value: string): NodeId {
  return value as NodeId;
}

function node(
  value: string,
  options: Partial<ProjectionNode> & { readonly startMs?: number; readonly endMs?: number; readonly lane?: string } = {},
): ProjectionNode {
  const { startMs, endMs, lane, ...rest } = options;
  return {
    id: id(value),
    label: `${value} label`,
    kind: 'test:item',
    attrs: lane === undefined ? {} : { 't:lane': lane },
    graphId: null,
    parentId: null,
    detailGraphId: null,
    depth: 0,
    cutReason: null,
    coveredLeaves: 1,
    orderPath: [0],
    temporal: startMs === undefined ? null : { start: startMs, end: endMs ?? startMs },
    ...rest,
  };
}

function model(
  nodes: readonly ProjectionNode[],
  options: {
    readonly selection?: SelectionState;
    readonly focus?: NodeId | null;
    readonly temporal?: TemporalDomainHints | undefined;
  } = {},
): ProjectionModel {
  return {
    cutLevel: 0,
    nodes,
    inducedEdges: [],
    selection: options.selection ?? EMPTY_SELECTION,
    focus: { node: options.focus ?? null },
    domainMeta: {
      domain: 'test',
      label: 'Test',
      ...('temporal' in options
        ? options.temporal === undefined
          ? {}
          : { temporal: options.temporal }
        : { temporal: HINTS }),
    },
    diagnostics: [],
  };
}

function fixture() {
  const frames: Canvas2dFrame[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];
  const selections: Array<{ nodeId: NodeId; mode: 'replace' | 'toggle' }> = [];
  let input: ((value: Canvas2dInput) => void) | null = null;
  let destroys = 0;
  const surface: Canvas2dSurface = {
    render: (frame) => frames.push(frame),
    destroy: () => {
      destroys++;
    },
  };
  const host: ProjectionHost = {
    nodeLink: { mount: async () => Promise.reject(new Error('unused')) },
    virtualList: { mount: async () => Promise.reject(new Error('unused')) },
    canvas2d: {
      mount: vi.fn(async (sink) => {
        input = sink;
        return surface;
      }),
    },
    viewport: () => ({ width: 920, height: 428, devicePixelRatio: 1 }),
    now: () => 0,
    selectNode: (nodeId, mode) => selections.push({ nodeId, mode }),
    selectEdges: vi.fn(),
    focusNode: vi.fn(),
    navigate: vi.fn(),
    reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    showDegraded: vi.fn(),
  };
  return {
    host,
    frames,
    diagnostics,
    selections,
    destroys: () => destroys,
    input: (value: Canvas2dInput) => {
      if (input === null) throw new Error('timeline input was not mounted');
      input(value);
    },
  };
}

const T0 = Date.parse('2026-07-15T10:00:00Z');
const MINUTE = 60_000;

describe('timelineEvents', () => {
  it('extracts lanes from the declared lane attr and trails the unset lane', () => {
    const { events, lanes, untimed } = timelineEvents(model([
      node('m2', { startMs: T0 + MINUTE, lane: 'user' }),
      node('m1', { startMs: T0, lane: 'assistant' }),
      node('bare', { startMs: T0 + 2 * MINUTE }),
      node('untimed'),
    ]));
    expect(events.map((event) => event.id)).toEqual([id('m1'), id('m2'), id('bare')]);
    expect(lanes).toEqual(['assistant', 'user', '(none)']);
    expect(untimed).toBe(1);
  });

  it('uses a single lane when the domain declares no lane attribute', () => {
    const { lanes } = timelineEvents(
      model([node('a', { startMs: T0 })], { temporal: { startAttribute: 't:start' } }),
    );
    expect(lanes).toEqual(['(all)']);
  });
});

describe('timelineTickLabel', () => {
  it('sizes the label to the visible span deterministically (UTC)', () => {
    expect(timelineTickLabel(T0, 30 * MINUTE)).toBe('10:00:00');
    expect(timelineTickLabel(T0, 5 * 3_600_000)).toBe('07-15 10:00');
    expect(timelineTickLabel(T0, 96 * 3_600_000)).toBe('2026-07-15');
  });
});

describe('TimelineProjection', () => {
  it('suitability requires declared hints and usable data', () => {
    const projection = new TimelineProjection();
    const timed = model([node('a', { startMs: T0 }), node('b', { startMs: T0 + MINUTE })]);
    expect(projection.suitability(timed)).toBeGreaterThan(0.8);
    expect(projection.suitability(model([node('a')]))).toBe(0);
    expect(projection.suitability(model([node('a', { startMs: T0 })], { temporal: undefined }))).toBe(0);
    expect(projection.suitability(model([]))).toBe(0);
  });

  it('renders lane bands, axis, and bars for a timed conversation-shaped cut', async () => {
    const f = fixture();
    const instance = await new TimelineProjection().mount(f.host);
    instance.render(model([
      node('m1', { startMs: T0, lane: 'user' }),
      node('m2', { startMs: T0 + MINUTE, endMs: T0 + 2 * MINUTE, lane: 'assistant' }),
    ]));

    const frame = f.frames.at(-1)!;
    expect(frame.message).toBeNull();
    expect(frame.labels.some((label) => label.text === 'user')).toBe(true);
    expect(frame.labels.some((label) => label.text === 'assistant')).toBe(true);
    // Two bars plus lane band; the ranged bar is wider than the point bar.
    const bars = frame.rects.filter((rect) => rect.height > 3 && rect.width >= 3);
    expect(bars.length).toBeGreaterThanOrEqual(2);
  });

  it('degrades with specific messages: atemporal domain, timeless cut, empty cut — never crashes', async () => {
    const f = fixture();
    const instance = await new TimelineProjection().mount(f.host);

    instance.render(model([node('a'), node('b')], { temporal: undefined }));
    expect(f.frames.at(-1)?.message).toMatch(/declares no time attributes/i);

    instance.render(model([node('a'), node('b')]));
    expect(f.frames.at(-1)?.message).toMatch(/no node in this cut carries a usable timestamp/i);

    instance.render(model([]));
    expect(f.frames.at(-1)?.message).toBe('No visible nodes in this cut.');
  });

  it('maps a click on a bar to node selection and ignores empty space', async () => {
    const f = fixture();
    const instance = await new TimelineProjection().mount(f.host);
    instance.render(model([
      node('early', { startMs: T0, endMs: T0 + 10 * MINUTE, lane: 'user' }),
    ]));

    const click = (x: number, y: number): void => {
      f.input({ type: 'pointer', action: 'down', x, y, primary: true });
      f.input({ type: 'pointer', action: 'up', x, y, primary: true });
    };
    // The single lane fills the plot; the bar spans most of the window width.
    click(TIMELINE_GUTTER_LEFT_PX + 400, TIMELINE_AXIS_HEIGHT_PX + 20);
    expect(f.selections.at(-1)).toEqual({ nodeId: id('early'), mode: 'replace' });

    const before = f.selections.length;
    click(TIMELINE_GUTTER_LEFT_PX - 40, TIMELINE_AXIS_HEIGHT_PX + 20);
    expect(f.selections.length).toBe(before);
  });

  it('zooms about the cursor, pans by drag, and round-trips view state', async () => {
    const f = fixture();
    const instance = await new TimelineProjection().mount(f.host);
    const nodes = Array.from({ length: 30 }, (_, index) =>
      node(`n${index}`, { startMs: T0 + index * MINUTE, lane: index % 2 === 0 ? 'a' : 'b' }),
    );
    instance.render(model(nodes));
    const initial = instance.captureViewState() as {
      readonly windowStart: number;
      readonly windowEnd: number;
    };

    f.input({ type: 'wheel', x: TIMELINE_GUTTER_LEFT_PX + 200, y: 100, deltaY: -600 });
    const zoomed = instance.captureViewState() as {
      readonly windowStart: number;
      readonly windowEnd: number;
    };
    expect(zoomed.windowEnd - zoomed.windowStart).toBeLessThan(
      initial.windowEnd - initial.windowStart,
    );

    f.input({ type: 'pointer', action: 'down', x: 500, y: 200, primary: true });
    f.input({ type: 'pointer', action: 'move', x: 400, y: 200, primary: true });
    f.input({ type: 'pointer', action: 'up', x: 400, y: 200, primary: true });
    const panned = instance.captureViewState() as { readonly windowStart: number };
    expect(panned.windowStart).toBeGreaterThan(zoomed.windowStart);
    expect(f.selections).toEqual([]);

    const saved = instance.captureViewState();
    const g = fixture();
    const second = await new TimelineProjection().mount(g.host);
    second.restoreViewState(saved);
    second.render(model(nodes));
    expect(second.captureViewState()).toEqual(saved);
    expect(g.diagnostics).toEqual([]);
  });

  it('diagnoses malformed view state and falls back to the fitted window', async () => {
    const f = fixture();
    const instance = await new TimelineProjection().mount(f.host);
    instance.restoreViewState({ version: 1, windowStart: 10, windowEnd: 5, laneOffset: 0 });
    expect(f.diagnostics.at(-1)).toMatchObject({
      projectionId: 'timeline',
      code: 'invalid-view-state',
      phase: 'view-state',
    });
    instance.render(model([node('a', { startMs: T0 })]));
    expect(f.frames.at(-1)?.message).toBeNull();
  });

  it('reveals focus by recentring the window, falling back to the node anchor', async () => {
    const f = fixture();
    const instance = await new TimelineProjection().mount(f.host);
    const nodes = Array.from({ length: 60 }, (_, index) =>
      node(`n${index}`, { startMs: T0 + index * MINUTE }),
    );
    instance.render(model(nodes, { focus: id('n59') }));
    // Zoom deep so the fitted window no longer contains the last event.
    f.input({ type: 'wheel', x: TIMELINE_GUTTER_LEFT_PX, y: 100, deltaY: -4_000 });
    instance.applyFocus({ node: id('n59') });
    instance.revealFocus();
    const focused = instance.captureViewState() as {
      readonly windowStart: number;
      readonly windowEnd: number;
    };
    const lastStart = T0 + 59 * MINUTE;
    expect(focused.windowStart).toBeLessThanOrEqual(lastStart);
    expect(focused.windowEnd).toBeGreaterThanOrEqual(lastStart);

    instance.applyFocus({ node: null });
    instance.applySelection({
      nodes: [id('n0')],
      edges: [],
      anchor: { kind: 'node', id: id('n0') },
    });
    instance.revealFocus();
    const anchored = instance.captureViewState() as {
      readonly windowStart: number;
      readonly windowEnd: number;
    };
    expect(anchored.windowStart).toBeLessThanOrEqual(T0);
    expect(anchored.windowEnd).toBeGreaterThanOrEqual(T0);
  });

  it('reports mount failure, destroys idempotently, and rejects later lifecycle calls', async () => {
    const failure = new Error('canvas host unavailable');
    const f = fixture();
    f.host.canvas2d.mount = async () => Promise.reject(failure);
    await expect(new TimelineProjection().mount(f.host)).rejects.toBe(failure);
    expect(f.diagnostics.at(-1)).toMatchObject({ code: 'mount-failed', phase: 'mount' });

    const healthy = fixture();
    const instance = await new TimelineProjection().mount(healthy.host);
    instance.destroy();
    instance.destroy();
    expect(healthy.destroys()).toBe(1);
    expect(() => instance.render(model([]))).toThrow('timeline.render called after destroy');
    expect(() => instance.captureViewState()).toThrow(
      'timeline.captureViewState called after destroy',
    );
  });
});
