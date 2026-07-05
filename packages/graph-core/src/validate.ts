/**
 * Semantic validation (ADR-0004 §validation, pass 2): U1 referential
 * integrity, U2 acyclic containment, U3 single ownership, U7 provenance,
 * ADR-0003 attribute discipline. Errors are located (element IDs), aggregated
 * (all of them, not the first), and typed (stable codes).
 */
import {
  ATTR_KEY_PATTERN,
  attrValueMatchesType,
  CORE_NAMESPACE,
  isValidAttrValue,
  KIND_PATTERN,
  namespaceOf,
  RESERVED_CORE_ATTR_KEYS,
  type AttrBag,
  type AttrValueType,
} from './attrs.js';
import { COORD_SEPARATOR, type GraphId, type NodeId } from './ids.js';
import type { GraphSpace, SourceRef } from './model.js';

export type IssueSeverity = 'error' | 'warning';

export type IssueCode =
  | 'malformed-json'
  | 'structural'
  | 'missing-format-version'
  | 'invalid-format-version'
  | 'unsupported-version'
  | 'invalid-id'
  | 'duplicate-id'
  | 'dangling-edge-endpoint'
  | 'dangling-detail-ref'
  | 'containment-cycle'
  | 'multiple-containment'
  | 'root-mismatch'
  | 'invalid-provenance'
  | 'invalid-kind'
  | 'invalid-attr-key'
  | 'reserved-core-key'
  | 'unregistered-namespace'
  | 'unregistered-attr-key'
  | 'attr-type-mismatch'
  | 'unregistered-kind'
  | 'invalid-attr-value'
  | 'invalid-weight'
  | 'invalid-domain'
  | 'string-not-nfc';

export interface Issue {
  readonly code: IssueCode;
  readonly severity: IssueSeverity;
  readonly message: string;
  readonly graphId?: string;
  readonly elementId?: string;
  /** JSON path, for structural (codec) issues. */
  readonly path?: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: Issue[];
  readonly warnings: Issue[];
}

/**
 * The registered vocabulary in force at an IR gate (U8): every non-`core`
 * attr key must be declared with a value type, every non-`core` kind must be
 * declared. Registration itself is a plugin concern (manifests, ADR-0011);
 * this type is deliberately domain- and plugin-agnostic.
 */
export interface VocabularyRegistry {
  readonly attrs: ReadonlyMap<string, AttrValueType>;
  readonly kinds: ReadonlySet<string>;
}

export interface ValidateOptions {
  /**
   * When present, U8 is enforced: unregistered namespaces/keys/kinds become
   * errors and declared attr value types are checked. When absent (Phase 0/1
   * callers: fixtures, store round-trips), unregistered namespaces stay
   * warnings, as before.
   */
  readonly vocabulary?: VocabularyRegistry;
}

class Collector {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];

  error(code: IssueCode, message: string, where: { graphId?: string; elementId?: string } = {}) {
    this.errors.push({ code, severity: 'error', message, ...where });
  }

  warning(code: IssueCode, message: string, where: { graphId?: string; elementId?: string } = {}) {
    this.warnings.push({ code, severity: 'warning', message, ...where });
  }
}

const ORIGINS: ReadonlySet<string> = new Set(['source', 'derived', 'ai']);

function checkNfcString(
  c: Collector,
  value: string,
  what: string,
  where: { graphId?: string; elementId?: string },
): void {
  if (value.normalize('NFC') !== value) {
    c.error(
      'string-not-nfc',
      `${what} is not NFC-normalized; constructors and decode normalize — hand-built spaces must too (ADR-0004)`,
      where,
    );
  }
}

function checkIdShape(
  c: Collector,
  id: string,
  what: string,
  where: { graphId?: string; elementId?: string },
): void {
  if (id.length === 0 || id.includes(COORD_SEPARATOR)) {
    c.error('invalid-id', `${what} must be non-empty and free of U+001F`, where);
  }
  checkNfcString(c, id, what, where);
}

