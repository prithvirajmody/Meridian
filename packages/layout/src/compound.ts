/**
 * Pure resolution of {@link CompoundNesting} into canonical group **ordinals**
 * (ADR-0015 compound support; subphase 4D). Shared by the `elk-layered`
 * provider (which builds the ELK compound tree) and the worker wire protocol
 * (which encodes/decodes the grouping), so both derive the *same* structure.
 *
 * The ordinal assignment is **invariant to the group *key strings*** — it
 * orders groups by `(minMemberIndex, depth)`. That is a total order: two groups
 * share a `minMemberIndex` only when one contains the other (they share that
 * member), and then their `depth`s differ (parent before child). This is why a
 * main-thread run (real graph-id keys) and a worker run (placeholder `g0/g1/…`
 * keys) produce byte-identical ELK trees: the labels differ, the canonical
 * ordinals do not. Pure and deterministic (I6); no DOM, no domain, no AI.
 */
import type { NodeId } from '@meridian/graph-core';
import type { CompoundNesting } from './types.js';

/** Per-member leaf group ordinal (or −1 = root-level) and per-group parent
 * ordinal (or −1 = root-level). Groups are numbered `0..groupParent.length−1`
 * in canonical order. */
export interface ResolvedGroups {
  readonly memberGroup: number[];
  readonly groupParent: number[];
}

/**
 * Resolve a member list + optional {@link CompoundNesting} into
 * {@link ResolvedGroups}. Idempotent under re-labeling: resolving a nesting
 * whose keys were themselves derived from a prior resolution yields the same
 * ordinals — the property the worker protocol relies on.
 */
export function resolveGroups(
  members: readonly NodeId[],
  compound: CompoundNesting | undefined,
): ResolvedGroups {
  const N = members.length;
  const memberGroup = new Array<number>(N).fill(-1);
  if (compound === undefined || compound.groupOf.size === 0) {
    return { memberGroup, groupParent: [] };
  }

  const parentKey = compound.parentOf;
  const minMemberOf = new Map<string, number>();
  const depthOf = new Map<string, number>();

  const depth = (key: string): number => {
    // Length of the parent chain to root (cycle-guarded).
    let d = 0;
    let k: string | undefined = key;
    const seen = new Set<string>();
    while (k !== undefined && parentKey.has(k) && !seen.has(k)) {
      seen.add(k);
      k = parentKey.get(k);
      d++;
    }
    return d;
  };

  const noteChain = (startKey: string, memberIndex: number): void => {
    let key: string | undefined = startKey;
    const seen = new Set<string>();
    while (key !== undefined && !seen.has(key)) {
      seen.add(key);
      const prev = minMemberOf.get(key);
      if (prev === undefined || memberIndex < prev) minMemberOf.set(key, memberIndex);
      if (!depthOf.has(key)) depthOf.set(key, depth(key));
      key = parentKey.get(key);
    }
  };

  const memberStartKey = new Array<string | undefined>(N);
  for (let i = 0; i < N; i++) {
    const key = compound.groupOf.get(members[i]!);
    memberStartKey[i] = key;
    if (key !== undefined) noteChain(key, i);
  }

  const keys = [...minMemberOf.keys()].sort((a, b) => {
    const ma = minMemberOf.get(a)!;
    const mb = minMemberOf.get(b)!;
    if (ma !== mb) return ma - mb;
    const da = depthOf.get(a)!;
    const db = depthOf.get(b)!;
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0; // unreachable tiebreak, kept total
  });
  const ordinalOf = new Map<string, number>();
  keys.forEach((k, ord) => ordinalOf.set(k, ord));

  const groupParent = keys.map((k) => {
    const pk = parentKey.get(k);
    return pk !== undefined && ordinalOf.has(pk) ? ordinalOf.get(pk)! : -1;
  });
  for (let i = 0; i < N; i++) {
    const key = memberStartKey[i];
    memberGroup[i] = key !== undefined ? (ordinalOf.get(key) ?? -1) : -1;
  }
  return { memberGroup, groupParent };
}

/**
 * The inverse used by the worker: rebuild a {@link CompoundNesting} from
 * resolved ordinal arrays, keyed by placeholder group ids `g0/g1/…`. Running
 * {@link resolveGroups} on the result reproduces the same ordinals (idempotent),
 * so the worker-side ELK tree matches the main thread's byte-for-byte.
 */
export function groupsFromOrdinals(
  members: readonly NodeId[],
  memberGroup: readonly number[],
  groupParent: readonly number[],
): CompoundNesting | undefined {
  if (groupParent.length === 0) return undefined;
  const groupOf = new Map<NodeId, string>();
  for (let i = 0; i < members.length; i++) {
    const g = memberGroup[i]!;
    if (g >= 0) groupOf.set(members[i]!, `g${g}`);
  }
  const parentOf = new Map<string, string>();
  for (let g = 0; g < groupParent.length; g++) {
    const p = groupParent[g]!;
    if (p >= 0) parentOf.set(`g${g}`, `g${p}`);
  }
  return { groupOf, parentOf };
}
