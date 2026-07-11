/**
 * Error-tolerant parsing over the shim (ROADMAP Phase 7 §12 failure-case row:
 * "syntax-error files — error-tolerant parse still yields partial graph,
 * flagged"). Nothing graph-shaped lives here (that is 7C); this module turns a
 * tree-sitter parse into a serializable {@link ParseOutcome} whose error spans
 * can cross a worker boundary and later feed provenance-located diagnostics.
 */
import type { Node as SyntaxNode, Parser, Tree } from 'web-tree-sitter';
import type { CodeLanguage } from './languages.js';

/** Reported error spans are capped so a pathological file cannot flood the
 * worker boundary; the count fields stay exact. */
export const MAX_REPORTED_SYNTAX_ERRORS = 64;

export interface TextPosition {
  readonly row: number;
  readonly column: number;
}

/** One flagged region of a partial parse: an ERROR subtree or a MISSING node
 * inserted by tree-sitter's recovery. */
export interface SyntaxErrorSpan {
  readonly kind: 'error' | 'missing';
  readonly startIndex: number;
  readonly endIndex: number;
  readonly start: TextPosition;
  readonly end: TextPosition;
}

/** Serializable summary of one parse — everything 7B needs to prove the shim
 * works, and the flag surface 7C's mapping will attach to module nodes. */
export interface ParseOutcome {
  readonly language: CodeLanguage;
  readonly rootType: string;
  /** Total nodes in the (possibly partial) tree, root included. */
  readonly nodeCount: number;
  /** True ⇒ the tree is partial: recovery produced ERROR/MISSING nodes. */
  readonly hasErrors: boolean;
  readonly errorCount: number;
  /** Up to {@link MAX_REPORTED_SYNTAX_ERRORS} spans, source order. */
  readonly errors: readonly SyntaxErrorSpan[];
  /** True iff `errorCount > errors.length` (the cap bit). */
  readonly errorsTruncated: boolean;
}

/**
 * Parse `text` and summarize. The returned `tree` lives in the runtime's WASM
 * memory — the caller owns `tree.delete()` (and the parser's lifecycle).
 */
export function parseSource(
  parser: Parser,
  language: CodeLanguage,
  text: string,
): { tree: Tree; outcome: ParseOutcome } {
  const tree = parser.parse(text);
  if (tree === null) {
    // web-tree-sitter returns null only for a mis-lifecycled parser (no
    // language / cancelled); a syntax-error *file* never lands here.
    throw new Error(`adapter-code: parser for "${language}" returned no tree (parser misconfigured)`);
  }
  return { tree, outcome: summarizeTree(tree, language) };
}

/** Summarize an existing tree into the serializable {@link ParseOutcome}. */
export function summarizeTree(tree: Tree, language: CodeLanguage): ParseOutcome {
  const root = tree.rootNode;
  const errors: SyntaxErrorSpan[] = [];
  let errorCount = 0;

  if (root.hasError) {
    // Walk only into subtrees that contain errors; clean siblings are skipped
    // wholesale, so this stays near O(errors), not O(nodes).
    const stack: SyntaxNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.isError || node.isMissing) {
        errorCount++;
        if (errors.length < MAX_REPORTED_SYNTAX_ERRORS) {
          errors.push({
            kind: node.isMissing ? 'missing' : 'error',
            startIndex: node.startIndex,
            endIndex: node.endIndex,
            start: { row: node.startPosition.row, column: node.startPosition.column },
            end: { row: node.endPosition.row, column: node.endPosition.column },
          });
        }
        continue; // nested errors inside an ERROR subtree collapse into one span
      }
      // Push in reverse so spans come out in source order.
      for (let i = node.childCount - 1; i >= 0; i--) {
        const child = node.child(i);
        if (child !== null && child.hasError) stack.push(child);
      }
    }
  }

  return {
    language,
    rootType: root.type,
    nodeCount: root.descendantCount,
    hasErrors: root.hasError,
    errorCount,
    errors,
    errorsTruncated: errorCount > errors.length,
  };
}
