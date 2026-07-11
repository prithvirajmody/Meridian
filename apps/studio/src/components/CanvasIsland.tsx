import { useEffect, useRef } from 'react';
import type { StudioRuntime } from '../runtime.js';

export interface CanvasIslandProps {
  readonly runtime: StudioRuntime;
}

/** React owns only the layout box and canvas host (ADR-0022). */
export function CanvasIsland({ runtime }: CanvasIslandProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    // A WebGL canvas is single-lifecycle: Pixi teardown loses its context for
    // good, so every bridge mount (including StrictMode's dev double-mount)
    // must get a fresh element rather than reuse a canvas whose context died.
    const canvas = host.ownerDocument.createElement('canvas');
    canvas.setAttribute('aria-label', 'Meridian graph canvas');
    canvas.setAttribute('data-testid', 'graph-canvas');
    host.append(canvas);
    const bridge = runtime.createBridge(canvas);
    return () => {
      runtime.releaseBridge(bridge);
      canvas.remove();
    };
  }, [runtime]);

  return <div className="canvas-island" data-testid="canvas-island" ref={hostRef} />;
}
