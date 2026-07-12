/**
 * Import & call resolution (7E, ADR-0026): a **pure function** of (mapped
 * modules, ingested file set, import tables) — no type inference, no network,
 * no `tsconfig`/namespace magic (open Q2 deferred). It produces the two edge
 * families and the honest counters:
 *
 * - `code:imports` (module→module): the importer's relative/absolute specifier
 *   resolved *lexically* against the ingested file tree (extension + index /
 *   package-`__init__` rules per language). A specifier resolving to no
 *   ingested file is **external** — counted, no edge.
 * - `code:calls` (function→callee): the three ADR-0026 tiers — (1) same-module
 *   lexical scope, (2) import-bound cross-module to a matching top-level
 *   declaration, (3) everything else **unresolved** (no edge, no placeholder).
 *   A name with > 1 candidate binding is unresolved, never arbitrarily picked.
 *
 * **Edge placement (the model constraint).** A `SemanticEdge` may only join two
 * nodes of the *same* graph (validate.ts / ARCHITECTURE §4.3). Two modules —
 * and two functions in different modules — never share a graph. So every link
 * is recorded by the **portal rule**: at the *lowest common graph* of the two
 * containment paths, between the two ancestors that are siblings there
 * (`rebase`). Same-directory module imports and cross-module calls therefore
 * become genuine module→module base edges; deeper links become package-level
 * base edges that P3's induced-edge aggregation rolls up at any cut. This is
 * exactly what the markdown adapter's `doc:links-to` does — no core change.
 *
 * A repeated (src→dst) pair collapses to ONE edge with `weight = callSiteCount`
 * (ADR-0013's weight model) plus up to 3 sampled call-site spans.
 */
import type { CodeLanguage } from '../languages.js';
import type { RawCallSite, RawDeclKind, RawImport } from './raw.js';

/** An element's ancestor chain: `address[i]` is its ancestor node in `graphs[i]`
 * (last entry = the element itself), so links re-base at any common graph. */
export interface Address {
  readonly graphs: readonly string[];
  readonly address: readonly string[];
}

/** A resolvable declaration target (node id + where it sits + its kind). */
export interface DeclRef {
  readonly nodeId: string;
  readonly addr: Address;
  readonly kind: RawDeclKind;
}

/** One function/method whose body was scanned for calls. */
export interface FunctionCtx {
  readonly ref: DeclRef;
  readonly calls: readonly RawCallSite[];
  /** Own-class members by name, for `self`/`this` (tier 1) — methods only. */
  readonly classMembers?: ReadonlyMap<string, readonly DeclRef[]>;
}

/** One mapped module and everything resolution needs from it. */
export interface ModuleCtx {
  readonly source: string;
  readonly language: CodeLanguage;
  readonly nodeId: string;
  readonly addr: Address;
  readonly imports: readonly RawImport[];
  /** All top-level declarations by name (tier-1 candidates). */
  readonly localDecls: ReadonlyMap<string, readonly DeclRef[]>;
  /** Names another module may import (tier-2 targets): TS exports (`default`
   * keyed `default`); Python — every top-level decl. */
  readonly exportMap: ReadonlyMap<string, readonly DeclRef[]>;
  readonly functions: readonly FunctionCtx[];
}

export interface ResolveInput {
  readonly modules: readonly ModuleCtx[];
  /** Every ingested module source path (walked or excluded) — the file set
   * specifiers resolve against. */
  readonly files: ReadonlySet<string>;
}

/** A base edge to emit, already placed at its lowest-common graph. */
export interface EdgeToEmit {
  readonly graph: string;
  readonly src: string;
  readonly dst: string;
  readonly kind: 'code:imports' | 'code:calls';
  readonly weight: number;
  /** Up to 3 sampled call-site spans (calls only), source-order. */
  readonly spans: readonly (readonly [number, number])[];
  readonly provenanceUri: string;
  readonly provenanceSpan?: readonly [number, number];
}

export interface FunctionCounters {
  readonly resolved: number;
  readonly unresolved: number;
  readonly external: number;
}

export interface ResolveOutput {
  readonly edges: readonly EdgeToEmit[];
  readonly counters: ReadonlyMap<string, FunctionCounters>;
  readonly moduleExternalImports: ReadonlyMap<string, number>;
}

