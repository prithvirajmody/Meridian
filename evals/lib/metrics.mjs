/**
 * Objective eval metrics (Phase 8F). These are *machine-computable* quality
 * signals — no human judgement is fabricated here (ADR-0031: human ratings are
 * a separate, human-authored input). Two families:
 *
 *   1. Clustering agreement vs. a known latent labelling — purity and the
 *      Adjusted Rand Index (ARI). The 500-node soup fixture has a ground-truth
 *      topic per node, so we can score the clusterer's grouping objectively.
 *   2. Summary structural validity — the schema-level checks that a name/summary
 *      is well-formed and grounded in its members. Whether a summary is *good*
 *      is a human call (see RUBRIC.md); this only catches structural regressions.
 */

/** Cluster purity in [0,1]: mean over clusters of (majority-label share). */
export function purity(clusters, truthById) {
  let total = 0;
  let correct = 0;
  for (const cluster of clusters) {
    const counts = new Map();
    for (const id of cluster.members) {
      const label = truthById.get(id);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    let majority = 0;
    for (const c of counts.values()) majority = Math.max(majority, c);
    correct += majority;
    total += cluster.members.length;
  }
  return total === 0 ? 0 : correct / total;
}

/**
 * Adjusted Rand Index in [-1,1] (1 = identical partitions, ~0 = chance).
 * Compares the clusterer's partition against the ground-truth partition over
 * the same node set. Robust to differing cluster counts and label names.
 */
export function adjustedRandIndex(clusters, truthById) {
  const clusterOf = new Map();
  clusters.forEach((cluster, index) => {
    for (const id of cluster.members) clusterOf.set(id, index);
  });
  const ids = [...clusterOf.keys()].filter((id) => truthById.has(id));

  // Contingency table n_ij between predicted cluster i and truth class j.
  const table = new Map();
  const aRow = new Map();
  const bCol = new Map();
  for (const id of ids) {
    const i = clusterOf.get(id);
    const j = truthById.get(id);
    const key = `${i}\0${j}`;
    table.set(key, (table.get(key) ?? 0) + 1);
    aRow.set(i, (aRow.get(i) ?? 0) + 1);
    bCol.set(j, (bCol.get(j) ?? 0) + 1);
  }
  const choose2 = (x) => (x * (x - 1)) / 2;
  let sumIJ = 0;
  for (const n of table.values()) sumIJ += choose2(n);
  let sumA = 0;
  for (const n of aRow.values()) sumA += choose2(n);
  let sumB = 0;
  for (const n of bCol.values()) sumB += choose2(n);
  const total = choose2(ids.length);
  const expected = total === 0 ? 0 : (sumA * sumB) / total;
  const max = (sumA + sumB) / 2;
  if (max - expected === 0) return 1; // both partitions trivial ⇒ perfect agreement
  return (sumIJ - expected) / (max - expected);
}

const FILLER = [/\bvarious\b/i, /\bmiscellaneous\b/i, /\bstuff\b/i, /\bthings\b/i, /\betc\.?\b/i];

/**
 * Structural validity of one rollup summary. Returns { ok, issues[] }. Mirrors
 * the shape rollupSummarySchema already guarantees, plus grounding heuristics
 * (non-filler, name is short, summary is a real sentence). A structural failure
 * is a regression the harness gates on; it is *not* a quality rating.
 */
export function summaryStructure(summary) {
  const issues = [];
  const name = summary.name ?? '';
  const text = summary.summary ?? '';
  if (name.trim().length === 0) issues.push('empty-name');
  if (name.length > 80) issues.push('name-too-long');
  if (/[.!?]$/.test(name.trim())) issues.push('name-trailing-punctuation');
  if (text.trim().length === 0) issues.push('empty-summary');
  if (text.length > 400) issues.push('summary-too-long');
  if (text.trim().split(/\s+/).length < 3) issues.push('summary-too-short');
  if (typeof summary.confidence !== 'number' || summary.confidence < 0 || summary.confidence > 1) {
    issues.push('confidence-out-of-range');
  }
  for (const rx of FILLER) {
    if (rx.test(name)) issues.push('name-filler');
    if (rx.test(text)) issues.push('summary-filler');
  }
  return { ok: issues.length === 0, issues };
}

/** Median of a numeric array (empty ⇒ 0). */
export function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Mean of a numeric array (empty ⇒ 0). */
export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
