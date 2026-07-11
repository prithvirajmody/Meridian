/**
 * Studio's imperative composition root (ADR-0022): source I/O arrives as a
 * value, then plugin sniff/ingest → IR gate → op-based store → LOD → layout →
 * pure RenderModel. No service instance enters React or Zustand state.
 */
import {
  buildLevelChain,
  resolveLod,
  type LevelChain,
  type LodResult,
  type ZoomPolicy,
} from '@meridian/abstraction';
import { markdownPlugin } from '@meridian/adapter-markdown';
import {
  buildContainmentIndex,
  containmentPathOf,
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
  type SemanticNode,
} from '@meridian/graph-core';
import {
  createStore,
  decodeDeltaInput,
  diffSpaces,
  formatVersion,
  type GraphStore,
} from '@meridian/graph-store';
import {
  BUILTIN_LAYOUT_PROVIDERS,
  chooseProvider,
  type CompoundNesting,
  type LayoutInput,
  type LayoutResult,
  type Size,
} from '@meridian/layout';
import type { IdFacade, SourceDescriptor } from '@meridian/plugin-api';
import { createPluginHost, type PluginHost } from '@meridian/plugin-host';
import {
  buildRenderModel,
  type RenderModel,
  type SelectionState,
} from '@meridian/view-model';
import {
  StudioStoreCommands,
  type SelectedElementPanel,
  type StudioStore,
} from './store.js';

export interface StudioLayoutService {
  compute(providerId: string, input: LayoutInput): Promise<LayoutResult>;
  dispose(): void | Promise<void>;
}

export class DirectStudioLayoutService implements StudioLayoutService {
  async compute(providerId: string, input: LayoutInput): Promise<LayoutResult> {
    const provider = BUILTIN_LAYOUT_PROVIDERS.get(providerId);
    if (provider === undefined) throw new Error(`Studio: unknown layout provider "${providerId}"`);
    return provider.compute(input);
  }

  dispose(): void {}
}

interface PipelineArtifacts {
  readonly space: GraphSpace;
  readonly store: GraphStore;
  readonly lod: LodResult;
  readonly layout: LayoutResult;
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

function nodeSize(label: string): Size {
  return {
    width: Math.max(72, Math.min(260, 24 + Array.from(label).length * 7)),
    height: 34,
  };
}

function indexNodes(space: GraphSpace): ReadonlyMap<NodeId, SemanticNode> {
  const result = new Map<NodeId, SemanticNode>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) result.set(node.id, node);
  }
  return result;
}

function buildCompound(space: GraphSpace, lod: LodResult): CompoundNesting {
  const containment = buildContainmentIndex(space);
  const groupOf = new Map<NodeId, string>();
  const parentOf = new Map<string, string>();
  for (const id of lod.cut.members) {
    const graph = lod.cut.trace.get(id)?.graph;
    if (graph === undefined) continue;
    groupOf.set(id, graph);
    const path = containmentPathOf(space, graph, containment);
    for (let index = 1; index < path.length; index++) {
      parentOf.set(path[index]!, path[index - 1]!);
    }
  }
  return { groupOf, parentOf };
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

export class StudioSession {
  private readonly commands: StudioStoreCommands;
  private readonly host: PluginHost;
  private readonly layoutService: StudioLayoutService;
  private generation = 0;
  private artifacts: PipelineArtifacts | null = null;
  private readonly unsubscribeSelection: () => void;
  private disposed = false;

  constructor(
    readonly store: StudioStore,
    options: { readonly layoutService?: StudioLayoutService } = {},
  ) {
    this.commands = new StudioStoreCommands(store);
    this.host = buildHost();
    this.layoutService = options.layoutService ?? new DirectStudioLayoutService();
    this.unsubscribeSelection = store.subscribe((state, previous) => {
      if (state.selection !== previous.selection) this.selectionChanged(state.selection);
    });
  }

  async openFile(file: Pick<File, 'name' | 'size' | 'text'>): Promise<void> {
    const generation = ++this.generation;
    this.artifacts = null;
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
    this.artifacts = null;
    this.commands.beginOpen({
      generation,
      name,
      bytes: new TextEncoder().encode(text).byteLength,
    });
    await this.openTextInternal(generation, name, text);
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
      const lod = resolveLod(space, chain, canonicalPolicy(chain), {
        zoom: initialZoom(chain),
        overrides: new Map(),
      });
      if (!this.isCurrent(generation)) return;

      const nodes = indexNodes(space);
      const sizes = new Map<NodeId, Size>();
      for (const id of lod.cut.members) sizes.set(id, nodeSize(nodes.get(id)?.label ?? String(id)));
      const providerId = chooseProvider(lod.cut, lod.inducedEdges);
      const compound = providerId === 'elk-layered' ? buildCompound(space, lod) : undefined;
      const input: LayoutInput = {
        cut: lod.cut,
        edges: lod.inducedEdges,
        sizes,
        hints: {},
        ...(compound !== undefined ? { compound } : {}),
      };

      this.commands.stage('layout', `Laying out with ${providerId}…`);
      const layout = await this.layoutService.compute(providerId, input);
      if (!this.isCurrent(generation)) return;
      const layoutReadyAtMs = now();
      const model = buildRenderModel(space, lod, layout, this.store.getState().selection);
      this.artifacts = { space, store, lod, layout };
      this.commands.publishModel(
        model,
        formatVersion(store.version()),
        layoutReadyAtMs,
        `${model.nodeIds.length.toLocaleString()} nodes · ${model.edgeKeys.length.toLocaleString()} edges · ${providerId}`,
      );
    } catch (error) {
      this.commands.fail(generation, 'open-failed', errorMessage(error));
    }
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
    const artifacts = this.artifacts;
    if (artifacts === null) {
      this.commands.setPanel(null);
      return;
    }
    this.commands.setPanel(this.panelFor(selection, artifacts));
    const model = buildRenderModel(
      artifacts.space,
      artifacts.lod,
      artifacts.layout,
      selection,
    );
    this.commands.replaceModelAfterSelection(model);
  }

  private panelFor(
    selection: SelectionState,
    artifacts: PipelineArtifacts,
  ): SelectedElementPanel | null {
    const anchor = selection.anchor;
    if (anchor === undefined) return null;
    if (anchor.kind === 'node') {
      for (const graph of artifacts.space.graphs.values()) {
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
    const induced = artifacts.lod.inducedEdges.find(
      (edge) => edgeKey(edge.src, edge.dst, edge.kind) === anchor.key,
    );
    const sample = induced?.samples[0];
    const edge = sample === undefined ? undefined : findBaseEdge(artifacts.space, sample);
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
    this.artifacts = null;
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
    this.artifacts = null;
    await this.layoutService.dispose();
  }
}