// --- path helpers (POSIX, pure) -------------------------------------------

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Join a base dir with a relative path, resolving `.`/`..` segments. */
function joinPosix(dir: string, rel: string): string {
  const parts = (dir === '' ? [] : dir.split('/')).slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** The set of directory paths that contain at least one ingested file. */
function directorySet(files: ReadonlySet<string>): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    let dir = dirname(file);
    // walk up, marking every ancestor directory (including '' the root).
    for (;;) {
      dirs.add(dir);
      if (dir === '') break;
      dir = dirname(dir);
    }
  }
  return dirs;
}

const TS_INDEX = ['index.ts', 'index.tsx', 'index.mts', 'index.cts', 'index.d.ts'];
const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts'];

/** TypeScript module resolution: relative specifiers only; bare → external. */
function resolveTs(specifier: string, importerSource: string, files: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined; // bare / alias → external (Q2)
  // An ESM-in-TS specifier may carry a .js-family extension mapping to a .ts.
  const jsSwap = specifier.replace(/\.(js|jsx|mjs|cjs)$/i, '');
  const base = joinPosix(dirname(importerSource), jsSwap);
  const candidates = [
    base, // already had a code extension
    ...TS_EXTS.map((e) => base + e),
    ...TS_INDEX.map((i) => `${base}/${i}`),
  ];
  return candidates.find((c) => files.has(c));
}

/** Parse a Python module reference into (leading-dot count, dotted segments). */
function pyParts(specifier: string): { dots: number; segments: string[] } {
  let dots = 0;
  while (dots < specifier.length && specifier[dots] === '.') dots++;
  const rest = specifier.slice(dots).replace(/\s+/g, '');
  const segments = rest.length === 0 ? [] : rest.split('.').filter((s) => s.length > 0);
  return { dots, segments };
}

/** Base directory a Python relative/absolute reference resolves against. */
function pyBaseDir(dots: number, importerSource: string): string {
  if (dots === 0) return ''; // absolute, from the ingest root
  let dir = dirname(importerSource);
  for (let i = 1; i < dots; i++) dir = dirname(dir);
  return dir;
}

