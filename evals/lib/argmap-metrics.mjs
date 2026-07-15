/**
 * Argument-map scoring (Phase 9D — this settles ADR-0034 open question 2).
 *
 * **The objective measure** for "judged faithful against a human-made
 * reference map" (ROADMAP Phase 9 §11) is precision/recall/F1 of extracted
 * nodes and typed relations against `evals/fixtures/argmap-reference.json`:
 *
 * - **Node match**: an extracted node matches a reference node when both are
 *   anchored to the same paragraph and their labels overlap with token-level
 *   F1 ≥ 0.4 (case-folded, punctuation-stripped). Matching is greedy
 *   best-score-first, one-to-one. Node kind does NOT gate the match (a model
 *   calling a thesis a claim still found the right content); kind agreement
 *   over matched pairs is reported separately.
 * - **Relation match**: an extracted edge matches a reference edge when both
 *   endpoints matched (via the node matching) and the relation kind is equal.
 *
 * Floors gate the *live-recorded* replay run only (never mock output —
 * mirrors the human-ratings rule: quality is never fabricated).
 *
 * Structural validity — declared kinds only, non-empty labels, referential
 * integrity — is separate and gates every run including mock.
 */

const strip = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);

/** Token-level F1 of two labels in [0, 1] (bag-of-words overlap). */
export function tokenF1(a, b) {
  const ta = strip(a);
  const tb = strip(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const counts = new Map();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      overlap += 1;
      counts.set(t, c - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / tb.length;
  const recall = overlap / ta.length;
  return (2 * precision * recall) / (precision + recall);
}

const MAP_KINDS = new Set(['arg:thesis', 'arg:claim', 'arg:premise', 'arg:objection', 'arg:evidence']);
const REL_KINDS = new Set(['arg:supports', 'arg:rebuts', 'arg:assumes', 'arg:cites']);

/** Structural validity of one extraction result (gates every run). */
export function argmapStructure(nodes, edges) {
  const issues = [];
  const ids = new Set();
  for (const n of nodes) {
    if (!MAP_KINDS.has(n.kind)) issues.push(`node ${n.id}: undeclared kind ${n.kind}`);
    if (typeof n.label !== 'string' || n.label.trim().length === 0) issues.push(`node ${n.id}: empty label`);
    if (typeof n.paragraph !== 'number') issues.push(`node ${n.id}: no paragraph anchor`);
    ids.add(n.id);
  }
  for (const e of edges) {
    if (!REL_KINDS.has(e.kind)) issues.push(`edge ${e.src}→${e.dst}: undeclared kind ${e.kind}`);
    if (!ids.has(e.src) || !ids.has(e.dst)) issues.push(`edge ${e.src}→${e.dst}: dangling endpoint`);
  }
  return { ok: issues.length === 0, issues };
}

function f1(precision, recall) {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/**
 * Score an extracted map against the reference (shapes documented above).
 * `extracted`/`reference` both carry `nodes: [{id, kind, label, paragraph}]`
 * and `edges: [{src, dst, kind}]`.
 */
export function argmapScores(extracted, reference, { threshold = 0.4 } = {}) {
  // Greedy one-to-one node matching, best token-F1 first, same paragraph only.
  const candidates = [];
  for (const ex of extracted.nodes) {
    for (const ref of reference.nodes) {
      if (ex.paragraph !== ref.paragraph) continue;
      const score = tokenF1(ex.label, ref.label);
      if (score >= threshold) candidates.push({ ex: ex.id, ref: ref.id, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || (a.ex < b.ex ? -1 : 1) || (a.ref < b.ref ? -1 : 1));
  const exMatched = new Map();
  const refMatched = new Map();
  for (const c of candidates) {
    if (exMatched.has(c.ex) || refMatched.has(c.ref)) continue;
    exMatched.set(c.ex, c.ref);
    refMatched.set(c.ref, c.ex);
  }

  const nodePrecision = extracted.nodes.length === 0 ? 0 : exMatched.size / extracted.nodes.length;
  const nodeRecall = reference.nodes.length === 0 ? 0 : refMatched.size / reference.nodes.length;

  const kindByIdEx = new Map(extracted.nodes.map((n) => [n.id, n.kind]));
  const kindByIdRef = new Map(reference.nodes.map((n) => [n.id, n.kind]));
  let kindAgree = 0;
  for (const [ex, ref] of exMatched) if (kindByIdEx.get(ex) === kindByIdRef.get(ref)) kindAgree += 1;

  // Relations: endpoints mapped through the node matching, kind equal.
  const refEdgeKeys = new Set(reference.edges.map((e) => `${e.src}→${e.dst}:${e.kind}`));
  let edgeHits = 0;
  for (const e of extracted.edges) {
    const src = exMatched.get(e.src);
    const dst = exMatched.get(e.dst);
    if (src !== undefined && dst !== undefined && refEdgeKeys.has(`${src}→${dst}:${e.kind}`)) edgeHits += 1;
  }
  const edgePrecision = extracted.edges.length === 0 ? 0 : edgeHits / extracted.edges.length;
  const edgeRecall = reference.edges.length === 0 ? 0 : edgeHits / reference.edges.length;

  return {
    nodePrecision,
    nodeRecall,
    nodeF1: f1(nodePrecision, nodeRecall),
    kindAgreement: exMatched.size === 0 ? 0 : kindAgree / exMatched.size,
    edgePrecision,
    edgeRecall,
    edgeF1: f1(edgePrecision, edgeRecall),
    matchedNodes: exMatched.size,
  };
}
