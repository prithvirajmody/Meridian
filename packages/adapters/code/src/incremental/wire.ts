/**
 * Wire-form helpers for the incremental differ (7G). The code adapter's `src`
 * sees only plugin-api (§20, the `adapters-see-only-plugin-api` law), so it may
 * **not** import graph-store's `diffSpaces`: the incremental diff is implemented
 * here over the plain wire IR ({@link GraphDocument}) and emits plain op objects
 * (`Record<string, unknown>`) exactly like {@link ../detail/build-detail.js}.
 * The store decodes and gates them downstream — this is a delta *producer*, not
 * a second write path (ADR-0005).
 *
 * The **span-exclusion** rule (ADR-0028, the empty-delta invariant) lives here:
 * node/edge/graph identity for diffing excludes byte offsets — the provenance
 * span and the span-valued attrs (`code:body-span`, `code:call-sites`) — because
 * none of those changes semantics, only position. A whitespace-only edit shifts
 * every span but changes no id/kind/label/attr-excluding-span/detail, so the diff
 * is empty; stored spans then lag until the next substantive touch (the ADR's
 * documented, flagged trade).
 */
import type { GraphDocument } from '@meridian/plugin-api';

export type WireGraph = GraphDocument['graphs'][number];
export type WireNode = WireGraph['nodes'][number];
export type WireEdge = WireGraph['edges'][number];
export type WireMeta = WireGraph['meta'];
export type Provenance = WireNode['provenance'];
export type AttrBag = NonNullable<WireNode['attrs']>;
export type AttrValue = AttrBag[string];

/** A plain wire op (the vocabulary lives in graph-store; decoded downstream). */
export type Op = Record<string, unknown>;

/** Span-valued node attrs: byte offsets that shift under whitespace (ADR-0028).
 * Excluded from *value* equality, but a presence change (a body appearing or
 * disappearing) is still a real edit and is emitted. */
export const SPAN_NODE_ATTRS: ReadonlySet<string> = new Set(['code:body-span']);
/** Span-valued edge attrs (sampled call-site byte spans, ADR-0026). */
export const SPAN_EDGE_ATTRS: ReadonlySet<string> = new Set(['code:call-sites']);

export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Structural equality over plain wire values (JSON data: no Maps, no classes). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!deepEqual(x[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const xk = Object.keys(x);
  const yk = Object.keys(y);
  if (xk.length !== yk.length) return false;
  for (const k of xk) {
    if (!Object.prototype.hasOwnProperty.call(y, k)) return false;
    if (!deepEqual(x[k], y[k])) return false;
  }
  return true;
}

/** Provenance equality **excluding the byte span** (ADR-0028): origin/uri/model/
 * confidence must match; the span may have drifted. */
export function provEqualModuloSpan(a: Provenance, b: Provenance): boolean {
  return (
    a.origin === b.origin &&
    a.uri === b.uri &&
    a.model === b.model &&
    a.confidence === b.confidence
  );
}

/** Graph meta equality excluding its provenance span. */
export function metaEqualModuloSpan(a: WireMeta, b: WireMeta): boolean {
  return a.label === b.label && a.domain === b.domain && provEqualModuloSpan(a.provenance, b.provenance);
}

/**
 * Attr-bag equality excluding the value of the given span keys — but a
 * *presence* change on a span key (added / removed) still counts as different,
 * so a declaration gaining or losing a body is not mistaken for a no-op.
 */
export function attrsEqualModuloSpan(
  aBag: AttrBag | undefined,
  bBag: AttrBag | undefined,
  spanKeys: ReadonlySet<string>,
): boolean {
  const a = aBag ?? {};
  const b = bBag ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const inA = Object.prototype.hasOwnProperty.call(a, key);
    const inB = Object.prototype.hasOwnProperty.call(b, key);
    if (spanKeys.has(key)) {
      if (inA !== inB) return false; // presence change is a real edit
      continue; // value drift on a span attr is ignored
    }
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/** Provenance object cloned to a plain op field (spans as fixed 2-tuples). */
export function cloneProv(p: Provenance): Op {
  const out: Op = { origin: p.origin };
  if (p.uri !== undefined) out.uri = p.uri;
  if (p.span !== undefined) out.span = [p.span[0], p.span[1]];
  if (p.model !== undefined) out.model = p.model;
  if (p.confidence !== undefined) out.confidence = p.confidence;
  return out;
}