/** Resolve a Python module *file* at `path` (`.py`/`.pyi`, or package init). */
function pyModuleAt(path: string, files: ReadonlySet<string>): string | undefined {
  for (const candidate of [`${path}.py`, `${path}.pyi`, `${path}/__init__.py`, `${path}/__init__.pyi`]) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

/** A resolved local binding, for call tier-2. */
type Binding =
  | { readonly kind: 'decl'; readonly module: string; readonly imported: string }
  | { readonly kind: 'module' }
  | { readonly kind: 'namespace' }
  | { readonly kind: 'external' };

/** The outcome of resolving one import statement. */
interface ImportResolution {
  /** Distinct ingested module sources this statement depends on (→ edges). */
  readonly targets: string[];
  /** True when the statement's module specifier resolved to no ingested file. */
  readonly external: boolean;
  /** Local name → binding, for call resolution. */
  readonly bindings: Map<string, Binding>;
}

function resolveImport(
  im: RawImport,
  importerSource: string,
  language: CodeLanguage,
  files: ReadonlySet<string>,
  dirs: ReadonlySet<string>,
): ImportResolution {
  const targets = new Set<string>();
  const bindings = new Map<string, Binding>();

  if (language === 'typescript') {
    const target = resolveTs(im.specifier, importerSource, files);
    if (target === undefined) {
      for (const b of im.bindings) bindings.set(b.local, { kind: 'external' });
      return { targets: [], external: true, bindings };
    }
    if (target !== importerSource) targets.add(target);
    for (const b of im.bindings) {
      bindings.set(b.local, b.imported === '*' ? { kind: 'namespace' } : { kind: 'decl', module: target, imported: b.imported });
    }
    return { targets: [...targets], external: false, bindings };
  }

  // Python.
  const { dots, segments } = pyParts(im.specifier);
  const baseDir = pyBaseDir(dots, importerSource);
  if (!im.fromImport) {
    // `import a.b.c` — resolve the dotted module from the root.
    const target = pyModuleAt(joinPosix(baseDir, segments.join('/')), files);
    if (target === undefined) {
      for (const b of im.bindings) bindings.set(b.local, { kind: 'external' });
      return { targets: [], external: true, bindings };
    }
    if (target !== importerSource) targets.add(target);
    for (const b of im.bindings) bindings.set(b.local, { kind: 'module' });
    return { targets: [...targets], external: false, bindings };
  }

  // `from <spec> import n1, n2, …`
  const specModule = segments.length > 0 ? pyModuleAt(joinPosix(baseDir, segments.join('/')), files) : undefined;
  if (specModule !== undefined) {
    // spec is a module: every imported name is one of its declarations.
    if (specModule !== importerSource) targets.add(specModule);
    for (const b of im.bindings) {
      bindings.set(b.local, b.imported === '*' ? { kind: 'namespace' } : { kind: 'decl', module: specModule, imported: b.imported });
    }
    return { targets: [...targets], external: false, bindings };
  }
  // spec is a package directory: each imported name is a submodule or a decl
  // of the package's __init__.
  const pkgDir = joinPosix(baseDir, segments.join('/'));
  const pkgInit = pyModuleAt(pkgDir, files); // the __init__ module, if any
  const pkgExists = dirs.has(pkgDir) || pkgInit !== undefined;
  if (!pkgExists) {
    for (const b of im.bindings) bindings.set(b.local, { kind: 'external' });
    return { targets: [], external: true, bindings };
  }
  for (const b of im.bindings) {
    if (b.imported === '*') {
      if (pkgInit !== undefined && pkgInit !== importerSource) targets.add(pkgInit);
      bindings.set(b.local, { kind: 'namespace' });
      continue;
    }
    const submodule = pyModuleAt(joinPosix(pkgDir, b.imported), files);
    if (submodule !== undefined) {
      if (submodule !== importerSource) targets.add(submodule);
      bindings.set(b.local, { kind: 'module' });
    } else if (pkgInit !== undefined) {
      if (pkgInit !== importerSource) targets.add(pkgInit);
      bindings.set(b.local, { kind: 'decl', module: pkgInit, imported: b.imported });
    } else {
      bindings.set(b.local, { kind: 'external' });
    }
  }
  return { targets: [...targets], external: false, bindings };
}

// --- portal rebasing -------------------------------------------------------

interface Placed {
  readonly graph: string;
  readonly src: string;
  readonly dst: string;
}

/** Rebase a link at the lowest common graph of the two containment paths. */
function rebase(from: Address, to: Address): Placed | undefined {
  let common = 0;
  while (
    common < from.graphs.length - 1 &&
    common < to.graphs.length - 1 &&
    from.graphs[common + 1] === to.graphs[common + 1]
  ) {
    common += 1;
  }
  const src = from.address[common]!;
  const dst = to.address[common]!;
  if (src === dst) return undefined; // a link to one's own ancestor induces nothing
  return { graph: from.graphs[common]!, src, dst };
}

interface EdgeAcc {
  graph: string;
  src: string;
  dst: string;
  kind: 'code:imports' | 'code:calls';
  weight: number;
  spans: [number, number][];
  provenanceUri: string;
  provenanceSpan?: readonly [number, number];
}

// --- the engine ------------------------------------------------------------

export function resolveEdges(input: ResolveInput): ResolveOutput {
  const { files } = input;
  const dirs = directorySet(files);
  const bySource = new Map<string, ModuleCtx>();
  for (const m of input.modules) bySource.set(m.source, m);

  const edges = new Map<string, EdgeAcc>();
  const counters = new Map<string, FunctionCounters>();
  const moduleExternalImports = new Map<string, number>();
  /** Per-module resolved import bindings, for the calls pass. */
  const importBindings = new Map<string, Map<string, Binding>>();

  const edgeKey = (p: Placed, kind: string): string => `${p.graph}\n${kind}\n${p.src}\n${p.dst}`;
  const addLink = (
    from: Address,
    to: Address,
    kind: 'code:imports' | 'code:calls',
    weight: number,
    span: readonly [number, number] | undefined,
    provenanceUri: string,
    provenanceSpan: readonly [number, number] | undefined,
  ): void => {
    const placed = rebase(from, to);
    if (placed === undefined) return;
    const key = edgeKey(placed, kind);
    const prior = edges.get(key);
    if (prior === undefined) {
      edges.set(key, {
        ...placed,
        kind,
        weight,
        spans: span !== undefined ? [[span[0], span[1]]] : [],
        provenanceUri,
        ...(provenanceSpan !== undefined ? { provenanceSpan } : {}),
      });
    } else {
      prior.weight += weight;
      if (span !== undefined) prior.spans.push([span[0], span[1]]);
    }
  };

  // --- imports pass ---
  for (const m of input.modules) {
    const bindings = new Map<string, Binding>();
    let external = 0;
    for (const im of m.imports) {
      const res = resolveImport(im, m.source, m.language, files, dirs);
      if (res.external) external += 1;
      for (const [local, b] of res.bindings) bindings.set(local, b);
      for (const target of res.targets) {
        const tm = bySource.get(target);
        if (tm === undefined) continue; // resolved path not a mapped module (defensive)
        addLink(m.addr, tm.addr, 'code:imports', 1, undefined, m.source, im.span);
      }
    }
    importBindings.set(m.source, bindings);
    if (external > 0) moduleExternalImports.set(m.nodeId, external);
  }

  // --- calls pass ---
  for (const m of input.modules) {
    const bindings = importBindings.get(m.source)!;
    for (const fn of m.functions) {
      let resolved = 0;
      let unresolved = 0;
      let external = 0;
      for (const call of fn.calls) {
        const target = resolveCall(call, m, fn, bindings, bySource);
        if (target === 'external') external += 1;
        else if (target === undefined) unresolved += 1;
        else {
          resolved += 1;
          addLink(fn.ref.addr, target.addr, 'code:calls', 1, call.span, m.source, call.span);
        }
      }
      counters.set(fn.ref.nodeId, { resolved, unresolved, external });
    }
  }

  // Finalize: sample ≤3 spans (source order) per call edge.
  const out: EdgeToEmit[] = [];
  for (const acc of edges.values()) {
    const spans = acc.spans.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 3);
    out.push({
      graph: acc.graph,
      src: acc.src,
      dst: acc.dst,
      kind: acc.kind,
      weight: acc.weight,
      spans,
      provenanceUri: acc.provenanceUri,
      ...(acc.provenanceSpan !== undefined ? { provenanceSpan: acc.provenanceSpan } : {}),
    });
  }
  return { edges: out, counters, moduleExternalImports };
}

