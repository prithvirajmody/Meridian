/**
 * Renderer-owned retained 2D-canvas medium for canvas projections (matrix,
 * timeline). Structurally mirrors the projections package's `Canvas2dSurface`
 * contract: only plain data crosses this boundary — the canvas element,
 * context, and rasterization cadence stay private to the renderer.
 */

/** Data-only draw list; coordinates are logical (CSS) pixels. */
export interface ProjectionCanvasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: string;
}

export interface ProjectionCanvasLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly color: string;
  readonly width: number;
}

export interface ProjectionCanvasLabel {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly color: string;
  readonly size: number;
  readonly align: 'left' | 'center' | 'right';
}

export interface ProjectionCanvasFrame {
  readonly revision: string;
  readonly background: string;
  readonly rects: readonly ProjectionCanvasRect[];
  readonly lines: readonly ProjectionCanvasLine[];
  readonly labels: readonly ProjectionCanvasLabel[];
  readonly message: string | null;
}

export type ProjectionCanvasPointerAction = 'down' | 'move' | 'up' | 'leave';

export type ProjectionCanvasInput =
  | {
      readonly type: 'pointer';
      readonly action: ProjectionCanvasPointerAction;
      readonly x: number;
      readonly y: number;
      readonly primary: boolean;
    }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly deltaY: number }
  | { readonly type: 'resize'; readonly width: number; readonly height: number };

export interface ProjectionCanvasSurface {
  render(frame: ProjectionCanvasFrame): void;
  destroy(): void;
}

/** Mount the concrete, renderer-owned canvas medium into `container`. */
export function mountProjectionCanvas(
  container: HTMLElement,
  onInput: (input: ProjectionCanvasInput) => void,
): ProjectionCanvasSurface {
  const document = container.ownerDocument;
  const view = document.defaultView;

  const canvas = document.createElement('canvas');
  canvas.className = 'meridian-projection-canvas';
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  canvas.tabIndex = 0;

  const message = document.createElement('div');
  message.className = 'meridian-projection-canvas-message';
  message.setAttribute('role', 'status');
  message.hidden = true;

  container.append(canvas, message);

  let destroyed = false;
  let frame: ProjectionCanvasFrame | null = null;
  let animationFrame: number | null = null;
  let microtaskPending = false;

  function logicalSize(): { width: number; height: number } {
    return {
      width: Math.max(0, canvas.clientWidth),
      height: Math.max(0, canvas.clientHeight),
    };
  }

  function paint(): void {
    if (animationFrame !== null && view !== null) view.cancelAnimationFrame(animationFrame);
    animationFrame = null;
    microtaskPending = false;
    if (destroyed || frame === null) return;
    const current = frame;
    const { width, height } = logicalSize();
    const ratio = Math.max(1, view?.devicePixelRatio ?? 1);
    const deviceWidth = Math.max(1, Math.round(width * ratio));
    const deviceHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== deviceWidth) canvas.width = deviceWidth;
    if (canvas.height !== deviceHeight) canvas.height = deviceHeight;

    const context = canvas.getContext('2d');
    if (context === null) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = current.background;
    context.fillRect(0, 0, width, height);

    for (const rect of current.rects) {
      context.fillStyle = rect.fill;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    for (const line of current.lines) {
      context.strokeStyle = line.color;
      context.lineWidth = line.width;
      context.beginPath();
      context.moveTo(line.x1, line.y1);
      context.lineTo(line.x2, line.y2);
      context.stroke();
    }
    context.textBaseline = 'middle';
    for (const label of current.labels) {
      context.fillStyle = label.color;
      context.font = `${label.size}px system-ui, sans-serif`;
      context.textAlign = label.align;
      context.fillText(label.text, label.x, label.y);
    }

    canvas.setAttribute('data-canvas-revision', current.revision);
    const showMessage = current.message !== null;
    message.hidden = !showMessage;
    // Message text is assigned through textContent only; no markup is parsed.
    message.textContent = showMessage ? current.message : '';
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

  function pointerPosition(event: MouseEvent): { x: number; y: number } {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  const pointerHandler = (action: ProjectionCanvasPointerAction) => (event: PointerEvent): void => {
    const { x, y } = pointerPosition(event);
    onInput({ type: 'pointer', action, x, y, primary: event.button === 0 || action !== 'down' });
  };
  const onPointerDown = pointerHandler('down');
  const onPointerMove = pointerHandler('move');
  const onPointerUp = pointerHandler('up');
  const onPointerLeave = pointerHandler('leave');
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const { x, y } = pointerPosition(event);
    onInput({ type: 'wheel', x, y, deltaY: event.deltaY });
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const emitResize = (): void => {
    const { width, height } = logicalSize();
    onInput({ type: 'resize', width, height });
    schedulePaint();
  };
  const ResizeObserverConstructor = view?.ResizeObserver;
  const resizeObserver =
    ResizeObserverConstructor === undefined
      ? null
      : new ResizeObserverConstructor(() => {
          emitResize();
        });
  resizeObserver?.observe(canvas);
  const onWindowResize = (): void => emitResize();
  if (resizeObserver === null) view?.addEventListener('resize', onWindowResize);

  return {
    render(nextFrame): void {
      if (destroyed) {
        throw new Error('renderer: projection canvas.render called after destroy');
      }
      frame = nextFrame;
      schedulePaint();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (animationFrame !== null && view !== null) view.cancelAnimationFrame(animationFrame);
      animationFrame = null;
      microtaskPending = false;
      resizeObserver?.disconnect();
      if (resizeObserver === null) view?.removeEventListener('resize', onWindowResize);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.remove();
      message.remove();
      frame = null;
    },
  };
}
