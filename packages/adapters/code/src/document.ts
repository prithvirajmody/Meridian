/**
 * Assembled project tree → `GraphDocument` (7C containment, 7E edges; host-side).
 * Containment is the **detail-graph** relation (ARCHITECTURE §1: a node's
 * `detail` is the graph of its children; P3 builds cuts by walking it), so
 * `code:contains` is *realized as* the detail structure, not as edge objects
 * (a parent→child edge is impossible in the model: its endpoints live in
 * different graphs, which validation forbids).
 *
 * 7E adds the two edge families — `code:imports` (module→module) and
 * `code:calls` (function→callee), both `code:confidence: 'syntactic'` — plus
 * the per-function counters. Because a `SemanticEdge` may only join two nodes
 * of the *same* graph, every link is recorded by the **portal rule** at its
 * lowest common graph (see `map/resolve.ts`). This walk threads each element's
 * ancestor chain so the resolver can re-base; resolution itself is a pure
 * function there.
 *
 * IDs come from `ctx.ids` (ADR-0002/0028): coordinate `source` is the
 * repo-relative POSIX path (project name for the root, dir path for a package,
 * file path for a module and everything declared inside it); coordinate `path`
 * is the in-file qualifiedName scope chain, with `#<sigHash>`/`~<n>`
 * discriminators applied per ADR-0028. This module never touches tree-sitter.
 */
import type { GraphDocument, PluginContext } from '@meridian/plugin-api';
import type { RawDir } from './map/assemble.js';
import type { RawDecl, RawModule } from './map/raw.js';
import {
  resolveEdges,
  type Address,
  type DeclRef,
  type FunctionCtx,
  type ModuleCtx,
} from './map/resolve.js';

export const DOMAIN = 'code';

type WireGraph = GraphDocument['graphs'][number];
type WireNode = WireGraph['nodes'][number];
type WireEdge = WireGraph['edges'][number];
type Provenance = WireNode['provenance'];

/** Mutable accumulator for one module's resolution context, filled by the walk. */
interface ModuleAcc {
  readonly source: string;
  readonly language: ModuleCtx['language'];
  readonly nodeId: string;
  readonly addr: Address;
  readonly imports: ModuleCtx['imports'];
  readonly localDecls: Map<string, DeclRef[]>;
  readonly exportMap: Map<string, DeclRef[]>;
  readonly functions: FunctionCtx[];
}

/** One sibling declaration with its ADR-0028 scope segment and duplicate flag. */
interface SegmentedDecl {
  readonly decl: RawDecl;
  readonly segment: string;
  readonly duplicate: boolean;
}

/**
 * Assign each sibling declaration its scope segment (ADR-0028):
 * - a name unique in its scope → the bare name;
 * - a non-unique name → `name#<sigHash>` (overloads, case 2);
 * - a `name#<sigHash>` that *still* collides, or a non-signature kind that
 *   collides → `name#<sigHash>~<ordinal>` flagged `code:duplicate` (case 4).
 * Source order is preserved, so discriminators are deterministic and adding an
 * overload never renumbers an existing one.
 */
export function assignSegments(decls: readonly RawDecl[]): SegmentedDecl[] {
  const byName = new Map<string, number[]>();
  decls.forEach((d, i) => {
    const list = byName.get(d.name);
    if (list === undefined) byName.set(d.name, [i]);
    else list.push(i);
  });
  const result = new Array<SegmentedDecl>(decls.length);
  for (const indices of byName.values()) {
    if (indices.length === 1) {
      const i = indices[0]!;
      result[i] = { decl: decls[i]!, segment: decls[i]!.name, duplicate: false };
      continue;
    }
    const hashCount = new Map<string, number>();
    for (const i of indices) {
      const h = decls[i]!.sigHash;
      hashCount.set(h, (hashCount.get(h) ?? 0) + 1);
    }
    indices.forEach((i, ordinal) => {
      const d = decls[i]!;
      const hashPart = d.sigHash === '' ? '' : `#${d.sigHash}`;
      const isDup = (hashCount.get(d.sigHash) ?? 0) > 1;
      result[i] = {
        decl: d,
        segment: isDup ? `${d.name}${hashPart}~${ordinal}` : `${d.name}${hashPart}`,
        duplicate: isDup,
      };
    });
  }
  return result;
}

