/**
 * Studio's imperative composition root (ADR-0022): source I/O arrives as a
 * value, then plugin sniff/ingest → IR gate → op-based store → navigator boot
 * (LOD → layout → pure RenderModel) → 6D choreography. No service instance
 * enters React or Zustand state.
 */
import { buildLevelChain, type LevelChain, type LodResult, type ZoomPolicy } from '@meridian/abstraction';
import { markdownPlugin } from '@meridian/adapter-markdown';
import {
  createGraphSpace,
  decode,
  deriveEdgeId,
  deriveGraphId,
  deriveNodeId,
  encode,
  type EdgeId,
  type GraphId,
  type GraphSpace,
  type NodeId,
  type SemanticEdge,
  type SemanticGraph,
} from '@meridian/graph-core';
import {
  createStore,
  decodeDeltaInput,
  diffSpaces,
  formatVersion,
  type GraphStore,
} from '@meridian/graph-store';
import { BUILTIN_LAYOUT_PROVIDERS, type LayoutInput, type LayoutResult } from '@meridian/layout';
import type { IdFacade, SourceDescriptor } from '@meridian/plugin-api';
import { createPluginHost, type PluginHost } from '@meridian/plugin-host';
import type { RenderModel, SelectionState, ViewportSize } from '@meridian/view-model';
import { StudioNavigator } from './navigation/studio-navigator.js';
import type { StudioLayoutService } from './pipeline/layout-cut.js';
import { realClock, type StudioClock } from './transition/clock.js';
import {
  StudioStoreCommands,
  type SelectedElementPanel,
  type StudioStore,
} from './store.js';

export type { StudioLayoutService } from './pipeline/layout-cut.js';

export class DirectStudioLayoutService implements StudioLayoutService {
  async compute(
    providerId: string,
    input: LayoutInput,
    prev?: LayoutResult,
  ): Promise<LayoutResult> {
    const provider = BUILTIN_LAYOUT_PROVIDERS.get(providerId);
    if (provider === undefined) throw new Error(`Studio: unknown layout provider "${providerId}"`);
    return provider.compute(input, prev);
  }

  dispose(): void {}
}

interface PipelineArtifacts {
  readonly store: GraphStore;
  space: GraphSpace;
}

const idFacade: IdFacade = {
  nodeId: (coords) => deriveNodeId(coords),
  graphId: (coords) => deriveGraphId(coords),
  edgeId: (coords) =>
    deriveEdgeId({
      graph: coords.graph as GraphId,
      kind: coords.kind,
      src: coords.src as NodeId,
      dst: coords.dst as NodeId,
      ...(coords.occurrence !== undefined ? { occurrence: coords.occurrence } : {}),
    }),
};

