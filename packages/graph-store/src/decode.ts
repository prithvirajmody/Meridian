/**
 * The delta wire gate (ADR-0005): parse-don't-validate for `meridian mutate`
 * scripts and replayed delta files. Hand-rolled (graph-store imports only
 * graph-core — §20), aggregates all structural errors with JSON paths, and
 * applies the same canonicalization as the document codec (NFC, -0). Element
 * payloads use the document format's shapes (ADR-0004). Unknown keys are
 * ignored and dropped, like the codec.
 */
import {
  canonAttrValue,
  canonNumber,
  nfc,
  type AttrBag,
  type AttrValue,
  type EdgeId,
  type GraphId,
  type GraphMeta,
  type GraphRef,
  type NodeId,
  type SemanticEdge,
  type SemanticNode,
  type SourceRef,
  isValidAttrValue,
} from '@meridian/graph-core';
import type { StoreIssue } from './issues.js';
import type { GraphDeltaInput, GraphOp, GraphOpInput, OpOrigin, PortableDelta } from './ops.js';
import { LOCAL_SITE, type VersionStamp } from './version.js';

export type DecodeDeltaResult =
  | { readonly ok: true; readonly delta: GraphDeltaInput }
  | { readonly ok: false; readonly errors: readonly StoreIssue[] };

export type DecodeCompleteDeltaResult =
  | { readonly ok: true; readonly delta: PortableDelta }
  | { readonly ok: false; readonly errors: readonly StoreIssue[] };

class Errors {
  readonly list: StoreIssue[] = [];
  add(path: string, message: string): void {
    this.list.push({ code: 'invalid-delta', message, path });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, path: string, e: Errors, opts: { nonEmpty?: boolean } = {}): string | undefined {
  if (typeof v !== 'string') {
    e.add(path, 'expected a string');
    return undefined;
  }
  const c = nfc(v);
  if (opts.nonEmpty && c.length === 0) {
    e.add(path, 'expected a non-empty string');
    return undefined;
  }
  return c;
}

function decodeProvenance(v: unknown, path: string, e: Errors): SourceRef | undefined {
  if (!isRecord(v)) {
    e.add(path, 'expected a provenance object (U7 — every element has an origin)');
    return undefined;
  }
  const origin = v.origin;
  if (origin !== 'source' && origin !== 'derived' && origin !== 'ai') {
    e.add(`${path}.origin`, `expected 'source' | 'derived' | 'ai'`);
    return undefined;
  }
  const out: {
    origin: SourceRef['origin'];
    uri?: string;
    span?: readonly [number, number];
    providerId?: string;
    model?: string;
    promptVersion?: string;
    inputHash?: string;
    confidence?: number;
  } = { origin };
  if (v.uri !== undefined) {
    const uri = str(v.uri, `${path}.uri`, e);
    if (uri !== undefined) out.uri = uri;
  }
  if (v.span !== undefined) {
    const s = v.span;
    if (
      !Array.isArray(s) ||
      s.length !== 2 ||
      !Number.isInteger(s[0]) ||
      !Number.isInteger(s[1]) ||
      (s[0] as number) < 0 ||
      (s[1] as number) < (s[0] as number)
    ) {
      e.add(`${path}.span`, 'expected [start, end], integers, 0 <= start <= end');
    } else {
      out.span = [s[0] as number, s[1] as number];
    }
  }
  if (v.providerId !== undefined) {
    const providerId = str(v.providerId, `${path}.providerId`, e);
    if (providerId !== undefined) out.providerId = providerId;
  }
  if (v.model !== undefined) {
    const model = str(v.model, `${path}.model`, e);
    if (model !== undefined) out.model = model;
  }
  if (v.promptVersion !== undefined) {
    const promptVersion = str(v.promptVersion, `${path}.promptVersion`, e);
    if (promptVersion !== undefined) out.promptVersion = promptVersion;
  }
  if (v.inputHash !== undefined) {
    const inputHash = str(v.inputHash, `${path}.inputHash`, e);
    if (inputHash !== undefined) out.inputHash = inputHash;
  }
  if (v.confidence !== undefined) {
    if (typeof v.confidence !== 'number' || !(v.confidence >= 0 && v.confidence <= 1)) {
      e.add(`${path}.confidence`, 'expected a number in [0, 1]');
    } else {
      out.confidence = canonNumber(v.confidence);
    }
  }
  return out;
}

function decodeAttrs(v: unknown, path: string, e: Errors): AttrBag | undefined {
  if (v === undefined) return {};
  if (!isRecord(v)) {
    e.add(path, 'expected an attrs object');
    return undefined;
  }
  const out: Record<string, AttrValue> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!isValidAttrValue(value)) {
      e.add(`${path}.${key}`, 'expected a scalar or homogeneous array of non-null scalars, numbers finite');
      continue;
    }
    out[nfc(key)] = canonAttrValue(value);
  }
  return out;
}

