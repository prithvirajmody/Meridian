import { useCallback, useEffect } from 'react';
import { useStore } from 'zustand';
import { keyToNavCommand } from '@meridian/navigation';
import { AiOriginOverlay } from './components/AiOriginOverlay.js';
import { AiProposalsPanel } from './components/AiProposalsPanel.js';
import { BreadcrumbBar } from './components/BreadcrumbBar.js';
import { CanvasIsland } from './components/CanvasIsland.js';
import { DebugHud } from './components/DebugHud.js';
import { Minimap } from './components/Minimap.js';
import { ProvenanceControls } from './components/ProvenanceControls.js';
import { SearchBox } from './components/SearchBox.js';
import { SelectedPanel } from './components/SelectedPanel.js';
import { TunablesPanel } from './components/TunablesPanel.js';
import type { StudioRuntime } from './runtime.js';
import { StudioStoreCommands } from './store.js';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}

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

  // ADR-0025 keyboard verbs: Studio owns the DOM listener; the pure 6C table
  // maps keys to verbs and the navigator dispatches them.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      const command = keyToNavCommand(event.key);
      if (command === null) return;
      const navigator = runtime.navigator();
      if (navigator === null) return;
      event.preventDefault();
      const selection = runtime.store.getState().selection.nodes[0];
      navigator.dispatchKey(command.verb, command.needsSelection ? selection : undefined);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [runtime]);

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
        <SearchBox runtime={runtime} />
        <ProvenanceControls runtime={runtime} />
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
          <BreadcrumbBar runtime={runtime} />
          <div className="canvas-stack">
            <CanvasIsland runtime={runtime} />
            <AiOriginOverlay runtime={runtime} />
          </div>
          <Minimap runtime={runtime} />
          {debugEnabled ? <DebugHud stats={stats} metrics={metrics} /> : null}
          {debugEnabled ? <TunablesPanel store={runtime.store} /> : null}
          {diagnostics.length > 0 ? (
            <div className="diagnostic-strip" role="status" data-testid="diagnostics">
              {diagnostics.at(-1)?.code}: {diagnostics.at(-1)?.message}
            </div>
          ) : null}
        </section>

        <div className="side-column">
          <SelectedPanel
            panel={panel}
            selectionStartedAtMs={selectionStartedAtMs}
            onCommitted={commitSelection}
          />
          <AiProposalsPanel runtime={runtime} />
        </div>
      </section>
    </main>
  );
}
