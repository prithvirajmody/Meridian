import { describe, expect, it } from 'vitest';
import {
  mountProjectionCanvas,
  type ProjectionCanvasFrame,
  type ProjectionCanvasInput,
} from '../src/projection-canvas.js';

type Listener = (event: unknown) => void;

class FakeContext {
  readonly calls: Array<{ readonly op: string; readonly args: readonly unknown[] }> = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  font = '';
  textAlign = '';
  textBaseline = '';

  private record(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }

  setTransform(...args: unknown[]): void {
    this.record('setTransform', ...args);
  }
  clearRect(...args: unknown[]): void {
    this.record('clearRect', ...args);
  }
  fillRect(...args: unknown[]): void {
    this.record('fillRect', this.fillStyle, ...args);
  }
  beginPath(): void {
    this.record('beginPath');
  }
  moveTo(...args: unknown[]): void {
    this.record('moveTo', ...args);
  }
  lineTo(...args: unknown[]): void {
    this.record('lineTo', ...args);
  }
  stroke(): void {
    this.record('stroke', this.strokeStyle, this.lineWidth);
  }
  fillText(...args: unknown[]): void {
    this.record('fillText', this.fillStyle, this.textAlign, ...args);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly style: Record<string, string> = {};
  className = '';
  hidden = false;
  textContent = '';
  tabIndex = -1;
  width = 0;
  height = 0;
  clientWidth = 400;
  clientHeight = 300;
  removed = false;
  parent: FakeElement | null = null;
  readonly context = new FakeContext();

  constructor(
    readonly tagName: string,
    private readonly document: FakeDocument,
  ) {}

  get ownerDocument(): FakeDocument {
    return this.document;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      node.clientWidth = this.clientWidth;
      node.clientHeight = this.clientHeight;
      this.children.push(node);
    }
  }

  remove(): void {
    this.removed = true;
    if (this.parent !== null) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  getContext(kind: string): FakeContext | null {
    return kind === '2d' ? this.context : null;
  }

  getBoundingClientRect(): { left: number; top: number } {
    return { left: 10, top: 20 };
  }
}

class FakeDocument {
  readonly defaultView = null;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function frame(overrides: Partial<ProjectionCanvasFrame> = {}): ProjectionCanvasFrame {
  return {
    revision: 'frame-1',
    background: '#101318',
    rects: [{ x: 1, y: 2, width: 3, height: 4, fill: '#123456' }],
    lines: [{ x1: 0, y1: 0, x2: 5, y2: 5, color: '#654321', width: 2 }],
    labels: [{ x: 8, y: 9, text: 'row', color: '#cbd5e1', size: 11, align: 'right' }],
    message: null,
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function harness() {
  const document = new FakeDocument();
  const container = document.createElement('div');
  const inputs: ProjectionCanvasInput[] = [];
  const surface = mountProjectionCanvas(container as unknown as HTMLElement, (input) =>
    inputs.push(input),
  );
  const canvas = container.children.find((child) => child.tagName === 'canvas')!;
  const message = container.children.find((child) => child.tagName === 'div')!;
  return { container, surface, canvas, message, inputs };
}

describe('mountProjectionCanvas', () => {
  it('paints the retained draw list in order: background, rects, lines, labels', async () => {
    const { surface, canvas } = harness();
    surface.render(frame());
    await flushMicrotasks();

    const ops = canvas.context.calls.map((call) => call.op);
    expect(ops.slice(0, 3)).toEqual(['setTransform', 'clearRect', 'fillRect']);
    expect(canvas.context.calls[2]!.args[0]).toBe('#101318');
    expect(ops).toContain('stroke');
    expect(ops.indexOf('stroke')).toBeGreaterThan(ops.lastIndexOf('fillRect'));
    const text = canvas.context.calls.find((call) => call.op === 'fillText')!;
    expect(text.args).toEqual(['#cbd5e1', 'right', 'row', 8, 9]);
    expect(canvas.attributes.get('data-canvas-revision')).toBe('frame-1');
  });

  it('shows and clears the status message without parsing markup', async () => {
    const { surface, message } = harness();
    surface.render(frame({ message: '<b>degraded</b> & message' }));
    await flushMicrotasks();
    expect(message.hidden).toBe(false);
    expect(message.textContent).toBe('<b>degraded</b> & message');
    expect(message.attributes.get('role')).toBe('status');

    surface.render(frame({ revision: 'frame-2', message: null }));
    await flushMicrotasks();
    expect(message.hidden).toBe(true);
    expect(message.textContent).toBe('');
  });

  it('coalesces renders: only the latest frame is painted per flush', async () => {
    const { surface, canvas } = harness();
    surface.render(frame({ revision: 'frame-1' }));
    surface.render(frame({ revision: 'frame-2' }));
    surface.render(frame({ revision: 'frame-3' }));
    await flushMicrotasks();

    expect(canvas.attributes.get('data-canvas-revision')).toBe('frame-3');
    const paints = canvas.context.calls.filter((call) => call.op === 'clearRect');
    expect(paints).toHaveLength(1);
  });

  it('maps pointer and wheel events to plain logical-pixel inputs', () => {
    const { canvas, inputs } = harness();
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 120, button: 0 });
    canvas.dispatch('pointermove', { clientX: 130, clientY: 140, button: 0 });
    canvas.dispatch('pointerup', { clientX: 130, clientY: 140, button: 0 });
    canvas.dispatch('wheel', {
      clientX: 60,
      clientY: 70,
      deltaY: -120,
      preventDefault: () => undefined,
    });

    expect(inputs).toEqual([
      { type: 'pointer', action: 'down', x: 100, y: 100, primary: true },
      { type: 'pointer', action: 'move', x: 120, y: 120, primary: true },
      { type: 'pointer', action: 'up', x: 120, y: 120, primary: true },
      { type: 'wheel', x: 50, y: 50, deltaY: -120 },
    ]);
  });

  it('destroys idempotently, detaches everything, and rejects later renders', () => {
    const { surface, canvas, message, container } = harness();
    surface.destroy();
    surface.destroy();

    expect(canvas.removed).toBe(true);
    expect(message.removed).toBe(true);
    expect(container.children).toHaveLength(0);
    expect([...canvas.listeners.values()].flat()).toHaveLength(0);
    expect(() => surface.render(frame())).toThrow(
      'renderer: projection canvas.render called after destroy',
    );
  });
});
