import { useStore } from 'zustand';
import type { StudioRuntime } from '../runtime.js';

export interface ProvenanceControlsProps {
  readonly runtime: StudioRuntime;
}

/**
 * The global provenance filter (ADR-0031 §8.1.3): one toggle between showing the
 * whole graph and an evidence-only view that hides all AI-origin structure. The
 * badge count is the number of AI-origin nodes in the current cut. Filtering is a
 * view op — nothing leaves the store.
 */
export function ProvenanceControls({ runtime }: ProvenanceControlsProps) {
  const view = useStore(runtime.store, (state) => state.ai.provenanceView);
  const aiNodeCount = useStore(runtime.store, (state) => state.ai.summary.aiNodeCount);
  const evidenceOnly = view === 'evidence-only';

  return (
    <div className="provenance-controls" data-testid="provenance-controls">
      <span className="ai-origin-count" data-testid="ai-origin-count" title="AI-origin nodes in view">
        <span className="ai-dot" aria-hidden="true" />
        {aiNodeCount} AI
      </span>
      <button
        type="button"
        className={`provenance-toggle${evidenceOnly ? ' is-evidence-only' : ''}`}
        data-testid="provenance-filter-toggle"
        data-view={view}
        aria-pressed={evidenceOnly}
        onClick={() => runtime.session.setProvenanceView(evidenceOnly ? 'all' : 'evidence-only')}
      >
        {evidenceOnly ? 'Evidence only' : 'Show AI'}
      </button>
    </div>
  );
}
