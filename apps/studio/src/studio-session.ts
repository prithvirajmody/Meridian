/**
 * Studio's imperative composition root (ADR-0022): source I/O arrives as a
 * value, then plugin sniff/ingest → IR gate → op-based store → navigator boot
 * (LOD → layout → pure RenderModel) → 6D choreography. No service instance
 * enters React or Zustand state.
 */
import { buildLevelChain, type LevelChain, type LodResult, type ZoomPolicy } from '@meridian/abstraction';
import { conversationPlugin } from '@meridian/adapter-conversation';
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
import {
  createFocusState,
  type NodeId as ViewNodeId,
  type ProjectionModel,
  type RenderModel,
  type SelectionState,
  type TemporalDomainHints,
  type ViewportSize,
} from '@meridian/view-model';
import { AiTrustController } from './ai/ai-trust-controller.js';
import {
  aiOriginNodesInModel,
  collectAiOriginNodeIds,
  filterRenderModelNodes,
} from './ai/provenance.js';
import { StudioNavigator } from './navigation/studio-navigator.js';
import type { StudioLayoutService } from './pipeline/layout-cut.js';
import { realClock, type StudioClock } from './transition/clock.js';
import {
  EMPTY_AI_ORIGIN_SUMMARY,
  StudioStoreCommands,
  type ProvenanceView,
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

const BUILTIN_PLUGINS = [markdownPlugin, conversationPlugin] as const;

function buildHost(): PluginHost {
  const host = createPluginHost({ ids: idFacade });
  for (const plugin of BUILTIN_PLUGINS) {
    const registered = host.register(plugin);
    if (!registered.ok) {
      throw new Error(`Studio built-in plugin registration failed: ${registered.issue.message}`);
    }
  }
  return host;
}

/** Declared temporal hints of the plugin claiming `domain`, if any
 * (ADR-0037): manifest metadata in, view-model vocabulary out. */
function temporalHintsForDomain(domain: string): TemporalDomainHints | undefined {
  for (const plugin of BUILTIN_PLUGINS) {
    const claims = plugin.manifest.capabilities.some(
      (capability) => capability.kind === 'domain-parser' && capability.id === domain,
    );
    const temporal = plugin.manifest.presentation?.temporal;
    if (!claims || temporal === undefined) continue;
    return {
      startAttribute: temporal.startAttribute,
      ...(temporal.endAttribute === undefined ? {} : { endAttribute: temporal.endAttribute }),
      ...(temporal.laneAttribute === undefined ? {} : { laneAttribute: temporal.laneAttribute }),
    };
  }
  return undefined;
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

/** A saved `.meridian` graph document (a store round-trip, not adapter IR):
 * opened by decoding directly — the U8 vocabulary gate guards the *ingest*
 * boundary between parser output and the store, not a snapshot round-trip
 * (which may legitimately carry enrichment vocabulary such as `ai:*` attrs
 * from Phase 8/9 passes that no single adapter manifest declares). */
function looksLikeGraphDocument(name: string, text: string): boolean {
  if (/\.meridian(\.json)?$/i.test(name)) return true;
  const head = text.slice(0, 4096);
  return head.includes('"formatVersion"') && head.includes('"graphs"');
}

function documentDomain(space: GraphSpace): string {
  for (const rootId of space.roots) {
    const domain = space.graphs.get(rootId)?.meta.domain;
    if (domain !== undefined) return domain;
  }
  return 'core';
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
  private readonly unsubscribeModel: () => void;
  private unsubscribeGraphStore: (() => void) | null = null;
  private disposed = false;

  /**
   * The AI human-trust controller (8F). Owns proposal→delta acceptance through
   * the one write path; lives outside Zustand (ADR-0022) like the navigator.
   */
  readonly aiTrust: AiTrustController;

  // Provenance-filter view state (8F). The pipeline always publishes the *full*
  // model; the filter is a view transform applied on top.
  private fullModel: RenderModel | null = null;
  private filteredModelRef: RenderModel | null = null;
  private aiOriginSet: ReadonlySet<ViewNodeId> = new Set();
  private aiSpaceRef: GraphSpace | null = null;

  constructor(
    readonly store: StudioStore,
    options: StudioSessionOptions = {},
  ) {
    this.commands = new StudioStoreCommands(store);
    this.host = buildHost();
    this.options = options;
    this.layoutService = options.layoutService ?? new DirectStudioLayoutService();
    this.aiTrust = new AiTrustController(store, () => this.artifacts?.store ?? null);
    this.unsubscribeSelection = store.subscribe((state, previous) => {
      if (state.selection !== previous.selection) this.selectionChanged(state.selection);
    });
    // The provenance-filter view runs off the published render model (8F): recompute
    // the AI-origin summary and re-apply the filter whenever the full model changes.
    this.unsubscribeModel = store.subscribe((state, previous) => {
      if (state.renderModel !== previous.renderModel) this.onRenderModelChanged(state.renderModel);
    });
  }

  /** Plugin-exported view projections in host resolution order (ADR-0037);
   * the composition root bridges them into the projection registry. */
  pluginViewProjections(): ReturnType<PluginHost['viewProjections']> {
    return this.host.viewProjections();
  }

  // --------------------------------------------------- AI trust: provenance view

  /** Toggle the provenance view predicate (ADR-0031) and republish accordingly. */
  setProvenanceView(view: ProvenanceView): void {
    this.commands.setProvenanceView(view);
    this.applyView();
  }

  /** AI-origin node ids present in a given full model, using a per-snapshot cache. */
  private aiIdsInModel(model: RenderModel): Set<ViewNodeId> {
    const space = this.artifacts?.space;
    if (space === undefined) return new Set();
    if (this.aiSpaceRef !== space) {
      this.aiOriginSet = collectAiOriginNodeIds(space);
      this.aiSpaceRef = space;
    }
    return new Set(aiOriginNodesInModel(model, this.aiOriginSet));
  }

  private onRenderModelChanged(model: RenderModel | null): void {
    if (model === null) {
      this.fullModel = null;
      this.filteredModelRef = null;
      this.commands.setAiOriginSummary(EMPTY_AI_ORIGIN_SUMMARY);
      this.commands.setProjectionModel(null);
      return;
    }
    // The echo of our filtered publish is the final visible working set. It
    // still needs a ProjectionModel, but must not churn the summary or loop.
    if (model === this.filteredModelRef) {
      this.commands.setProjectionModel(this.projectionForRenderModel(model));
      return;
    }
    this.fullModel = model;
    const aiIds = this.aiIdsInModel(model);
    this.commands.setAiOriginSummary({ aiNodeCount: aiIds.size, aiNodeIds: [...aiIds] });
    if (this.store.getState().ai.provenanceView === 'evidence-only' && aiIds.size > 0) {
      const filtered = filterRenderModelNodes(model, aiIds);
      this.filteredModelRef = filtered;
      this.commands.replaceModelAfterSelection(filtered);
      return;
    } else {
      this.filteredModelRef = null;
    }
    this.commands.setProjectionModel(this.projectionForRenderModel(model));
  }

  /** Build the semantic projection waist for the exact already-published map
   * value. The map field is deliberately replaced with `model` by reference so
   * the extraction cannot perturb bytes, ordering, revisions, or typed lanes. */
  private projectionForRenderModel(model: RenderModel): ProjectionModel {
    const selection = this.store.getState().selection;
    const navigator = this.nav();
    const base = navigator?.projectionModel(selection) ?? this.fixtureProjectionModel(model);
    const visibleNodes = new Set(model.nodeIds);
    const visibleEdges = new Set(model.edgeKeys);
    const nodes = base.nodes.filter((node) => visibleNodes.has(node.id));
    const inducedEdges = base.inducedEdges.filter((edge) =>
      visibleEdges.has(edgeKey(edge.src as NodeId, edge.dst as NodeId, edge.kind)),
    );
    const focus = createFocusState(navigator?.context().focus);

    const layout =
      base.layout === undefined
        ? undefined
        : {
            ...base.layout,
            positions: new Map(
              [...base.layout.positions].filter(([id]) => visibleNodes.has(id)),
            ),
            ...(base.layout.edgeRoutes === undefined
              ? {}
              : {
                  edgeRoutes: new Map(
                    [...base.layout.edgeRoutes].filter(([key]) => visibleEdges.has(key)),
                  ),
                }),
          };

    return {
      ...base,
      nodes,
      inducedEdges,
      selection,
      focus,
      ...(layout === undefined ? {} : { layout }),
      renderModel: model,
    };
  }

  /** Renderer-only fixtures still cross the same projection contract. Their
   * semantic rows are reconstructed from the RenderModel's identity tables. */
  private fixtureProjectionModel(model: RenderModel): ProjectionModel {
    const positions = new Map<ViewNodeId, { x: number; y: number; width: number; height: number }>();
    const nodes = model.nodeIds.map((id, index) => {
      const lane = index * 4;
      positions.set(id, {
        x: model.nodeRects[lane]!,
        y: model.nodeRects[lane + 1]!,
        width: model.nodeRects[lane + 2]!,
        height: model.nodeRects[lane + 3]!,
      });
      return {
        id,
        label: model.labelTable[model.labelRefs[index]!] ?? id,
        kind: model.nodeColorKeys[model.nodeColorIds[index]!] ?? '',
        attrs: {},
        graphId: null,
        parentId: null,
        detailGraphId: null,
        depth: null,
        cutReason: null,
        coveredLeaves: model.nodeCoveredLeaves[index] ?? 1,
        orderPath: [index],
        temporal: null,
      };
    });
    const inducedEdges = model.edgeKeys.map((_, index) => {
      const src = model.nodeIds[model.edgeIndices[index * 2]!]!;
      const dst = model.nodeIds[model.edgeIndices[index * 2 + 1]!]!;
      return {
        src,
        dst,
        kind: model.edgeColorKeys[model.edgeColorIds[index]!] ?? '',
        weight: model.edgeWeights[index] ?? 1,
        multiplicity: model.edgeMultiplicities[index] ?? 1,
        samples: [],
      };
    });
    return {
      cutLevel: 0,
      nodes,
      inducedEdges,
      selection: this.store.getState().selection,
      focus: createFocusState(),
      domainMeta: { domain: 'test-fixture', label: 'Renderer fixture' },
      diagnostics: [],
      layout: { positions, bounds: { ...model.bounds }, stability: 1 },
      renderModel: model,
    };
  }

  private applyView(): void {
    const full = this.fullModel;
    if (full === null) return;
    const view = this.store.getState().ai.provenanceView;
    if (view === 'all') {
      if (this.filteredModelRef !== null) {
        this.filteredModelRef = null;
        this.commands.replaceModelAfterSelection(full);
      }
      return;
    }
    const aiIds = this.aiIdsInModel(full);
    if (aiIds.size === 0) {
      if (this.filteredModelRef !== null) {
        this.filteredModelRef = null;
        this.commands.replaceModelAfterSelection(full);
      }
      return;
    }
    const filtered = filterRenderModelNodes(full, aiIds);
    this.filteredModelRef = filtered;
    this.commands.replaceModelAfterSelection(filtered);
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
    // AI trust view resets per corpus (the store slice is reset by beginOpen).
    this.aiTrust.clear();
    this.fullModel = null;
    this.filteredModelRef = null;
    this.aiOriginSet = new Set();
    this.aiSpaceRef = null;
  }

  private async openTextInternal(generation: number, name: string, text: string): Promise<void> {
    try {
      const source: SourceDescriptor = {
        uri: name,
        text,
        ...(mediaTypeFor(name) !== undefined ? { mediaType: mediaTypeFor(name) } : {}),
      };
      let materialized: GraphSpace;
      if (looksLikeGraphDocument(name, text)) {
        this.commands.stage('ingesting', 'Decoding saved graph document…');
        const decoded = decode(text);
        if (!decoded.ok) {
          const first = decoded.errors[0];
          throw new Error(`Invalid graph document: [${first?.code ?? 'unknown'}] ${first?.message ?? ''}`);
        }
        materialized = decoded.space;
        this.commands.adapterResolved({
          domain: documentDomain(materialized),
          plugin: 'meridian:document',
          score: 1,
        });
      } else {
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
        materialized = this.materialize(outcome);
      }
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
      const resolvedDomain = this.store.getState().adapter?.domain;
      const temporal =
        resolvedDomain === undefined ? undefined : temporalHintsForDomain(resolvedDomain);

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
        ...(temporal === undefined ? {} : { temporal }),
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
    this.unsubscribeModel();
    this.resetPipeline();
    await this.layoutService.dispose();
  }
}