function decodeAttrValue(v: unknown, path: string, e: Errors): AttrValue | undefined {
  if (!isValidAttrValue(v)) {
    e.add(path, 'expected a scalar or homogeneous array of non-null scalars, numbers finite');
    return undefined;
  }
  return canonAttrValue(v);
}

function decodeMeta(v: unknown, path: string, e: Errors): GraphMeta | undefined {
  if (!isRecord(v)) {
    e.add(path, 'expected a graph meta object { label, domain, provenance }');
    return undefined;
  }
  const label = str(v.label, `${path}.label`, e);
  const domain = str(v.domain, `${path}.domain`, e, { nonEmpty: true });
  const provenance = decodeProvenance(v.provenance, `${path}.provenance`, e);
  if (label === undefined || domain === undefined || provenance === undefined) return undefined;
  return { label, domain, provenance };
}

function decodeGraphRef(v: unknown, path: string, e: Errors): GraphRef | undefined {
  if (!isRecord(v)) {
    e.add(path, 'expected a graph reference { graph }');
    return undefined;
  }
  const graph = str(v.graph, `${path}.graph`, e, { nonEmpty: true });
  return graph === undefined ? undefined : { graph: graph as GraphId };
}

function decodeNode(v: unknown, path: string, e: Errors): SemanticNode | undefined {
  if (!isRecord(v)) {
    e.add(path, 'expected a node object');
    return undefined;
  }
  const id = str(v.id, `${path}.id`, e, { nonEmpty: true });
  const kind = str(v.kind, `${path}.kind`, e, { nonEmpty: true });
  const label = str(v.label, `${path}.label`, e);
  const detail = v.detail !== undefined ? decodeGraphRef(v.detail, `${path}.detail`, e) : undefined;
  const attrs = decodeAttrs(v.attrs, `${path}.attrs`, e);
  const provenance = decodeProvenance(v.provenance, `${path}.provenance`, e);
  if (
    id === undefined ||
    kind === undefined ||
    label === undefined ||
    attrs === undefined ||
    provenance === undefined ||
    (v.detail !== undefined && detail === undefined)
  ) {
    return undefined;
  }
  return {
    id: id as NodeId,
    kind,
    label,
    ...(detail ? { detail } : {}),
    attrs,
    provenance,
  };
}

function decodeEdge(v: unknown, path: string, e: Errors): SemanticEdge | undefined {
  if (!isRecord(v)) {
    e.add(path, 'expected an edge object');
    return undefined;
  }
  const id = str(v.id, `${path}.id`, e, { nonEmpty: true });
  const src = str(v.src, `${path}.src`, e, { nonEmpty: true });
  const dst = str(v.dst, `${path}.dst`, e, { nonEmpty: true });
  const kind = str(v.kind, `${path}.kind`, e, { nonEmpty: true });
  let weight: number | undefined;
  if (v.weight !== undefined) {
    if (typeof v.weight !== 'number' || !Number.isFinite(v.weight)) {
      e.add(`${path}.weight`, 'expected a finite number');
    } else {
      weight = canonNumber(v.weight);
    }
  }
  const attrs = decodeAttrs(v.attrs, `${path}.attrs`, e);
  const provenance = decodeProvenance(v.provenance, `${path}.provenance`, e);
  if (
    id === undefined ||
    src === undefined ||
    dst === undefined ||
    kind === undefined ||
    attrs === undefined ||
    provenance === undefined
  ) {
    return undefined;
  }
  return {
    id: id as EdgeId,
    src: src as NodeId,
    dst: dst as NodeId,
    kind,
    ...(weight !== undefined ? { weight } : {}),
    attrs,
    provenance,
  };
}

