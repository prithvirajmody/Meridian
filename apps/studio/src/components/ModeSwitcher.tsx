import { useStore } from 'zustand';
import type { StudioRuntime } from '../runtime.js';

export interface ModeSwitcherProps {
  readonly runtime: StudioRuntime;
}

/**
 * The 10F projection mode switcher. Suitability orders the menu but never
 * forbids a choice (ADR-0036) — an unsuitable projection still mounts and
 * shows its own degraded message. Value-only React: the click hands an id to
 * the runtime; the coordinator owns the switch transaction.
 */
export function ModeSwitcher({ runtime }: ModeSwitcherProps) {
  const projectionId = useStore(runtime.store, (state) => state.projectionId);
  // Re-rank whenever the semantic model changes; ranking itself is pure.
  useStore(runtime.store, (state) => state.projectionModel);
  const ranked = runtime.rankedProjections();
  if (ranked.length === 0) return null;

  return (
    <div className="mode-switcher" data-testid="mode-switcher" role="group" aria-label="View mode">
      {ranked.map(({ id, label, suitability }) => (
        <button
          key={id}
          type="button"
          data-testid={`mode-${id}`}
          data-suitability={suitability.toFixed(2)}
          aria-pressed={projectionId === id}
          onClick={() => {
            void runtime.switchProjection(id);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
