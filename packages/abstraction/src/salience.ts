/**
 * Salience v1 (ADR-0014): a per-resolve, scale-free ranking of nodes used by
 * budget degradation to decide which region to roll up first. Three structural
 * signals — **size** (subtree leaf count), **degree** (induced-edge degree at
 * the cut, which for this model equals a node's incident-edge count; see
 * `forest-index.ts`), and **recency** (`core:updated-at`, rolled up as the
 * subtree max) — are each min-max normalized *within the candidate set for
 * this resolve*, then combined with weights `0.5 / 0.3 / 0.2`. A signal with no
 * data across the whole candidate set (e.g. no recency attributes) is dropped
 * and the remaining weights renormalized to sum to 1.
 *
 * The reserved `core:salience` attribute, when present and numeric, **replaces**
 * the computed structural value for that node (explicit emphasis wins, §8.1) —
 * AI/user intent arriving as an ordinary tagged attribute, no new write path.
 *
 * Pure and deterministic (I6): identical inputs → identical map.
 */
import type { NodeId } from '@meridian/graph-core';
import { SALIENCE_ATTR, type ForestIndex } from './forest-index.js';

/** v1 default salience weights (ADR-0014); frozen as mechanism, re-tuned in P6. */
export interface SalienceWeights {
  readonly size: number;
  readonly degree: number;
  readonly recency: number;
}

export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = { size: 0.5, degree: 0.3, recency: 0.2 };

function normalizer(min: number, max: number): (x: number) => number {
  const span = max - min;
  if (span <= 0) return () => 0; // no discrimination ⇒ contributes nothing
  return (x) => (x - min) / span;
}

/**
 * Compute salience for every node in `candidates` (ADR-0014). Structural
 * signals are normalized across exactly this candidate set; `core:salience`
 * overrides per node. Returns `node → salience ≥ 0`.
 */
export function computeSalience(
  index: ForestIndex,
  candidates: Iterable<NodeId>,
  weights: SalienceWeights = DEFAULT_SALIENCE_WEIGHTS,
): Map<NodeId, number> {
  const ids = [...candidates];

  // --- Gather raw signals and their ranges over the candidate set. -----------
  let sizeMin = Infinity;
  let sizeMax = -Infinity;
  let degMin = Infinity;
  let degMax = -Infinity;
  let recMin = Infinity;
  let recMax = -Infinity;
  let anyRecency = false;
  let anyDegree = false;

  for (const id of ids) {
    const size = index.subtreeLeaves.get(id) ?? 1;
    sizeMin = Math.min(sizeMin, size);
    sizeMax = Math.max(sizeMax, size);

    const deg = index.incidentDegree.get(id) ?? 0;
    if (deg > 0) anyDegree = true;
    degMin = Math.min(degMin, deg);
    degMax = Math.max(degMax, deg);

    const rec = index.recencyMax.get(id);
    if (rec !== undefined) {
      anyRecency = true;
      recMin = Math.min(recMin, rec);
      recMax = Math.max(recMax, rec);
    }
  }

  // A signal is "present" only if it carries discriminating data over the set.
  const sizeOn = ids.length > 0;
  const degreeOn = anyDegree; // no edges ⇒ dropped (ADR-0014 renormalization)
  const recencyOn = anyRecency; // no core:updated-at anywhere ⇒ dropped

  // Missing recency for a node with data present elsewhere ⇒ treat as least
  // recent (the set minimum), so it normalizes to 0.
  if (recencyOn && recMin === Infinity) recMin = 0;

  const normSize = normalizer(sizeMin, sizeMax);
  const normDeg = normalizer(degMin, degMax);
  const normRec = normalizer(recMin, recMax);

  // --- Renormalize the active weights to sum to 1. ---------------------------
  let wSum = 0;
  if (sizeOn) wSum += weights.size;
  if (degreeOn) wSum += weights.degree;
  if (recencyOn) wSum += weights.recency;
  const wSize = sizeOn && wSum > 0 ? weights.size / wSum : 0;
  const wDeg = degreeOn && wSum > 0 ? weights.degree / wSum : 0;
  const wRec = recencyOn && wSum > 0 ? weights.recency / wSum : 0;

  // --- Combine (or take the explicit prior). ---------------------------------
  const out = new Map<NodeId, number>();
  for (const id of ids) {
    const explicit = index.nodeOf.get(id)?.attrs[SALIENCE_ATTR];
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
      out.set(id, explicit); // core:salience replaces the computed value
      continue;
    }
    const size = index.subtreeLeaves.get(id) ?? 1;
    const deg = index.incidentDegree.get(id) ?? 0;
    const rec = index.recencyMax.get(id) ?? recMin;
    const s =
      wSize * normSize(size) +
      wDeg * normDeg(deg) +
      (recencyOn ? wRec * normRec(rec) : 0);
    out.set(id, s);
  }
  return out;
}
