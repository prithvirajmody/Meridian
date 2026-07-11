import type { StudioMetrics } from '../store.js';
import type { RendererStats } from '@meridian/renderer';

export interface DebugHudProps {
  readonly stats: RendererStats | null;
  readonly metrics: StudioMetrics;
}

function value(number: number | null | undefined, suffix = ''): string {
  return number === null || number === undefined ? '—' : `${number.toFixed(2)}${suffix}`;
}

export function DebugHud({ stats, metrics }: DebugHudProps) {
  return (
    <output className="debug-hud" data-testid="debug-hud" aria-label="Renderer diagnostics">
      <strong>Render HUD</strong>
      <span>frame {value(stats?.frameTimeMs, 'ms')}</span>
      <span>draws {stats?.drawCalls ?? '—'}</span>
      <span>visible {stats ? `${stats.visibleNodes}/${stats.modelNodes}` : '—'}</span>
      <span>labels {stats?.liveLabels ?? '—'}</span>
      <span>pick {value(stats?.pickQueryTimeMs, 'ms')}</span>
      <span>first {value(metrics.firstRenderMs, 'ms')}</span>
      <span>select {value(metrics.interactionLatencyMs, 'ms')}</span>
      <span>
        heap {metrics.heapBytes === null ? '—' : `${(metrics.heapBytes / 1_048_576).toFixed(1)}MiB`}
      </span>
    </output>
  );
}