export function buildCodeDocument(
  ctx: PluginContext,
  root: RawDir,
  producerVersion: string,
): GraphDocument {
  const graphs: WireGraph[] = [];
  const edgesByGraph = new Map<string, WireEdge[]>();
  const coords = (source: string, path: readonly string[]) => ({ domain: DOMAIN, source, path: [...path] });
  const prov = (uri: string, span?: readonly [number, number]): Provenance => ({
    origin: 'source',
    uri,
    ...(span !== undefined ? { span: [span[0], span[1]] as [number, number] } : {}),
  });
  const addGraph = (id: string, label: string, provenance: Provenance, nodes: WireNode[]): void => {
    const edges: WireEdge[] = [];
    graphs.push({ id, meta: { label, domain: DOMAIN, provenance }, nodes, edges });
    edgesByGraph.set(id, edges);
  };

  // Resolution accumulators (7E). The walk fills these; `resolveEdges` consumes
  // them purely; then counters/edges are written back.
  const modules: ModuleAcc[] = [];
  const files = new Set<string>();
  /** function/method node id → its (mutable) attrs, for post-resolution counters. */
  const fnAttrs = new Map<string, Record<string, string | number | boolean>>();
  /** module node id → its (mutable) attrs, for the external-imports counter. */
  const moduleAttrById = new Map<string, Record<string, string | number | boolean>>();

  // --- declaration graphs (module bodies, class member lists, namespaces) ---
  const buildDeclGraph = (
    decls: readonly RawDecl[],
    graphId: string,
    label: string,
    source: string,
    parentPath: readonly string[],
    ownerSpan: readonly [number, number],
    graphChain: readonly string[],
    nodeChain: readonly string[],
    mod: ModuleAcc,
    topLevel: boolean,
  ): void => {
    const segmented = assignSegments(decls);
    // First compute each sibling's id/address so a `self`/`this` call can be
    // resolved against the member set before nodes are built.
    const entries = segmented.map(({ decl, segment, duplicate }) => {
      const path = [...parentPath, segment];
      const coord = coords(source, path);
      const nodeId = ctx.ids.nodeId(coord);
      const addr: Address = { graphs: [...graphChain, graphId], address: [...nodeChain, nodeId] };
      const ref: DeclRef = { nodeId, addr, kind: decl.kind };
      return { decl, duplicate, path, coord, nodeId, addr, ref };
    });

    const memberMap = new Map<string, DeclRef[]>();
    for (const e of entries) (memberMap.get(e.decl.name) ?? memberMap.set(e.decl.name, []).get(e.decl.name)!).push(e.ref);

    if (topLevel) {
      for (const e of entries) {
        (mod.localDecls.get(e.decl.name) ?? mod.localDecls.set(e.decl.name, []).get(e.decl.name)!).push(e.ref);
        // TypeScript: only exports are importable (default keyed `default`);
        // Python has no export syntax — every top-level decl is importable.
        if (mod.language === 'python') {
          (mod.exportMap.get(e.decl.name) ?? mod.exportMap.set(e.decl.name, []).get(e.decl.name)!).push(e.ref);
        } else if (e.decl.defaultExport) {
          (mod.exportMap.get('default') ?? mod.exportMap.set('default', []).get('default')!).push(e.ref);
        } else if (e.decl.exported) {
          (mod.exportMap.get(e.decl.name) ?? mod.exportMap.set(e.decl.name, []).get(e.decl.name)!).push(e.ref);
        }
      }
    }

    const nodes: WireNode[] = [];
    for (const e of entries) {
      const hasChildren = e.decl.children.length > 0;
      const detailId = hasChildren ? ctx.ids.graphId(e.coord) : undefined;
      const attrs = declAttrs(e.decl, e.duplicate);
      nodes.push({
        id: e.nodeId,
        kind: `${DOMAIN}:${e.decl.kind}`,
        label: e.decl.name,
        ...(detailId !== undefined ? { detail: { graph: detailId } } : {}),
        attrs,
        provenance: prov(source, e.decl.span),
      });
      if (e.decl.kind === 'function' || e.decl.kind === 'method') {
        fnAttrs.set(e.nodeId, attrs);
        mod.functions.push({
          ref: e.ref,
          calls: e.decl.calls ?? [],
          // `self`/`this` (tier 1) resolves against the enclosing class's
          // members — a `method` is exactly a class member.
          ...(e.decl.kind === 'method' ? { classMembers: memberMap } : {}),
        });
      }
      if (detailId !== undefined) {
        buildDeclGraph(e.decl.children, detailId, e.decl.name, source, e.path, e.decl.span, e.addr.graphs, e.addr.address, mod, false);
      }
    }
    addGraph(graphId, label, prov(source, ownerSpan), nodes);
  };

  // --- directory graphs (the project's + each package's contents) ---
  const buildDirGraph = (
    dir: RawDir,
    graphId: string,
    label: string,
    graphChain: readonly string[],
    nodeChain: readonly string[],
  ): void => {
    const nodes: WireNode[] = [];
    for (const child of dir.dirs) {
      const coord = coords(child.source, []);
      const detailId = ctx.ids.graphId(coord);
      const nodeId = ctx.ids.nodeId(coord);
      nodes.push({
        id: nodeId,
        kind: `${DOMAIN}:package`,
        label: child.name,
        detail: { graph: detailId },
        attrs: {},
        provenance: prov(child.source),
      });
      buildDirGraph(child, detailId, child.name, [...graphChain, graphId], [...nodeChain, nodeId]);
    }
    for (const module of dir.modules) {
      const coord = coords(module.source, []);
      const hasDecls = module.decls.length > 0;
      const detailId = hasDecls ? ctx.ids.graphId(coord) : undefined;
      const nodeId = ctx.ids.nodeId(coord);
      const attrs = moduleAttrs(module);
      nodes.push({
        id: nodeId,
        kind: `${DOMAIN}:module`,
        label: module.label,
        ...(detailId !== undefined ? { detail: { graph: detailId } } : {}),
        attrs,
        provenance: prov(module.source, module.span),
      });
      files.add(module.source);
      moduleAttrById.set(nodeId, attrs);
      const mod: ModuleAcc = {
        source: module.source,
        language: module.language,
        nodeId,
        addr: { graphs: [...graphChain, graphId], address: [...nodeChain, nodeId] },
        imports: module.imports,
        localDecls: new Map(),
        exportMap: new Map(),
        functions: [],
      };
      modules.push(mod);
      if (detailId !== undefined) {
        buildDeclGraph(module.decls, detailId, module.label, module.source, [], module.span, mod.addr.graphs, mod.addr.address, mod, true);
      }
    }
    addGraph(graphId, label, prov(dir.source), nodes);
  };

  // Root graph holds the single code:project node; its detail is the tree.
  const projectName = root.name;
  const rootGraphId = ctx.ids.graphId(coords(root.source, []));
  const projectCoord = coords(root.source, [projectName]);
  const projectDetailId = ctx.ids.graphId(projectCoord);
  const projectNodeId = ctx.ids.nodeId(projectCoord);
  addGraph(rootGraphId, projectName, prov(root.source), [
    {
      id: projectNodeId,
      kind: `${DOMAIN}:project`,
      label: projectName,
      detail: { graph: projectDetailId },
      attrs: {},
      provenance: prov(root.source),
    },
  ]);
  buildDirGraph(root, projectDetailId, projectName, [rootGraphId], [projectNodeId]);

  // --- resolve imports & calls, then write back edges + counters (7E) ---
  const resolution = resolveEdges({ modules, files });
  for (const e of resolution.edges) {
    const attrs: Record<string, string | number | boolean> = { 'code:confidence': 'syntactic' };
    if (e.kind === 'code:calls' && e.spans.length > 0) {
      attrs['code:call-sites'] = e.spans.map(([s, en]) => `${s}-${en}`).join(',');
    }
    edgesByGraph.get(e.graph)!.push({
      id: ctx.ids.edgeId({ graph: e.graph, kind: e.kind, src: e.src, dst: e.dst }),
      src: e.src,
      dst: e.dst,
      kind: e.kind,
      weight: e.weight,
      attrs,
      provenance: prov(e.provenanceUri, e.provenanceSpan),
    });
  }
  // Counters are honest and always present on every function/method (ADR-0026).
  for (const [nodeId, attrs] of fnAttrs) {
    const c = resolution.counters.get(nodeId) ?? { resolved: 0, unresolved: 0, external: 0 };
    attrs['code:calls-resolved'] = c.resolved;
    attrs['code:calls-unresolved'] = c.unresolved;
    attrs['code:calls-external'] = c.external;
  }
  for (const [nodeId, count] of resolution.moduleExternalImports) {
    const attrs = moduleAttrById.get(nodeId);
    if (attrs !== undefined) attrs['code:imports-external'] = count;
  }

  return {
    formatVersion: 1,
    producer: { name: '@meridian/adapter-code', version: producerVersion },
    roots: [rootGraphId],
    graphs,
  };
}

