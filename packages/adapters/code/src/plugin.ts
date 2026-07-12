/**
 * `@meridian/adapter-code` as a Meridian plugin (7C TypeScript, 7D Python).
 * Deterministic,
 * AI-free, isomorphic in `src` (no `node:*`, no DOM). Unlike the markdown
 * adapter, parsing needs a grammar runtime, so the plugin is *constructed* with
 * an injected {@link CodeMapper} — the CLI injects a worker-backed mapper
 * (grammars only in workers), conformance a lighter in-process one; the mapping
 * output is identical either way (ADR-0027).
 *
 * A single `.ts` file is a one-module project; a whole directory arrives as a
 * {@link CODE_PROJECT_MEDIA_TYPE} bundle the composition root built (ADR-0009 —
 * the parser never touches the filesystem).
 */
import type { MeridianPlugin, PluginContext, PluginManifest, SourceDescriptor } from '@meridian/plugin-api';
import {
  CODE_PROJECT_MEDIA_TYPE,
  decodeProjectBundle,
  normalizePosixPath,
  type BundleFile,
} from './bundle.js';
import { buildCodeDocument, DOMAIN } from './document.js';
import { isCodeLanguage, languageForPath } from './languages.js';
import { assembleProject } from './map/assemble.js';
import type { RawModule } from './map/raw.js';
import type { CodeMapper } from './mapper.js';

const VERSION = '0.2.0';

/** ADR-0027 oversize threshold: a file this large is flagged excluded and not
 * walked (contributes a cold, non-resolvable module node). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_LOC = 50_000;

/** Any code extension this adapter routes (7D: TypeScript + Python). */
const CODE_EXTENSIONS = /\.(tsx|mts|cts|ts|pyi|py)$/i;

export const manifest: PluginManifest = {
  name: '@meridian/adapter-code',
  version: VERSION,
  apiVersion: '^0.2.0',
  capabilities: [
    { kind: 'domain-parser', id: DOMAIN },
    // 7F: this adapter materializes a function's CFG/AST on drill-in
    // (ADR-0027). Declared-but-unrouted by the host (like the other post-parser
    // kinds); the resolver is exercised directly / by the navigation layer.
    { kind: 'detail-resolver', id: DOMAIN },
  ],
  kinds: [
    'code:project',
    'code:package',
    'code:module',
    'code:class',
    'code:function',
    'code:method',
    'code:namespace',
    'code:imports',
    'code:calls',
    // 7F lazy body levels (ADR-0027): CFG basic blocks + flow edges, AST nodes.
    'code:block',
    'code:stmt',
    'code:expr',
    'code:flows-to',
  ],
  attrSchemas: {
    'code:language': { type: 'string', description: 'source language of a module (e.g. typescript)' },
    'code:signature': { type: 'string', description: "a function/method's normalized parameter list as written" },
    'code:params': { type: 'number', description: 'parameter arity of a function/method' },
    'code:returns': { type: 'string', description: 'normalized return-type annotation as written' },
    'code:async': { type: 'boolean', description: 'the function/method is async' },
    'code:static': { type: 'boolean', description: 'the member is static' },
    'code:generator': { type: 'boolean', description: 'the function/method is a generator' },
    'code:abstract': { type: 'boolean', description: 'the class/method is abstract' },
    'code:accessibility': { type: 'string', description: 'member accessibility: public|private|protected' },
    'code:classmethod': { type: 'boolean', description: 'a Python @classmethod' },
    'code:property': { type: 'boolean', description: 'a Python @property (or @x.setter/getter/deleter)' },
    'code:overload': { type: 'boolean', description: 'a Python @overload signature stub (ADR-0028 case 2)' },
    'code:decorators': { type: 'string', description: 'a Python declaration’s decorator names as written (comma-joined)' },
    'code:exported': { type: 'boolean', description: 'the declaration is exported from its module (TypeScript)' },
    'code:default-export': { type: 'boolean', description: "the declaration is its module's default export" },
    'code:duplicate': { type: 'boolean', description: 'an illegal same-scope, same-signature duplicate (ADR-0028 case 4)' },
    'code:excluded': { type: 'string', description: 'module excluded by policy: oversize|generated (ADR-0027)' },
    'code:parse-error': { type: 'boolean', description: 'the module had syntax errors; the graph is partial' },
    'code:error-count': { type: 'number', description: 'number of recovered syntax errors in the module' },
    // 7E — import/call edges and honest counters (ADR-0026).
    'code:confidence': { type: 'string', description: "edge resolution confidence: 'syntactic' (v1) | 'typed' (reserved)" },
    'code:call-sites': { type: 'string', description: 'up to 3 sampled call-site byte spans of a code:calls edge (start-end, comma-joined)' },
    'code:calls-resolved': { type: 'number', description: 'outbound call-sites that produced a code:calls edge (ADR-0026)' },
    'code:calls-unresolved': { type: 'number', description: 'outbound in-repo call-sites that did not resolve (ADR-0026)' },
    'code:calls-external': { type: 'number', description: 'outbound call-sites import-bound to a module outside the ingested set (ADR-0026)' },
    'code:imports-external': { type: 'number', description: 'import statements whose specifier resolved to no ingested file (external)' },
    // 7F — lazy body materialization (ADR-0027).
    'code:body-span': { type: 'number-array', description: "[start, end] byte span of a function/method body; the DetailResolver.canResolve marker (ADR-0027)" },
    'code:scope-path': { type: 'string-array', description: "a function/method's ADR-0028 qualifiedName scope chain, so the resolver can re-derive byte-identical body ids" },
    'code:block-role': { type: 'string', description: 'CFG basic-block role: entry|exit|block (ADR-0027)' },
    'code:flow': { type: 'string', description: "a code:flows-to edge's control-flow reason: seq|true|false|loop|break|continue|return|exception|fallthrough|finally" },
    'code:ast-kind': { type: 'string', description: 'the grammar node type of a code:stmt/code:expr AST node (descriptive provenance)' },
  },
};

