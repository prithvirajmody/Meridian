/**
 * Assembled project tree → `GraphDocument` (7C, host-side). Containment is the
 * **detail-graph** relation (ARCHITECTURE §1: a node's `detail` is the graph of
 * its children; P3 builds cuts by walking it), exactly as the markdown adapter
 * does — so `code:contains` is *realized as* the detail structure, not as edge
 * objects (a parent→child edge is impossible in the model: its endpoints live
 * in different graphs, which validation forbids). 7C therefore emits **no**
 * edges; imports/calls are 7E. See the report's deviations note.
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

export const DOMAIN = 'code';

type WireGraph = GraphDocument['graphs'][number];
type WireNode = WireGraph['nodes'][number];
type Provenance = WireNode['provenance'];
type Attrs = WireNode['attrs'];

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
  const coords = (source: string, path: readonly string[]) => ({ domain: DOMAIN, source, path: [...path] });
  const prov = (uri: string, span?: readonly [number, number]): Provenance => ({
    origin: 'source',
    uri,
    ...(span !== undefined ? { span: [span[0], span[1]] as [number, number] } : {}),
  });
  const addGraph = (id: string, label: string, provenance: Provenance, nodes: WireNode[]): void => {
    graphs.push({ id, meta: { label, domain: DOMAIN, provenance }, nodes, edges: [] });
  };

  // --- declaration graphs (module bodies, class member lists, namespaces) ---
  const buildDeclGraph = (
    decls: readonly RawDecl[],
    graphId: string,
    label: string,
    source: string,
    parentPath: readonly string[],
    ownerSpan: readonly [number, number],
  ): void => {
    const nodes: WireNode[] = [];
    for (const { decl, segment, duplicate } of assignSegments(decls)) {
      const path = [...parentPath, segment];
      const coord = coords(source, path);
      const hasChildren = decl.children.length > 0;
      const detailId = hasChildren ? ctx.ids.graphId(coord) : undefined;
      nodes.push({
        id: ctx.ids.nodeId(coord),
        kind: `${DOMAIN}:${decl.kind}`,
        label: decl.name,
        ...(detailId !== undefined ? { detail: { graph: detailId } } : {}),
        attrs: declAttrs(decl, duplicate),
        provenance: prov(source, decl.span),
      });
      if (detailId !== undefined) {
        buildDeclGraph(decl.children, detailId, decl.name, source, path, decl.span);
      }
    }
    addGraph(graphId, label, prov(source, ownerSpan), nodes);
  };

  // --- directory graphs (the project's + each package's contents) ---
  const buildDirGraph = (dir: RawDir, graphId: string, label: string): void => {
    const nodes: WireNode[] = [];
    for (const child of dir.dirs) {
      const coord = coords(child.source, []);
      const detailId = ctx.ids.graphId(coord);
      nodes.push({
        id: ctx.ids.nodeId(coord),
        kind: `${DOMAIN}:package`,
        label: child.name,
        detail: { graph: detailId },
        attrs: {},
        provenance: prov(child.source),
      });
      buildDirGraph(child, detailId, child.name);
    }
    for (const module of dir.modules) {
      const coord = coords(module.source, []);
      const hasDecls = module.decls.length > 0;
      const detailId = hasDecls ? ctx.ids.graphId(coord) : undefined;
      nodes.push({
        id: ctx.ids.nodeId(coord),
        kind: `${DOMAIN}:module`,
        label: module.label,
        ...(detailId !== undefined ? { detail: { graph: detailId } } : {}),
        attrs: moduleAttrs(module),
        provenance: prov(module.source, module.span),
      });
      if (detailId !== undefined) {
        buildDeclGraph(module.decls, detailId, module.label, module.source, [], module.span);
      }
    }
    addGraph(graphId, label, prov(dir.source), nodes);
  };

  // Root graph holds the single code:project node; its detail is the tree.
  const projectName = root.name;
  const rootGraphId = ctx.ids.graphId(coords(root.source, []));
  const projectCoord = coords(root.source, [projectName]);
  const projectDetailId = ctx.ids.graphId(projectCoord);
  addGraph(rootGraphId, projectName, prov(root.source), [
    {
      id: ctx.ids.nodeId(projectCoord),
      kind: `${DOMAIN}:project`,
      label: projectName,
      detail: { graph: projectDetailId },
      attrs: {},
      provenance: prov(root.source),
    },
  ]);
  buildDirGraph(root, projectDetailId, projectName);

  return {
    formatVersion: 1,
    producer: { name: '@meridian/adapter-code', version: producerVersion },
    roots: [rootGraphId],
    graphs,
  };
}

function moduleAttrs(module: RawModule): Attrs {
  const attrs: Record<string, string | number | boolean> = {
    'code:language': module.language,
  };
  if (module.excluded !== undefined) attrs['code:excluded'] = module.excluded;
  if (module.hasErrors) {
    attrs['code:parse-error'] = true;
    attrs['code:error-count'] = module.errorCount;
  }
  return attrs as Attrs;
}

function declAttrs(decl: RawDecl, duplicate: boolean): Attrs {
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
  return attrs as Attrs;
}