const OP_TAGS: ReadonlySet<string> = new Set([
  'graph:add',
  'graph:remove',
  'graph:meta',
  'node:add',
  'node:remove',
  'node:attr',
  'node:detail',
  'edge:add',
  'edge:remove',
]);

function decodeOp(v: unknown, path: string, e: Errors): GraphOpInput | undefined {
  if (!isRecord(v)) {
    e.add(path, 'expected an op object');
    return undefined;
  }
  const t = v.t;
  if (typeof t !== 'string' || !OP_TAGS.has(t)) {
    e.add(`${path}.t`, `unknown op type ${JSON.stringify(t)} — vocabulary v1 is ${[...OP_TAGS].join(', ')} (ADR-0005)`);
    return undefined;
  }
  // An op whose graph id is invalid reports that and skips payload analysis
  // (same scoping as the document codec's structural pass).
  const graph = str(v.graph, `${path}.graph`, e, { nonEmpty: true }) as GraphId | undefined;
  if (graph === undefined) return undefined;
  const before = e.list.length;

  switch (t) {
    case 'graph:add': {
      const meta = decodeMeta(v.meta, `${path}.meta`, e);
      return meta && e.list.length === before ? { t, graph, meta } : undefined;
    }
    case 'graph:remove': {
      const prev = v.prev !== undefined ? decodeMeta(v.prev, `${path}.prev`, e) : undefined;
      if (v.prev !== undefined && prev === undefined) return undefined;
      return e.list.length === before ? { t, graph, ...(prev ? { prev } : {}) } : undefined;
    }
    case 'graph:meta': {
      const next = decodeMeta(v.next, `${path}.next`, e);
      const prev = v.prev !== undefined ? decodeMeta(v.prev, `${path}.prev`, e) : undefined;
      if (v.prev !== undefined && prev === undefined) return undefined;
      return next && e.list.length === before ? { t, graph, ...(prev ? { prev } : {}), next } : undefined;
    }
    case 'node:add': {
      const node = decodeNode(v.node, `${path}.node`, e);
      return node && e.list.length === before ? { t, graph, node } : undefined;
    }
    case 'node:remove': {
      const id = str(v.id, `${path}.id`, e, { nonEmpty: true }) as NodeId | undefined;
      const prev = v.prev !== undefined ? decodeNode(v.prev, `${path}.prev`, e) : undefined;
      if (v.prev !== undefined && prev === undefined) return undefined;
      return id !== undefined && e.list.length === before
        ? { t, graph, id, ...(prev ? { prev } : {}) }
        : undefined;
    }
    case 'node:attr': {
      const id = str(v.id, `${path}.id`, e, { nonEmpty: true }) as NodeId | undefined;
      const key = str(v.key, `${path}.key`, e, { nonEmpty: true });
      // Absent next = remove the key (JSON cannot state an explicit "absent",
      // and null is a real attr value); absent prev = no assertion.
      const prev = v.prev !== undefined ? decodeAttrValue(v.prev, `${path}.prev`, e) : undefined;
      const next = v.next !== undefined ? decodeAttrValue(v.next, `${path}.next`, e) : undefined;
      return id !== undefined && key !== undefined && e.list.length === before
        ? {
            t,
            graph,
            id,
            key,
            ...(prev !== undefined ? { prev } : {}),
            ...(next !== undefined ? { next } : {}),
          }
        : undefined;
    }
    case 'node:detail': {
      const id = str(v.id, `${path}.id`, e, { nonEmpty: true }) as NodeId | undefined;
      const prev = v.prev !== undefined ? decodeGraphRef(v.prev, `${path}.prev`, e) : undefined;
      const next = v.next !== undefined ? decodeGraphRef(v.next, `${path}.next`, e) : undefined;
      if (v.prev !== undefined && prev === undefined) return undefined;
      if (v.next !== undefined && next === undefined) return undefined;
      return id !== undefined && e.list.length === before
        ? { t, graph, id, ...(prev ? { prev } : {}), ...(next ? { next } : {}) }
        : undefined;
    }
    case 'edge:add': {
      const edge = decodeEdge(v.edge, `${path}.edge`, e);
      return edge && e.list.length === before ? { t, graph, edge } : undefined;
    }
    case 'edge:remove': {
      const id = str(v.id, `${path}.id`, e, { nonEmpty: true }) as EdgeId | undefined;
      const prev = v.prev !== undefined ? decodeEdge(v.prev, `${path}.prev`, e) : undefined;
      if (v.prev !== undefined && prev === undefined) return undefined;
      return id !== undefined && e.list.length === before
        ? { t, graph, id, ...(prev ? { prev } : {}) }
        : undefined;
    }
    default:
      return undefined;
  }
}

