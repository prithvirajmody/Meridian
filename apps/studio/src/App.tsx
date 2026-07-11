import { useCallback } from 'react';
import { useStore } from 'zustand';
import { CanvasIsland } from './components/CanvasIsland.js';
import { DebugHud } from './components/DebugHud.js';
import { SelectedPanel } from './components/SelectedPanel.js';
import type { StudioRuntime } from './runtime.js';
import { StudioStoreCommands } from './store.js';

export interface AppProps {
  readonly runtime: StudioRuntime;
}

export function App({ runtime }: AppProps) {
  const phase = useStore(runtime.store, (state) => state.phase);
  const message = useStore(runtime.store, (state) => state.message);
  const source = useStore(runtime.store, (state) => state.source);
  const adapter = useStore(runtime.store, (state) => state.adapter);
  const panel = useStore(runtime.store, (state) => state.panel);
  const selectionStartedAtMs = useStore(runtime.store, (state) => state.selectionStartedAtMs);
  const hover = useStore(runtime.store, (state) => state.hover);
  const diagnostics = useStore(runtime.store, (state) => state.diagnostics);
  const stats = useStore(runtime.store, (state) => state.rendererStats);
  const metrics = useStore(runtime.store, (state) => state.metrics);
  const debugEnabled = useStore(runtime.store, (state) => state.debugEnabled);

  const commitSelection = useCallback(
    (startedAtMs: number, committedAtMs: number) => {
      new StudioStoreCommands(runtime.store).recordInteractionCommitted(startedAtMs, committedAtMs);
    },
    [runtime],
  );

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">M</span>
          <div>
            <p className="eyebrow">Universal semantic graph</p>
            <h1>Meridian Studio</h1>
          </div>
        </div>
        <label className="file-button">
          <span>Open corpus</span>
          <input
            type="file"
            accept=".md,.markdown,.mdown,.txt,text/markdown,text/plain"
            data-testid="file-input"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file !== undefined) void runtime.session.openFile(file);
              event.currentTarget.value = '';
            }}
          />
        </label>
      </header>

      <section className="workspace">
        <section className="stage" aria-label="Graph workspace">
          <div className="stage-meta">
            <div>
              <span className={`phase-dot phase-${phase}`} aria-hidden="true" />
              <strong data-testid="pipeline-phase">{phase}</strong>
              <span data-testid="pipeline-message">{message}</span>
            </div>
            <div className="chips">
              {source ? <span data-testid="source-name">{source.name}</span> : null}
              {adapter ? (
                <span data-testid="adapter-name">
                  {adapter.domain} · {Math.round(adapter.score * 100)}%
                </span>
              ) : null}
              <span data-testid="hover-readout">
                {hover === null
                  ? 'hover —'
                  : hover.element.kind === 'node'
                    ? `hover ${hover.element.nodeId}`
                    : `hover ${hover.element.edgeKey}`}
              </span>
            </div>
          </div>
          <CanvasIsland runtime={runtime} />
          {debugEnabled ? <DebugHud stats={stats} metrics={metrics} /> : null}
          {diagnostics.length > 0 ? (
            <div className="diagnostic-strip" role="status" data-testid="diagnostics">
              {diagnostics.at(-1)?.code}: {diagnostics.at(-1)?.message}
            </div>
          ) : null}
        </section>

        <SelectedPanel
          panel={panel}
          selectionStartedAtMs={selectionStartedAtMs}
          onCommitted={commitSelection}
        />
      </section>
    </main>
  );
}