function checkProvenance(
  c: Collector,
  p: SourceRef,
  what: string,
  where: { graphId?: string; elementId?: string },
): void {
  if (!ORIGINS.has(p.origin)) {
    c.error(
      'invalid-provenance',
      `${what}: provenance origin "${String(p.origin)}" is not 'source' | 'derived' | 'ai' (U7 — "unknown" is not a valid origin)`,
      where,
    );
  }
  if (p.confidence !== undefined && !(p.confidence >= 0 && p.confidence <= 1)) {
    c.error('invalid-provenance', `${what}: provenance confidence must be in [0, 1]`, where);
  }
  if (p.span !== undefined) {
    const [start, end] = p.span;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      c.error(
        'invalid-provenance',
        `${what}: provenance span must be [start, end], integers, 0 <= start <= end`,
        where,
      );
    }
  }
  if (p.uri !== undefined) checkNfcString(c, p.uri, `${what}: provenance uri`, where);
  if (p.model !== undefined) checkNfcString(c, p.model, `${what}: provenance model`, where);
}

function checkKind(
  c: Collector,
  kind: string,
  what: string,
  where: { graphId?: string; elementId?: string },
  vocabulary?: VocabularyRegistry,
): void {
  if (!KIND_PATTERN.test(kind)) {
    c.error(
      'invalid-kind',
      `${what}: kind "${kind}" must match ns:name with [a-z][a-z0-9-]* parts (ADR-0003)`,
      where,
    );
    return;
  }
  if (
    vocabulary !== undefined &&
    namespaceOf(kind) !== CORE_NAMESPACE &&
    !vocabulary.kinds.has(kind)
  ) {
    c.error(
      'unregistered-kind',
      `${what}: kind "${kind}" is not declared by any vocabulary registered at this gate (U8)`,
      where,
    );
  }
}

function checkAttrs(
  c: Collector,
  attrs: AttrBag,
  what: string,
  where: { graphId?: string; elementId?: string },
  vocabulary?: VocabularyRegistry,
  vocabularyNamespaces?: ReadonlySet<string>,
): void {
  for (const [key, value] of Object.entries(attrs)) {
    checkNfcString(c, key, `${what}: attr key "${key}"`, where);
    let declared: AttrValueType | undefined;
    if (!ATTR_KEY_PATTERN.test(key)) {
      c.error(
        'invalid-attr-key',
        `${what}: attr key "${key}" must match ns:name with [a-z][a-z0-9-]* parts (ADR-0003)`,
        where,
      );
    } else {
      const ns = namespaceOf(key);
      if (ns === CORE_NAMESPACE) {
        c.error(
          'reserved-core-key',
          RESERVED_CORE_ATTR_KEYS.has(key)
            ? `${what}: attr key "${key}" is reserved and not yet emitted by the platform (ADR-0003)`
            : `${what}: attr key "${key}" is not in the closed core registry (ADR-0003 — core grows only by ADR)`,
          where,
        );
      } else if (vocabulary === undefined) {
        c.warning(
          'unregistered-namespace',
          `${what}: attr namespace "${ns}" has no registered schema — tolerated in Phase 0, rejected at the IR gate from Phase 2 (U8)`,
          where,
        );
      } else {
        declared = vocabulary.attrs.get(key);
        if (declared === undefined) {
          if (ns !== undefined && vocabularyNamespaces?.has(ns)) {
            c.error(
              'unregistered-attr-key',
              `${what}: attr key "${key}" is not declared by namespace "${ns}"'s registered schema (U8)`,
              where,
            );
          } else {
            c.error(
              'unregistered-namespace',
              `${what}: attr namespace "${ns}" is not registered at this gate (U8)`,
              where,
            );
          }
        }
      }
    }
    if (!isValidAttrValue(value)) {
      c.error(
        'invalid-attr-value',
        `${what}: attr "${key}" must be a scalar or homogeneous array of non-null scalars, numbers finite (ADR-0003)`,
        where,
      );
    } else {
      if (typeof value === 'string') {
        checkNfcString(c, value, `${what}: attr "${key}" value`, where);
      }
      if (declared !== undefined && !attrValueMatchesType(value, declared)) {
        c.error(
          'attr-type-mismatch',
          `${what}: attr "${key}" is declared ${declared} but the value is not (U8)`,
          where,
        );
      }
    }
  }
}

