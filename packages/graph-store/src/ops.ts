/**
 * The op vocabulary v1 and delta envelope (ADR-0005). Committed ops carry
 * `prev` payloads, which is what makes every committed delta invertible
 * (U6, I4). Input ops may omit them; `apply` completes each op and returns
 * the invertible form. Where an input op does state `prev`, it is an
 * assertion checked against actual state (`op-conflict` on mismatch).
 */
import type {
  AttrValue,
  EdgeId,
  GraphId,
  GraphMeta,
  GraphRef,
  NodeId,
  SemanticEdge,
  SemanticNode,
} from '@meridian/graph-core';
import { MeridianError } from '@meridian/graph-core';
import { successorVersion, type VersionStamp } from './version.js';

/** Who issued a delta (§3.1 History). Extended additively in later phases. */
export interface OpOrigin {
  readonly actor: string;
  /**
   * Volatile commits are cache movements — hydration and eviction
   * (ADR-0039) — not history: the version advances and subscriptions fire,
   * but the commit is never forwarded to the storage backend and never
   * enters the durable op log (ADR-0038). The flag does not cross the wire
   * (`deltaToWire` drops it). Absent = durable.
   */
  readonly volatile?: boolean;
}

// ------------------------------------------------------------ canonical ops

export type GraphOp =
  | { readonly t: 'graph:add'; readonly graph: GraphId; readonly meta: GraphMeta }
  | { readonly t: 'graph:remove'; readonly graph: GraphId; readonly prev: GraphMeta }
  | {
      readonly t: 'graph:meta';
      readonly graph: GraphId;
      readonly prev: GraphMeta;
      readonly next: GraphMeta;
    }
  | { readonly t: 'node:add'; readonly graph: GraphId; readonly node: SemanticNode }
  | {
      readonly t: 'node:remove';
      readonly graph: GraphId;
      readonly id: NodeId;
      readonly prev: SemanticNode;
    }
  | {
      readonly t: 'node:attr';
      readonly graph: GraphId;
      readonly id: NodeId;
      readonly key: string;
      /** Absent = the key was absent before the op. */
      readonly prev?: AttrValue;
      /** Absent = the op removes the key. */
      readonly next?: AttrValue;
    }
  | {
      readonly t: 'node:detail';
      readonly graph: GraphId;
      readonly id: NodeId;
      /** Absent = the node had no detail before the op. */
      readonly prev?: GraphRef;
      /** Absent = the op clears the detail. */
      readonly next?: GraphRef;
    }
  | { readonly t: 'edge:add'; readonly graph: GraphId; readonly edge: SemanticEdge }
  | {
      readonly t: 'edge:remove';
      readonly graph: GraphId;
      readonly id: EdgeId;
      readonly prev: SemanticEdge;
    };

// ---------------------------------------------------------------- input ops

/**
 * Submittable form: canonical ops are valid inputs (their `prev`s become
 * assertions); thin ops omit what the store already knows. For `node:attr`
 * and `node:detail`, an absent input `prev` means "no assertion" — asserting
 * "was absent" is not expressible (ADR-0005, noted soft spot).
 */
export type GraphOpInput =
  | { readonly t: 'graph:add'; readonly graph: GraphId; readonly meta: GraphMeta }
  | { readonly t: 'graph:remove'; readonly graph: GraphId; readonly prev?: GraphMeta }
  | {
      readonly t: 'graph:meta';
      readonly graph: GraphId;
      readonly prev?: GraphMeta;
      readonly next: GraphMeta;
    }
  | { readonly t: 'node:add'; readonly graph: GraphId; readonly node: SemanticNode }
  | {
      readonly t: 'node:remove';
      readonly graph: GraphId;
      readonly id: NodeId;
      readonly prev?: SemanticNode;
    }
  | {
      readonly t: 'node:attr';
      readonly graph: GraphId;
      readonly id: NodeId;
      readonly key: string;
      readonly prev?: AttrValue;
      readonly next?: AttrValue;
    }
  | {
      readonly t: 'node:detail';
      readonly graph: GraphId;
      readonly id: NodeId;
      readonly prev?: GraphRef;
      readonly next?: GraphRef;
    }
  | { readonly t: 'edge:add'; readonly graph: GraphId; readonly edge: SemanticEdge }
  | {
      readonly t: 'edge:remove';
      readonly graph: GraphId;
      readonly id: EdgeId;
      readonly prev?: SemanticEdge;
    };