function decodeVersion(v: unknown, path: string, e: Errors): VersionStamp | undefined {
  if (!isRecord(v)) {
    e.add(path, 'expected a version stamp { counter, site }');
    return undefined;
  }
  if (typeof v.counter !== 'number' || !Number.isInteger(v.counter) || v.counter < 0) {
    e.add(`${path}.counter`, 'expected a non-negative integer');
    return undefined;
  }
  const site = v.site === undefined ? LOCAL_SITE : v.site;
  if (typeof site !== 'string' || site.length === 0) {
    e.add(`${path}.site`, 'expected a non-empty string');
    return undefined;
  }
  return { counter: v.counter, site };
}

/**
 * Decode a submittable delta (or its JSON text). Aggregates all structural
 * errors; nothing partially-parsed escapes.
 */
export function decodeDeltaInput(input: string | unknown): DecodeDeltaResult {
  let raw: unknown;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      return {
        ok: false,
        errors: [
          { code: 'invalid-delta', message: `not valid JSON: ${(err as Error).message}`, path: '(root)' },
        ],
      };
    }
  } else {
    raw = input;
  }

  const e = new Errors();
  if (!isRecord(raw)) {
    e.add('(root)', 'a delta is a JSON object { baseVersion?, origin, ops }');
    return { ok: false, errors: e.list };
  }
  const baseVersion =
    raw.baseVersion !== undefined ? decodeVersion(raw.baseVersion, 'baseVersion', e) : undefined;
  let origin: OpOrigin | undefined;
  if (!isRecord(raw.origin) || typeof raw.origin.actor !== 'string' || raw.origin.actor.length === 0) {
    e.add('origin', 'expected { actor: non-empty string } — history without issuers is forbidden (§3.1)');
  } else {
    origin = { actor: nfc(raw.origin.actor) };
  }
  const ops: GraphOpInput[] = [];
  if (!Array.isArray(raw.ops)) {
    e.add('ops', 'expected an array of ops');
  } else {
    raw.ops.forEach((op, i) => {
      const decoded = decodeOp(op, `ops[${i}]`, e);
      if (decoded) ops.push(decoded);
    });
  }
  if (e.list.length > 0) return { ok: false, errors: e.list };
  return {
    ok: true,
    delta: { ...(baseVersion ? { baseVersion } : {}), origin: origin!, ops },
  };
}

/**
 * Decode a *completed* (portable) delta — what `invertDelta` needs: every
 * inversion-bearing `prev` payload must be present. The version stamp stays
 * optional: stamps are per-store-session (ADR-0007), so file-portable deltas
 * rely on op-level assertions instead.
 */
