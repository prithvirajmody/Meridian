import { useLayoutEffect } from 'react';
import type { SelectedElementPanel } from '../store.js';

export interface SelectedPanelProps {
  readonly panel: SelectedElementPanel | null;
  readonly selectionStartedAtMs: number | null;
  readonly onCommitted: (startedAtMs: number, committedAtMs: number) => void;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function SelectedPanel({
  panel,
  selectionStartedAtMs,
  onCommitted,
}: SelectedPanelProps) {
  useLayoutEffect(() => {
    if (panel !== null && selectionStartedAtMs !== null) {
      onCommitted(selectionStartedAtMs, performance.now());
    }
  }, [onCommitted, panel, selectionStartedAtMs]);

  if (panel === null) {
    return (
      <aside className="inspector" aria-label="Selection inspector" data-testid="selection-panel">
        <p className="eyebrow">Selection</p>
        <h2>Nothing selected</h2>
        <p className="muted">Click a node to inspect its attributes and provenance.</p>
      </aside>
    );
  }

  return (
    <aside
      className="inspector"
      aria-label="Selection inspector"
      data-testid="selection-panel"
      data-selected-id={panel.id}
      data-selection-started-at={selectionStartedAtMs ?? undefined}
    >
      <p className="eyebrow">Selected {panel.kind}</p>
      <h2>{panel.label}</h2>
      {panel.provenance.origin === 'ai' ? (
        <p className="ai-origin-flag" data-testid="ai-provenance-badge">
          <span className="ai-dot" aria-hidden="true" /> AI-derived
          {panel.provenance.model ? ` · ${panel.provenance.model}` : ''}
          {panel.provenance.confidence !== undefined
            ? ` · conf ${panel.provenance.confidence.toFixed(2)}`
            : ''}
        </p>
      ) : null}
      <dl className="facts">
        <div>
          <dt>ID</dt>
          <dd>{panel.id}</dd>
        </div>
        <div>
          <dt>Kind</dt>
          <dd>{panel.semanticKind}</dd>
        </div>
      </dl>
      <section>
        <h3>Attributes</h3>
        <pre data-testid="selected-attrs">{json(panel.attrs)}</pre>
      </section>
      <section>
        <h3>Provenance</h3>
        <pre data-testid="selected-provenance">{json(panel.provenance)}</pre>
      </section>
    </aside>
  );
}