function buildHost(): PluginHost {
  const host = createPluginHost({ ids: idFacade });
  const registered = host.register(markdownPlugin);
  if (!registered.ok) {
    throw new Error(`Studio built-in plugin registration failed: ${registered.issue.message}`);
  }
  return host;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function canonicalPolicy(chain: LevelChain): ZoomPolicy {
  const bands = Math.max(1, chain.depth);
  const thresholds: number[] = [];
  for (let index = 1; index < bands; index++) thresholds.push(index / bands);
  return { thresholds, hysteresis: 0, budget: { maxNodes: 10_000, fanOut: 32 } };
}

/** Open at the first relationally useful level when it exists, else level 0. */
function initialZoom(chain: LevelChain): number {
  const bands = Math.max(1, chain.depth);
  const level = Math.min(1, bands - 1);
  return (level + 0.5) / bands;
}

function mediaTypeFor(name: string): string | undefined {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (extension === 'md' || extension === 'markdown' || extension === 'mdown') return 'text/markdown';
  if (extension === 'txt') return 'text/plain';
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function edgeKey(src: NodeId, dst: NodeId, kind: string): string {
  return `${src}→${dst}→${kind}`;
}

function findBaseEdge(space: GraphSpace, id: EdgeId): SemanticEdge | undefined {
  for (const graph of space.graphs.values()) {
    const edge = graph.edges.get(id);
    if (edge !== undefined) return edge;
  }
  return undefined;
}

export interface StudioSessionOptions {
  readonly layoutService?: StudioLayoutService;
  /** Canvas viewport at navigator-boot time (defaults to 1280×800 headless). */
  readonly viewportProvider?: () => ViewportSize;
  /** Injected transition clock (ADR-0023). Defaults to `performance.now`. */
  readonly clock?: StudioClock;
  /** Linkable-view sink: receives the `#`-fragment on navigation settles. */
  readonly onUrl?: (fragment: string) => void;
  /** Called once per opened corpus after the navigator boots. */
  readonly onNavigatorReady?: (navigator: StudioNavigator) => void;
}

export class StudioSession {
  private readonly commands: StudioStoreCommands;
  private readonly host: PluginHost;
  private readonly layoutService: StudioLayoutService;
  private readonly options: StudioSessionOptions;
  private generation = 0;
  private artifacts: PipelineArtifacts | null = null;
  private navigator: StudioNavigator | null = null;
  private readonly unsubscribeSelection: () => void;
  private unsubscribeGraphStore: (() => void) | null = null;
  private disposed = false;

  constructor(
    readonly store: StudioStore,
    options: StudioSessionOptions = {},
  ) {
    this.commands = new StudioStoreCommands(store);
    this.host = buildHost();
    this.options = options;
    this.layoutService = options.layoutService ?? new DirectStudioLayoutService();
    this.unsubscribeSelection = store.subscribe((state, previous) => {
      if (state.selection !== previous.selection) this.selectionChanged(state.selection);
    });
  }

  /** The 6D choreography driver for the currently open corpus, if any. */
  nav(): StudioNavigator | null {
    return this.navigator?.active === true ? this.navigator : null;
  }

  async openFile(file: Pick<File, 'name' | 'size' | 'text'>): Promise<void> {
    const generation = ++this.generation;
    this.resetPipeline();
    this.commands.beginOpen({ generation, name: file.name, bytes: file.size });
    try {
      const text = await file.text();
      if (!this.isCurrent(generation)) return;
      await this.openTextInternal(generation, file.name, text);
    } catch (error) {
      this.commands.fail(generation, 'file-read-failed', errorMessage(error));
    }
  }

  async openText(name: string, text: string): Promise<void> {
    const generation = ++this.generation;
    this.resetPipeline();
    this.commands.beginOpen({
      generation,
      name,
      bytes: new TextEncoder().encode(text).byteLength,
    });
    await this.openTextInternal(generation, name, text);
  }

  private resetPipeline(): void {
    this.unsubscribeGraphStore?.();
    this.unsubscribeGraphStore = null;
    this.navigator?.destroy();
    this.navigator = null;
    this.artifacts = null;
  }

  private async openTextInternal(generation: number, name: string, text: string): Promise<void> {
    try {
      const source: SourceDescriptor = {
        uri: name,
        text,
        ...(mediaTypeFor(name) !== undefined ? { mediaType: mediaTypeFor(name) } : {}),
      };
      this.commands.stage('ingesting', 'Sniffing adapters and ingesting…');
      const resolution = this.host.resolve(source);
      const candidate = resolution.candidates[0];
      if (candidate === undefined) throw new Error(`No adapter claims ${name}`);

      const outcome = await this.host.ingest(source);
      if (!this.isCurrent(generation)) return;
      if (!outcome.ok) throw new Error(`[${outcome.issue.code}] ${outcome.issue.message}`);
      this.commands.adapterResolved({
        domain: outcome.domain,
        plugin: outcome.plugin,
        score: candidate.score,
      });

      const materialized = this.materialize(outcome);
      const store = createStore(createGraphSpace());
      const delta = diffSpaces(store.snapshot(), materialized, { actor: 'studio:ingest' });
      if (delta.ops.length > 0) {
        const applied = store.apply(delta);
        if (!applied.ok) {
          throw new Error(`Store rejected adapter output: ${applied.errors[0]?.message ?? 'unknown error'}`);
        }
      }
      const space = store.snapshot();

      this.commands.stage('resolving', 'Resolving the visible abstraction…');
      const chain = buildLevelChain(space);
      const policy = canonicalPolicy(chain);

      this.commands.stage('layout', 'Laying out…');
      const navigator = new StudioNavigator({
        space,
        policy,
        viewport: this.options.viewportProvider?.() ?? { width: 1280, height: 800 },
        initialZoom: initialZoom(chain),
        layoutService: this.layoutService,
        store: this.store,
        clock: this.options.clock ?? realClock(),
        ...(this.options.onUrl !== undefined ? { onUrl: this.options.onUrl } : {}),
      });
      const { model, message } = await navigator.boot();
      if (!this.isCurrent(generation)) {
        navigator.destroy();
        return;
      }
      const layoutReadyAtMs = now();
      this.artifacts = { store, space };
      this.navigator = navigator;
      // P1 subscription (roadmap 6D failure case): a committed delta forces a
      // replan — mid-transition included.
      this.unsubscribeGraphStore = store.subscribe(() => {
        const artifacts = this.artifacts;
        if (artifacts === null || this.navigator !== navigator) return;
        artifacts.space = store.snapshot();
        navigator.spaceMutated(artifacts.space);
      });
      this.commands.publishModel(model, formatVersion(store.version()), layoutReadyAtMs, message);
      this.options.onNavigatorReady?.(navigator);
    } catch (error) {
      this.commands.fail(generation, 'open-failed', errorMessage(error));
    }
  }

  /**
   * Apply a label edit as an op-based delta through the P1 store — the only
   * write path (never a direct space mutation). Drives the 6D
   * store-mutation-mid-transition tests.
   */
  mutateNodeLabel(nodeId: string, label: string): boolean {
    const artifacts = this.artifacts;
    if (artifacts === null) return false;
    const current = artifacts.store.snapshot();
    let touchedGraph: SemanticGraph | undefined;
    for (const graph of current.graphs.values()) {
      if (graph.nodes.has(nodeId as NodeId)) {
        touchedGraph = graph;
        break;
      }
    }
    if (touchedGraph === undefined) return false;
    const node = touchedGraph.nodes.get(nodeId as NodeId)!;
    const nodes = new Map(touchedGraph.nodes);
    nodes.set(node.id, { ...node, label });
    const graphs = new Map(current.graphs);
    graphs.set(touchedGraph.id, { ...touchedGraph, nodes });
    const modified: GraphSpace = { ...current, graphs };
    const delta = diffSpaces(current, modified, { actor: 'studio:6d-mutation' });
    if (delta.ops.length === 0) return false;
    return artifacts.store.apply(delta).ok;
  }

  private materialize(outcome: Awaited<ReturnType<PluginHost['ingest']>>): GraphSpace {
    if (!outcome.ok) throw new Error(outcome.issue.message);
    const vocabulary = this.host.vocabulary();
    if (outcome.documents.length === 1 && outcome.deltas.length === 0) {
      const gated = decode(outcome.documents[0]!, { vocabulary });
      if (!gated.ok) {
        throw new Error(`Adapter emitted invalid IR: ${gated.errors[0]?.message ?? 'unknown issue'}`);
      }
      return gated.space;
    }
    if (outcome.documents.length === 0 && outcome.deltas.length > 0) {
      const store = createStore(createGraphSpace());
      for (const wire of outcome.deltas) {
        const decoded = decodeDeltaInput(wire);
        if (!decoded.ok) throw new Error('Adapter emitted an invalid delta');
        const applied = store.apply(decoded.delta);
        if (!applied.ok) throw new Error(`Adapter delta rejected: ${applied.errors[0]?.message ?? ''}`);
      }
      const gated = decode(encode(store.snapshot()), { vocabulary });
      if (!gated.ok) throw new Error(`Delta stream emitted invalid IR: ${gated.errors[0]?.message ?? ''}`);
      return gated.space;
    }
    throw new Error(
      `Unsupported adapter emission: ${outcome.documents.length} documents and ${outcome.deltas.length} deltas`,
    );
  }

  private selectionChanged(selection: SelectionState): void {
    const navigator = this.nav();
    const artifacts = this.artifacts;
    if (navigator === null || artifacts === null) {
      this.commands.setPanel(null);
      return;
    }
    this.commands.setPanel(this.panelFor(selection, artifacts.space, navigator.currentLod()));
    this.commands.replaceModelAfterSelection(navigator.modelForSelection(selection));
  }

  private panelFor(
    selection: SelectionState,
    space: GraphSpace,
    lod: LodResult,
  ): SelectedElementPanel | null {
    const anchor = selection.anchor;
    if (anchor === undefined) return null;
    if (anchor.kind === 'node') {
      for (const graph of space.graphs.values()) {
        const node = graph.nodes.get(anchor.id);
        if (node !== undefined) {
          return {
            kind: 'node',
            id: node.id,
            label: node.label,
            semanticKind: node.kind,
            attrs: node.attrs,
            provenance: node.provenance,
          };
        }
      }
      return null;
    }
    const induced = lod.inducedEdges.find(
      (edge) => edgeKey(edge.src, edge.dst, edge.kind) === anchor.key,
    );
    const sample = induced?.samples[0];
    const edge = sample === undefined ? undefined : findBaseEdge(space, sample);
    if (induced === undefined || edge === undefined) return null;
    return {
      kind: 'edge',
      id: anchor.key,
      label: `${induced.src} → ${induced.dst}`,
      semanticKind: induced.kind,
      attrs: edge.attrs,
      provenance: edge.provenance,
    };
  }

  /** Test/support seam: publish a renderer fixture without pretending it was ingested. */
  publishFixture(model: RenderModel, name = 'renderer-fixture'): void {
    const generation = ++this.generation;
    this.resetPipeline();
    this.commands.beginOpen({ generation, name, bytes: 0 });
    this.commands.adapterResolved({ domain: 'test-fixture', plugin: 'studio:test-support', score: 1 });
    this.commands.publishModel(model, 'v0', now(), `${model.nodeIds.length.toLocaleString()} nodes · fixture`);
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.unsubscribeSelection();
    this.resetPipeline();
    await this.layoutService.dispose();
  }
}