function looksBinary(text: string): boolean {
  return text.includes('\u0000');
}

function sniff(src: SourceDescriptor): number {
  if (src.mediaType === CODE_PROJECT_MEDIA_TYPE) return 1;
  if (src.text === undefined || looksBinary(src.text)) return 0;
  if (languageForPath(src.uri) !== undefined) return 0.9;
  return 0;
}

/** The file set to map, plus the project root name, from either input shape. */
function resolveInput(src: SourceDescriptor): { root: string; files: readonly BundleFile[] } {
  if (src.mediaType === CODE_PROJECT_MEDIA_TYPE) {
    if (src.text === undefined) {
      throw new Error(`${DOMAIN} parser: bundle "${src.uri}" carries no text`);
    }
    return decodeProjectBundle(src.text);
  }
  if (src.text === undefined) {
    throw new Error(
      `${DOMAIN} parser needs text; "${src.uri}" provided ${src.bytes ? 'binary bytes' : 'no content'}`,
    );
  }
  if (looksBinary(src.text)) {
    throw new Error(`"${src.uri}" is not valid text (NUL byte)`);
  }
  const base = normalizePosixPath(src.uri).split('/').pop() ?? src.uri;
  const root = base.replace(CODE_EXTENSIONS, '') || base;
  return { root, files: [{ path: base, text: src.text }] };
}

function oversizeReason(text: string): 'oversize' | undefined {
  if (text.length > MAX_FILE_BYTES) return 'oversize';
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines > MAX_FILE_LOC ? 'oversize' : undefined;
}

/**
 * Build the code plugin around an injected mapper. `mapper` owns the grammar
 * runtime (worker or in-process); the plugin only sequences files, applies the
 * exclusion policy, and derives IDs through `ctx.ids`.
 */
export function createCodePlugin(deps: { readonly mapper: CodeMapper }): MeridianPlugin {
  const { mapper } = deps;
  return {
    manifest,
    activate: (ctx: PluginContext) => ({
      parsers: [
        {
          domain: DOMAIN,
          sniff,
          ingest: async (src, sink) => {
            const { root, files } = resolveInput(src);
            sink.progress({ stage: 'map', done: 0, total: files.length });
            const modules: RawModule[] = [];
            let done = 0;
            for (const file of files) {
              const language = languageForPath(file.path);
              if (language === undefined || !isCodeLanguage(language)) {
                done += 1;
                continue; // not a routed code file (TypeScript or Python); skip
              }
              const source = normalizePosixPath(file.path);
              const label = source.split('/').pop() ?? source;
              const excluded = oversizeReason(file.text);
              if (excluded !== undefined) {
                // Flagged, cold, non-resolvable: a module node with no walk.
                modules.push({
                  source,
                  language,
                  label,
                  span: [0, file.text.length],
                  decls: [],
                  imports: [],
                  hasErrors: false,
                  errorCount: 0,
                  excluded,
                });
              } else {
                modules.push(await mapper.mapModule({ language, source, label, text: file.text }));
              }
              sink.progress({ stage: 'map', done: ++done, total: files.length });
            }
            sink.progress({ stage: 'build', done: files.length, total: files.length });
            const tree = assembleProject(root, modules);
            sink.emitDocument(buildCodeDocument(ctx, tree, VERSION));
          },
        },
      ],
    }),
  };
}
