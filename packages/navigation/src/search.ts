/**
 * Search over the P1 label-token index with fly-to targeting (ADR-0025:
 * "fly-to = camera flight within context; sets `focus`; never drills").
 *
 * The **index** is a port, not an import: navigation may depend only on
 * `abstraction` + `view-model` (§20), so it cannot reach the store's
 * `nodesByToken` index (graph-store) directly. Studio injects a
 * {@link LabelTokenIndex} backed by that P1 index; tests and headless callers
 * build one from a `GraphSpace` with {@link buildLabelTokenIndex}. The
 * **search algorithm** (query tokenization, AND-intersection, deterministic
 * ranking) lives here.
 *
 * *(Flagged for ADR-0025 fold-back: the ADR says "search over the P1
 * label-token index" but the dependency law forbids importing it; the
 * port/adapter split is the defensible reading. The tokenizer below mirrors
 * graph-store's `tokenizeLabel` contract — NFC, lowercase, split on
 * non-alphanumeric — and must stay in lockstep with it.)*
 */
import type { GraphSpace, NodeId } from '@meridian/view-model';

/** The injected label-token index (P1 `nodesByToken`): token → the node ids
 * whose label contains that token. */
export interface LabelTokenIndex {
  readonly nodesByToken: ReadonlyMap<string, ReadonlySet<NodeId>>;
}

/** One search hit: a matching node and how many query tokens it matched
 * (its rank key). */
export interface SearchHit {
  readonly node: NodeId;
  readonly score: number;
}

/**
 * Tokenize a label/query the P1 way (mirrors graph-store `tokenizeLabel`): NFC,
 * lowercase, split on any non-letter/non-number, drop empties. Pure.
 */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rank nodes matching `query` against `index` (ADR-0025 search). Every query
 * token must match a label token (AND-intersection — same semantics as the P1
 * `query().text()`); results are ranked by matched-token count descending, then
 * `NodeId` ascending (deterministic, I6). An `allowed` predicate scopes results
 * to the current working context (fly-to stays "within context"). An empty
 * query (no tokens) returns nothing.
 */
export function searchLabels(
  index: LabelTokenIndex,
  query: string,
  allowed?: (id: NodeId) => boolean,
): SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  // Seed with the smallest posting list, then AND-intersect the rest.
  const postings = tokens.map((t) => index.nodesByToken.get(t) ?? new Set<NodeId>());
  const ordered = [...postings].sort((a, b) => a.size - b.size);
  const [smallest, ...rest] = ordered;
  if (smallest === undefined || smallest.size === 0) return [];

  const hits: SearchHit[] = [];
  for (const id of smallest) {
    if (!rest.every((s) => s.has(id))) continue;
    if (allowed !== undefined && !allowed(id)) continue;
    hits.push({ node: id, score: tokens.length });
  }
  hits.sort((a, b) => b.score - a.score || compareIds(a.node, b.node));
  return hits;
}

/**
 * Build a {@link LabelTokenIndex} from a `GraphSpace` by tokenizing every
 * node's label (the headless equivalent of the P1 store index). Pure and
 * deterministic. Studio prefers injecting the live store index; tests use this.
 */
export function buildLabelTokenIndex(space: GraphSpace): LabelTokenIndex {
  const nodesByToken = new Map<string, Set<NodeId>>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) {
      for (const token of new Set(tokenize(node.label))) {
        let set = nodesByToken.get(token);
        if (set === undefined) nodesByToken.set(token, (set = new Set()));
        set.add(node.id);
      }
    }
  }
  return { nodesByToken };
}
