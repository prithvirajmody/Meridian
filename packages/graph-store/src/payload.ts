/**
 * Op payload validation + canonicalization. Payloads entering the store get
 * the same discipline the document codec applies (NFC strings, -0 collapse,
 * kind/attr grammar, provenance completeness) so committed state is always
 * `validate`-clean — mirrors graph-core's constructors, as one would expect
 * of the only other producer of committed elements.
 */
import {
  ATTR_KEY_PATTERN,
  canonAttrs,
  canonNumber,
  canonProvenance,
  CORE_NAMESPACE,
  COORD_SEPARATOR,
  isValidAttrValue,
  KIND_PATTERN,
  namespaceOf,
  nfc,
  RESERVED_CORE_ATTR_KEYS,
  type AttrBag,
  type AttrValue,
  type EdgeId,
  type GraphId,
  type GraphMeta,
  type NodeId,
  type SemanticEdge,
  type SemanticNode,
  type SourceRef,
} from '@meridian/graph-core';
import type { StoreIssue, StoreIssueCode } from './issues.js';

/** Internal control flow for op application; callers convert to StoreIssue. */
export class OpViolation extends Error {
  constructor(
    readonly code: StoreIssueCode,
    message: string,
    readonly where: { graphId?: string; elementId?: string } = {},
  ) {
    super(message);
    this.name = 'OpViolation';
  }

  toIssue(opIndex: number): StoreIssue {
    return {
      code: this.code,
      message: this.message,
      opIndex,
      ...(this.where.graphId !== undefined ? { graphId: this.where.graphId } : {}),
      ...(this.where.elementId !== undefined ? { elementId: this.where.elementId } : {}),
    };
  }
}

const ORIGINS: ReadonlySet<string> = new Set(['source', 'derived', 'ai']);

export function checkId(id: string, what: string, where: { graphId?: string }): string {
  const c = nfc(id);
  if (c.length === 0 || c.includes(COORD_SEPARATOR)) {
    throw new OpViolation('invalid-id', `${what}: IDs must be non-empty and free of U+001F`, {
      ...where,
      elementId: id,
    });
  }
  return c;
}

export function checkKind(kind: string, what: string, where: { graphId?: string; elementId?: string }): string {
  const k = nfc(kind);
  if (!KIND_PATTERN.test(k)) {
    throw new OpViolation(
      'invalid-kind',
      `${what}: kind "${kind}" must match ns:name with [a-z][a-z0-9-]* parts (ADR-0003)`,
      where,
    );
  }
  return k;
}

export function checkProvenance(
  p: SourceRef,
  what: string,
  where: { graphId?: string; elementId?: string },
): SourceRef {
  if (!ORIGINS.has(p.origin)) {
    throw new OpViolation(
      'invalid-provenance',
      `${what}: provenance origin must be 'source' | 'derived' | 'ai' (U7 — "unknown" is not a valid origin)`,
      where,
    );
  }
  if (p.confidence !== undefined && !(p.confidence >= 0 && p.confidence <= 1)) {
    throw new OpViolation('invalid-provenance', `${what}: provenance confidence must be in [0, 1]`, where);
  }
  if (p.span !== undefined) {
    const [start, end] = p.span;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new OpViolation(
        'invalid-provenance',
        `${what}: provenance span must be [start, end], integers, 0 <= start <= end`,
        where,
      );
    }
  }
  return canonProvenance(p);
}

export function checkAttrKey(key: string, what: string, where: { graphId?: string; elementId?: string }): string {
  const k = nfc(key);
  if (!ATTR_KEY_PATTERN.test(k)) {
    throw new OpViolation(
      'invalid-attr-key',
      `${what}: attr key "${key}" must match ns:name with [a-z][a-z0-9-]* parts (ADR-0003)`,
      where,
    );
  }
  if (namespaceOf(k) === CORE_NAMESPACE) {
    throw new OpViolation(
      'reserved-core-key',
      RESERVED_CORE_ATTR_KEYS.has(k)
        ? `${what}: attr key "${k}" is reserved and not yet emitted by the platform (ADR-0003)`
        : `${what}: attr key "${k}" is not in the closed core registry (ADR-0003 — core grows only by ADR)`,
      where,
    );
  }
  return k;
}

export function checkAttrValue(
  value: unknown,
  what: string,
  where: { graphId?: string; elementId?: string },
): AttrValue {
  if (!isValidAttrValue(value)) {
    throw new OpViolation(
      'invalid-attr-value',
      `${what}: attr values must be a scalar or homogeneous array of non-null scalars, numbers finite (ADR-0003)`,
      where,
    );
  }
  return value;
}

function checkAttrs(attrs: AttrBag, what: string, where: { graphId?: string; elementId?: string }): AttrBag {
  for (const [key, value] of Object.entries(attrs)) {
    checkAttrKey(key, `${what} attr "${key}"`, where);
    checkAttrValue(value, `${what} attr "${key}"`, where);
  }
  return canonAttrs(attrs);
}

export function canonMeta(meta: GraphMeta, what: string, where: { graphId?: string }): GraphMeta {
  const domain = nfc(meta.domain);
  if (domain.length === 0) {
    throw new OpViolation('invalid-domain', `${what}: meta.domain must be non-empty`, where);
  }
  return {
    label: nfc(meta.label),
    domain,
    provenance: checkProvenance(meta.provenance, what, where),
  };
}

export function canonNode(node: SemanticNode, what: string, where: { graphId?: string }): SemanticNode {
  const id = checkId(node.id, `${what} id`, where) as NodeId;
  const w = { ...where, elementId: String(id) };
  return {
    id,
    kind: checkKind(node.kind, what, w),
    label: nfc(node.label),
    ...(node.detail
      ? { detail: { graph: checkId(node.detail.graph, `${what} detail graph`, where) as GraphId } }
      : {}),
    attrs: checkAttrs(node.attrs ?? {}, what, w),
    provenance: checkProvenance(node.provenance, what, w),
  };
}

export function canonEdge(edge: SemanticEdge, what: string, where: { graphId?: string }): SemanticEdge {
  const id = checkId(edge.id, `${what} id`, where) as EdgeId;
  const w = { ...where, elementId: String(id) };
  if (edge.weight !== undefined && !Number.isFinite(edge.weight)) {
    throw new OpViolation('invalid-weight', `${what}: weight must be finite`, w);
  }
  return {
    id,
    src: checkId(edge.src, `${what} src`, where) as NodeId,
    dst: checkId(edge.dst, `${what} dst`, where) as NodeId,
    kind: checkKind(edge.kind, what, w),
    ...(edge.weight !== undefined ? { weight: canonNumber(edge.weight) } : {}),
    attrs: checkAttrs(edge.attrs ?? {}, what, w),
    provenance: checkProvenance(edge.provenance, what, w),
  };
}

// ------------------------------------------------------- structural equality

/** Deep equality over JSON-shaped values (payloads never contain Maps). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as object).filter((k) => (a as never)[k] !== undefined);
    const kb = Object.keys(b as object).filter((k) => (b as never)[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as never)[k], (b as never)[k]));
  }
  return false;
}

/** Enforce a stated `prev` assertion against actual state (ADR-0005). */
export function assertPrev(
  stated: unknown,
  actual: unknown,
  what: string,
  where: { graphId?: string; elementId?: string },
): void {
  if (stated === undefined) return;
  if (!deepEqual(stated, actual)) {
    throw new OpViolation(
      'op-conflict',
      `${what}: stated prev does not match actual state — the delta was built against a different state`,
      where,
    );
  }
}
