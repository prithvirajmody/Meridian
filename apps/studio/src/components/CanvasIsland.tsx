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
    // React owns only the medium-neutral layout box. The projection host owns
    // the fresh canvas/scene lifecycle, including StrictMode double mounts.
    const projectionHost = runtime.createProjectionHost(host);
    return () => {
      runtime.releaseProjectionHost(projectionHost);
    };
  }, [runtime]);

  return <div className="canvas-island" data-testid="canvas-island" ref={hostRef} />;
}