/**
 * Resolve one call-site to its callee declaration, or `'external'`
 * (import-bound outside the ingested set), or `undefined` (unresolved, tier 3).
 * A name with > 1 candidate binding is unresolved — never arbitrarily picked.
 */
function resolveCall(
  call: RawCallSite,
  module: ModuleCtx,
  fn: FunctionCtx,
  bindings: ReadonlyMap<string, Binding>,
  bySource: ReadonlyMap<string, ModuleCtx>,
): DeclRef | 'external' | undefined {
  if (call.callee === undefined) return undefined; // dynamic
  if (call.receiver === 'member') return undefined; // call on a value of unknown type
  const name = call.callee;

  if (call.receiver === 'self') {
    const members = fn.classMembers?.get(name);
    return members !== undefined && members.length === 1 ? members[0] : undefined;
  }

  // Plain identifier: gather every candidate binding (local decls + import).
  const locals = module.localDecls.get(name) ?? [];
  const binding = bindings.get(name);
  const candidateCount = locals.length + (binding !== undefined ? 1 : 0);
  if (candidateCount !== 1) return undefined; // 0 = unknown/global; >1 = ambiguous

  if (locals.length === 1) return locals[0]; // tier 1: same-module lexical scope

  // tier 2: import-bound cross-module.
  if (binding!.kind === 'external') return 'external';
  if (binding!.kind !== 'decl') return undefined; // module/namespace object → not a direct callee
  const targetModule = bySource.get(binding!.module);
  if (targetModule === undefined) return undefined;
  const exported = targetModule.exportMap.get(binding!.imported);
  return exported !== undefined && exported.length === 1 ? exported[0] : undefined;
}