export function decodeDelta(input: string | unknown): DecodeCompleteDeltaResult {
  const result = decodeDeltaInput(input);
  if (!result.ok) return result;
  const e = new Errors();
  result.delta.ops.forEach((op, i) => {
    if ((op.t === 'graph:remove' || op.t === 'node:remove' || op.t === 'edge:remove' || op.t === 'graph:meta') && op.prev === undefined) {
      e.add(`ops[${i}].prev`, `${op.t} in a completed delta carries its prev payload — thin ops cannot be inverted (ADR-0005)`);
    }
  });
  if (e.list.length > 0) return { ok: false, errors: e.list };
  return { ok: true, delta: result.delta as PortableDelta };
}

// ------------------------------------------------------------ wire encoding

/** Deterministic wire form of a completed delta (stable key order, I6). */
export function deltaToWire(delta: PortableDelta): unknown {
  return {
    ...(delta.baseVersion
      ? { baseVersion: { counter: delta.baseVersion.counter, site: delta.baseVersion.site } }
      : {}),
    origin: { actor: delta.origin.actor },
    ops: delta.ops.map(opToWire),
  };
}

function nodeToWire(n: SemanticNode): Record<string, unknown> {
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    ...(n.detail ? { detail: { graph: n.detail.graph } } : {}),
    ...(Object.keys(n.attrs).length > 0 ? { attrs: sortedBag(n.attrs) } : {}),
    provenance: provenanceToWire(n.provenance),
  };
}

function edgeToWire(edge: SemanticEdge): Record<string, unknown> {
  return {
    id: edge.id,
    src: edge.src,
    dst: edge.dst,
    kind: edge.kind,
    ...(edge.weight !== undefined ? { weight: edge.weight } : {}),
    ...(Object.keys(edge.attrs).length > 0 ? { attrs: sortedBag(edge.attrs) } : {}),
    provenance: provenanceToWire(edge.provenance),
  };
}

function metaToWire(meta: GraphMeta): Record<string, unknown> {
  return { label: meta.label, domain: meta.domain, provenance: provenanceToWire(meta.provenance) };
}

function provenanceToWire(p: SourceRef): Record<string, unknown> {
  return {
    origin: p.origin,
    ...(p.uri !== undefined ? { uri: p.uri } : {}),
    ...(p.span !== undefined ? { span: [p.span[0], p.span[1]] } : {}),
    ...(p.providerId !== undefined ? { providerId: p.providerId } : {}),
    ...(p.model !== undefined ? { model: p.model } : {}),
    ...(p.promptVersion !== undefined ? { promptVersion: p.promptVersion } : {}),
    ...(p.inputHash !== undefined ? { inputHash: p.inputHash } : {}),
    ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
  };
}

function sortedBag(attrs: AttrBag): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const key of Object.keys(attrs).sort()) out[key] = attrs[key]!;
  return out;
}

function opToWire(op: GraphOp): Record<string, unknown> {
  switch (op.t) {
    case 'graph:add':
      return { t: op.t, graph: op.graph, meta: metaToWire(op.meta) };
    case 'graph:remove':
      return { t: op.t, graph: op.graph, prev: metaToWire(op.prev) };
    case 'graph:meta':
      return { t: op.t, graph: op.graph, prev: metaToWire(op.prev), next: metaToWire(op.next) };
    case 'node:add':
      return { t: op.t, graph: op.graph, node: nodeToWire(op.node) };
    case 'node:remove':
      return { t: op.t, graph: op.graph, id: op.id, prev: nodeToWire(op.prev) };
    case 'node:attr':
      return {
        t: op.t,
        graph: op.graph,
        id: op.id,
        key: op.key,
        ...(op.prev !== undefined ? { prev: op.prev } : {}),
        ...(op.next !== undefined ? { next: op.next } : {}),
      };
    case 'node:detail':
      return {
        t: op.t,
        graph: op.graph,
        id: op.id,
        ...(op.prev ? { prev: { graph: op.prev.graph } } : {}),
        ...(op.next ? { next: { graph: op.next.graph } } : {}),
      };
    case 'edge:add':
      return { t: op.t, graph: op.graph, edge: edgeToWire(op.edge) };
    case 'edge:remove':
      return { t: op.t, graph: op.graph, id: op.id, prev: edgeToWire(op.prev) };
  }
}