export function validate(space: GraphSpace, opts: ValidateOptions = {}): ValidationResult {
  const c = new Collector();
  const vocabulary = opts.vocabulary;
  const vocabularyNamespaces =
    vocabulary === undefined
      ? undefined
      : new Set(
          [...vocabulary.attrs.keys()]
            .map((k) => namespaceOf(k))
            .filter((ns): ns is string => ns !== undefined),
        );

  // Global indices, one pass: id → where (duplicate detection, U4 loudness)
  // and node → owning graph (for precise cross-graph-edge messages).
  const idOwner = new Map<string, string>();
  const nodeLocation = new Map<NodeId, GraphId>();
  const claim = (id: string, where: string, ctx: { graphId?: string; elementId?: string }) => {
    const prior = idOwner.get(id);
    if (prior !== undefined) {
      c.error(
        'duplicate-id',
        `ID "${id}" is used by both ${prior} and ${where} — IDs must be unique across the space (ADR-0002: collisions are loud, never silent)`,
        ctx,
      );
    } else {
      idOwner.set(id, where);
    }
  };

  for (const [graphId, graph] of space.graphs) {
    if (graph.id !== graphId) {
      c.error(
        'invalid-id',
        `graph map key "${graphId}" disagrees with graph.id "${graph.id}"`,
        { graphId: String(graphId) },
      );
    }
    const gWhere = { graphId: String(graphId) };
    checkIdShape(c, graphId, `graph "${graphId}" id`, gWhere);
    claim(graphId, `graph "${graphId}"`, gWhere);
    checkNfcString(c, graph.meta.label, `graph "${graphId}" label`, gWhere);
    if (graph.meta.domain.length === 0) {
      c.error('invalid-domain', `graph "${graphId}": meta.domain must be non-empty`, gWhere);
    }
    checkNfcString(c, graph.meta.domain, `graph "${graphId}" domain`, gWhere);
    checkProvenance(c, graph.meta.provenance, `graph "${graphId}"`, gWhere);

    for (const [nodeId, node] of graph.nodes) {
      const where = { graphId: String(graphId), elementId: String(nodeId) };
      if (node.id !== nodeId) {
        c.error('invalid-id', `node map key "${nodeId}" disagrees with node.id "${node.id}"`, where);
      }
      checkIdShape(c, nodeId, `node "${nodeId}" id`, where);
      claim(nodeId, `node "${nodeId}" in graph "${graphId}"`, where);
      nodeLocation.set(nodeId, graphId);
      checkKind(c, node.kind, `node "${nodeId}"`, where, vocabulary);
      checkNfcString(c, node.label, `node "${nodeId}" label`, where);
      checkAttrs(c, node.attrs, `node "${nodeId}"`, where, vocabulary, vocabularyNamespaces);
      checkProvenance(c, node.provenance, `node "${nodeId}"`, where);
      if (node.detail && !space.graphs.has(node.detail.graph)) {
        c.error(
          'dangling-detail-ref',
          `node "${nodeId}" detail references graph "${node.detail.graph}", which does not exist in the space (U1)`,
          where,
        );
      }
    }
  }

  // Second pass for edges so nodeLocation is complete (cross-graph hints).
  for (const [graphId, graph] of space.graphs) {
    for (const [edgeId, edge] of graph.edges) {
      const where = { graphId: String(graphId), elementId: String(edgeId) };
      if (edge.id !== edgeId) {
        c.error('invalid-id', `edge map key "${edgeId}" disagrees with edge.id "${edge.id}"`, where);
      }
      checkIdShape(c, edgeId, `edge "${edgeId}" id`, where);
      claim(edgeId, `edge "${edgeId}" in graph "${graphId}"`, where);
      for (const [endpoint, name] of [
        [edge.src, 'src'],
        [edge.dst, 'dst'],
      ] as const) {
        if (!graph.nodes.has(endpoint)) {
          const elsewhere = nodeLocation.get(endpoint);
          c.error(
            'dangling-edge-endpoint',
            elsewhere !== undefined
              ? `edge "${edgeId}" ${name} "${endpoint}" is a node of graph "${elsewhere}", not of "${graphId}" — cross-graph edges are forbidden; record the link at the lowest common graph (portal rule, ADR-0001)`
              : `edge "${edgeId}" ${name} "${endpoint}" does not resolve to a node in graph "${graphId}" (U1)`,
            where,
          );
        }
      }
      checkKind(c, edge.kind, `edge "${edgeId}"`, where, vocabulary);
      if (edge.weight !== undefined && !Number.isFinite(edge.weight)) {
        c.error('invalid-weight', `edge "${edgeId}": weight must be finite`, where);
      }
      checkAttrs(c, edge.attrs, `edge "${edgeId}"`, where, vocabulary, vocabularyNamespaces);
      checkProvenance(c, edge.provenance, `edge "${edgeId}"`, where);
    }
  }

  // Containment: child → parent from detail refs; duplicates are U3 errors.
  const parentOf = new Map<GraphId, GraphId>();
  for (const [graphId, graph] of space.graphs) {
    for (const [nodeId, node] of graph.nodes) {
      if (!node.detail) continue;
      const child = node.detail.graph;
      if (!space.graphs.has(child)) continue; // already reported as dangling
      const prior = parentOf.get(child);
      if (prior !== undefined) {
        c.error(
          'multiple-containment',
          `graph "${child}" is the detail of more than one node (also of node "${nodeId}" in graph "${graphId}") — a graph has at most one containing node (U3)`,
          { graphId: String(graphId), elementId: String(nodeId) },
        );
      } else {
        parentOf.set(child, graphId);
      }
    }
  }

  // U2: the containment relation is a forest — no graph is its own ancestor.
  const state = new Map<GraphId, 'visiting' | 'done'>();
  for (const graphId of space.graphs.keys()) {
    if (state.has(graphId)) continue;
    const chain: GraphId[] = [];
    let current: GraphId | undefined = graphId;
    while (current !== undefined && !state.has(current)) {
      state.set(current, 'visiting');
      chain.push(current);
      current = parentOf.get(current);
    }
    if (current !== undefined && state.get(current) === 'visiting') {
      const cycleStart = chain.indexOf(current);
      const cycle = chain.slice(cycleStart);
      c.error(
        'containment-cycle',
        `containment cycle: ${[...cycle, current].map((g) => `"${g}"`).join(' → ')} (U2 — containment is a forest; domain cycles belong in edges, not containment)`,
        { graphId: String(current) },
      );
    }
    for (const g of chain) state.set(g, 'done');
  }

  // Roots: the stated array must equal the derived set, without duplicates.
  const derived = new Set<GraphId>(
    [...space.graphs.keys()].filter((id) => !parentOf.has(id)),
  );
  const stated = new Set<GraphId>();
  for (const root of space.roots) {
    if (stated.has(root)) {
      c.error('root-mismatch', `roots lists graph "${root}" more than once`, {
        graphId: String(root),
      });
      continue;
    }
    stated.add(root);
    if (!space.graphs.has(root)) {
      c.error('root-mismatch', `roots lists graph "${root}", which does not exist in the space`, {
        graphId: String(root),
      });
    } else if (!derived.has(root)) {
      c.error(
        'root-mismatch',
        `roots lists graph "${root}", but it is contained by a node (roots are derived, never trusted — ADR-0001)`,
        { graphId: String(root) },
      );
    }
  }
  for (const root of derived) {
    if (!stated.has(root)) {
      c.error(
        'root-mismatch',
        `graph "${root}" is contained by no node but missing from roots`,
        { graphId: String(root) },
      );
    }
  }

  return { ok: c.errors.length === 0, errors: c.errors, warnings: c.warnings };
}