function moduleAttrs(module: RawModule): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    'code:language': module.language,
  };
  if (module.excluded !== undefined) attrs['code:excluded'] = module.excluded;
  if (module.hasErrors) {
    attrs['code:parse-error'] = true;
    attrs['code:error-count'] = module.errorCount;
  }
  return attrs;
}

function declAttrs(decl: RawDecl, duplicate: boolean): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {};
  const sig = decl.signature;
  if (sig !== undefined) {
    attrs['code:signature'] = sig.signature;
    attrs['code:params'] = sig.params;
    if (sig.returns !== '') attrs['code:returns'] = sig.returns;
    if (sig.async) attrs['code:async'] = true;
    if (sig.static) attrs['code:static'] = true;
    if (sig.generator) attrs['code:generator'] = true;
    if (sig.abstract) attrs['code:abstract'] = true;
    if (sig.accessibility !== undefined) attrs['code:accessibility'] = sig.accessibility;
    if (sig.classmethod === true) attrs['code:classmethod'] = true;
    if (sig.property === true) attrs['code:property'] = true;
  }
  if (decl.abstract === true) attrs['code:abstract'] = true;
  if (decl.exported) attrs['code:exported'] = true;
  if (decl.defaultExport) attrs['code:default-export'] = true;
  if (decl.overload === true) attrs['code:overload'] = true;
  if (decl.decorators !== undefined && decl.decorators.length > 0) {
    attrs['code:decorators'] = decl.decorators.join(', ');
  }
  if (duplicate) attrs['code:duplicate'] = true;
  return attrs;
}
