import { useStore } from 'zustand';
import type { StudioRuntime } from '../runtime.js';

export interface BreadcrumbBarProps {
  readonly runtime: StudioRuntime;
}

/**
 * ADR-0025 breadcrumbs: derived, never stored — this bar renders the
 * `NavContext` trail published to the store and dispatches drill-out pops
 * through the navigator (a click may pop several frames).
 */
export function BreadcrumbBar({ runtime }: BreadcrumbBarProps) {
  const nav = useStore(runtime.store, (state) => state.nav);
  if (nav === null) return null;
  return (
    <nav className="breadcrumb-bar" aria-label="Drill context" data-testid="breadcrumb-bar">
      {nav.breadcrumbs.map((crumb, index) => {
        const depth = index + 1;
        const isCurrent = depth === nav.depth;
        const label = crumb.label ?? (index === 0 ? 'root' : (crumb.node ?? crumb.graphId));
        return (
          <span className="breadcrumb" key={`${crumb.graphId}:${index}`}>
            {index > 0 ? <span className="breadcrumb-sep" aria-hidden="true">›</span> : null}
            <button
              type="button"
              data-testid={`breadcrumb-${index}`}
              className={isCurrent ? 'breadcrumb-current' : 'breadcrumb-link'}
              disabled={isCurrent}
              onClick={() => runtime.navigator()?.breadcrumbTo(depth)}
              title={crumb.graphId}
            >
              {label}
            </button>
          </span>
        );
      })}
      <span className="breadcrumb-meta" data-testid="breadcrumb-meta">
        level {nav.level} · z {nav.zoom.toFixed(2)} · {nav.cutSize} visible
        {nav.saturated ? ' · finest — Enter opens the selection' : ''}
      </span>
      {nav.notice !== null ? (
        <span className="nav-notice" role="status" data-testid="nav-notice">
          {nav.notice.code}: {nav.notice.message}
        </span>
      ) : null}
    </nav>
  );
}
