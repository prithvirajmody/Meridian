/**
 * Attribute bags (ADR-0003): namespaced keys, scalar or homogeneous
 * scalar-array values. `core:*` is reserved; other namespaces are tolerated
 * (warning) in Phase 0 and gated by registered schemas from Phase 2.
 */

export type AttrScalar = string | number | boolean | null;
export type AttrValue =
  | AttrScalar
  | readonly string[]
  | readonly number[]
  | readonly boolean[];
export type AttrBag = Readonly<Record<string, AttrValue>>;

/** `ns:name`, both parts `[a-z][a-z0-9-]*`. Also the grammar for kinds. */
export const ATTR_KEY_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
export const KIND_PATTERN = ATTR_KEY_PATTERN;

export const CORE_NAMESPACE = 'core';

/** Reserved, not yet emitted (ADR-0003): rejected from all producers in v1. */
export const RESERVED_CORE_ATTR_KEYS: ReadonlySet<string> = new Set([
  'core:salience',
  'core:layers',
]);

export function namespaceOf(key: string): string | undefined {
  const i = key.indexOf(':');
  return i === -1 ? undefined : key.slice(0, i);
}

/** Scalar or homogeneous array of non-null scalars, all numbers finite. */
export function isValidAttrValue(v: unknown): v is AttrValue {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return true;
    const t = typeof v[0];
    if (t !== 'string' && t !== 'number' && t !== 'boolean') return false;
    return v.every(
      (x) => typeof x === t && (t !== 'number' || Number.isFinite(x as number)),
    );
  }
  return false;
}
