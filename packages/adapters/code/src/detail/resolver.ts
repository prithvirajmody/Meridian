/**
 * `code`'s {@link DetailResolver} (7F, ADR-0027): materialize a cold function/
 * method's CFG + AST on drill-in. `canResolve` is the pure predicate the host/UI
 * shows a drill-in affordance from; `resolve` re-parses the file (in the parse
 * worker, via the injected {@link CodeMapper}), builds the body, and emits the
 * subgraph through the ordinary {@link IngestSink} as one op-based delta
 * (ADR-0005 — no second write path), returning the new detail ref.
 *
 * Constructed with an injected `readSource` because the resolver, like the
 * parser, never touches the filesystem (ADR-0009 — the composition root owns
 * I/O); the file's *current* text is what a re-parse needs, and the cold node
 * carries only its provenance uri + span.
 */
import type {
  DetailContext,
  DetailGraphRef,
  DetailNode,
  DetailResolver,
  IdFacade,
  IngestSink,
} from '@meridian/plugin-api';
import { DOMAIN } from '../document.js';
import { languageForPath } from '../languages.js';
import type { CodeMapper } from '../mapper.js';
import { buildBodyDelta, DetailResolveError } from './build-detail.js';

const RESOLVABLE_KINDS: ReadonlySet<string> = new Set([`${DOMAIN}:function`, `${DOMAIN}:method`]);

/** The pure `canResolve` predicate (ADR-0027): a cold function/method with a
 * body. `code:body-span` is present iff the declaration has a materializable
 * body (absent for abstract/overload/declaration stubs). */
export function canResolveCodeDetail(node: DetailNode): boolean {
  return (
    RESOLVABLE_KINDS.has(node.kind) &&
    node.detail === undefined &&
    Array.isArray(node.attrs?.['code:body-span'])
  );
}

export interface CodeDetailResolverDeps {
  /** The grammar-runtime seam (worker in production, in-process in tests). */
  readonly mapper: Pick<CodeMapper, 'resolveBody'>;
  /** Deterministic id derivation (ADR-0002/0028) — the composition root's. */
  readonly ids: IdFacade;
  /** Read a file's *current* text by its provenance uri (the ADR-0028 `source`
   * coordinate). Returns undefined if the file is unavailable. */
  readonly readSource: (uri: string) => string | undefined | Promise<string | undefined>;
}

export function createCodeDetailResolver(deps: CodeDetailResolverDeps): DetailResolver {
  const { mapper, ids, readSource } = deps;
  return {
    id: DOMAIN,
    canResolve: canResolveCodeDetail,
    async resolve(node: DetailNode, sink: IngestSink, ctx: DetailContext): Promise<DetailGraphRef> {
      if (!canResolveCodeDetail(node)) {
        throw new DetailResolveError(
          `code detail-resolver: node "${node.id}" (${node.kind}) is not a cold, body-bearing function/method`,
        );
      }
      const source = node.provenance.uri;
      if (source === undefined) {
        throw new DetailResolveError(`code detail-resolver: node "${node.id}" has no provenance uri`);
      }
      const language = languageForPath(source);
      if (language === undefined) {
        throw new DetailResolveError(`code detail-resolver: cannot infer language of "${source}"`);
      }
      const declSpan = node.provenance.span;
      if (declSpan === undefined) {
        throw new DetailResolveError(`code detail-resolver: node "${node.id}" has no provenance span`);
      }
      const text = await readSource(source);
      if (text === undefined) {
        throw new DetailResolveError(`code detail-resolver: source "${source}" is unavailable`);
      }
      const body = await mapper.resolveBody(
        { language, source, text, declSpan },
        ctx.signal !== undefined ? { signal: ctx.signal } : {},
      );
      if (body === undefined) {
        throw new DetailResolveError(
          `code detail-resolver: no resolvable body at ${declSpan[0]}-${declSpan[1]} in "${source}"`,
        );
      }
      const { delta, detail } = buildBodyDelta(ids, node, body);
      sink.emitDelta(delta);
      return detail;
    },
  };
}
