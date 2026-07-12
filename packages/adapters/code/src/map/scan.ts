/**
 * The transient body scan (7E, ADR-0027): walk a function/method body's
 * parse-subtree collecting call-sites, **without persisting any body node**.
 * The tree walk is language-agnostic; only "what is a call", "what is a nested
 * function scope", and "how is a callee written" are grammar-shaped, so each
 * language supplies a {@link CallGrammar}.
 *
 * Attribution is *innermost-enclosing*: the walk does **not** descend into a
 * nested function scope (arrow, lambda, nested `def`/`function`), so a call
 * inside a closure belongs to that closure — a lazy 7F node — not to the
 * enclosing eager decl. This keeps a function's counters stable when 7F later
 * materializes its nested functions as their own nodes.
 *
 * Pure over the tree-sitter tree; imports web-tree-sitter *types* only.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { RawCallSite } from './raw.js';

/** The per-language hooks the generic scan needs. */
export interface CallGrammar {
  /** True for a node that opens a new function scope (its calls are not ours). */
  isFunctionScope(node: SyntaxNode): boolean;
  /** True for a call-expression node. */
  isCall(node: SyntaxNode): boolean;
  /** Classify a call-expression into a {@link RawCallSite}. */
  classify(call: SyntaxNode): RawCallSite;
}

/**
 * Collect the call-sites lexically inside `body` (a `statement_block` / `block`
 * / expression), skipping any nested function scope. Deterministic: source
 * order (pre-order, left-to-right).
 */
export function collectCalls(body: SyntaxNode | null, grammar: CallGrammar): RawCallSite[] {
  if (body === null) return [];
  // A concise body that is *itself* a nested closure (`() => () => f()`) holds
  // no calls of its own — its calls belong to the inner closure.
  if (grammar.isFunctionScope(body)) return [];
  const out: RawCallSite[] = [];
  const visit = (node: SyntaxNode): void => {
    // Check the node itself: a concise body may *be* the call (`() => f()`).
    if (grammar.isCall(node)) out.push(grammar.classify(node));
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child === null) continue;
      // A nested function scope owns its own calls (innermost-enclosing).
      if (grammar.isFunctionScope(child)) continue;
      // Descend regardless — a call's arguments hold same-scope calls
      // (`f(g(), h())`), and non-call nodes may nest calls (`if (p()) …`).
      visit(child);
    }
  };
  visit(body);
  return out;
}