// ------------------------------------------------------------------- deltas

/** Completed, invertible delta — what commits, logs, and replays. */
export interface GraphDelta {
  readonly baseVersion: VersionStamp;
  readonly origin: OpOrigin;
  readonly ops: readonly GraphOp[];
}

/**
 * The file-portable completed form: ops are invertible, but the stamp is
 * optional — version stamps identify states within one store session
 * (ADR-0007), so a delta crossing sessions (files, exports) relies on
 * op-level `prev` assertions instead.
 */
export interface PortableDelta {
  readonly baseVersion?: VersionStamp;
  readonly origin: OpOrigin;
  readonly ops: readonly GraphOp[];
}

/**
 * Submittable delta. `baseVersion` is optional; when present it must equal
 * the store's current version exactly (`stale-delta` otherwise).
 */
export interface GraphDeltaInput {
  readonly baseVersion?: VersionStamp;
  readonly origin: OpOrigin;
  readonly ops: readonly GraphOpInput[];
}

// -------------------------------------------------------------- invert

/** Inverse of one committed op (U6). Pure. */
export function invertOp(op: GraphOp): GraphOp {
  switch (op.t) {
    case 'graph:add':
      return { t: 'graph:remove', graph: op.graph, prev: op.meta };
    case 'graph:remove':
      return { t: 'graph:add', graph: op.graph, meta: op.prev };
    case 'graph:meta':
      return { t: 'graph:meta', graph: op.graph, prev: op.next, next: op.prev };
    case 'node:add':
      return { t: 'node:remove', graph: op.graph, id: op.node.id, prev: op.node };
    case 'node:remove':
      return { t: 'node:add', graph: op.graph, node: op.prev };
    case 'node:attr':
      return {
        t: 'node:attr',
        graph: op.graph,
        id: op.id,
        key: op.key,
        ...(op.next !== undefined ? { prev: op.next } : {}),
        ...(op.prev !== undefined ? { next: op.prev } : {}),
      };
    case 'node:detail':
      return {
        t: 'node:detail',
        graph: op.graph,
        id: op.id,
        ...(op.next !== undefined ? { prev: op.next } : {}),
        ...(op.prev !== undefined ? { next: op.prev } : {}),
      };
    case 'edge:add':
      return { t: 'edge:remove', graph: op.graph, id: op.edge.id, prev: op.edge };
    case 'edge:remove':
      return { t: 'edge:add', graph: op.graph, edge: op.prev };
  }
}

/**
 * Inverse of a completed delta: reversed, op-wise inverted, based on the
 * version the original produced (successor of its base — ADR-0007; a
 * portable delta without a stamp inverts to one without a stamp). This is
 * the undo mechanism and, later, the collaboration substrate.
 */
export function invertDelta(delta: GraphDelta, origin?: OpOrigin): GraphDelta;
export function invertDelta(delta: PortableDelta, origin?: OpOrigin): PortableDelta;
export function invertDelta(delta: PortableDelta, origin?: OpOrigin): PortableDelta {
  return {
    ...(delta.baseVersion ? { baseVersion: successorVersion(delta.baseVersion) } : {}),
    origin: origin ?? delta.origin,
    ops: [...delta.ops].reverse().map(invertOp),
  };
}

// ------------------------------------------------------------------ compose

/**
 * Concatenate consecutive deltas into one (dumb composition — no op fusion).
 * Each delta's base must be the successor of the previous one's; the result
 * applies as a single transaction, so version *trajectories* differ from
 * sequential application (ADR-0007) — equality claims are about spaces.
 */
export function composeDeltas(
  first: GraphDelta,
  ...rest: readonly GraphDelta[]
): GraphDelta {
  const ops: GraphOp[] = [...first.ops];
  let expected = successorVersion(first.baseVersion);
  let origin = first.origin;
  for (const d of rest) {
    if (d.baseVersion.counter !== expected.counter || d.baseVersion.site !== expected.site) {
      throw new MeridianError(
        'non-consecutive-deltas',
        `composeDeltas: expected baseVersion ${expected.counter}@${expected.site}, got ${d.baseVersion.counter}@${d.baseVersion.site} — deltas must be consecutive`,
      );
    }
    ops.push(...d.ops);
    expected = successorVersion(d.baseVersion);
    if (d.origin.actor !== origin.actor) origin = { actor: 'compose' };
  }
  return { baseVersion: first.baseVersion, origin, ops };
}
