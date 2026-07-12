/**
 * The AST-subgraph builder (7F, ADR-0027 lazy `code:stmt`/`code:expr` levels).
 * Maps a straight-line statement's tree-sitter subtree into a {@link RawAst}
 * tree of named nodes — statements and expressions — that becomes the block's
 * detail graph. Pure over the tree-sitter tree; deterministic (named-child
 * order); imports web-tree-sitter *types* only.
 *
 * The split is structural, not type-aware (ADR-0026): a node is a `code:stmt`
 * if its grammar type reads as a statement/clause/definition, else `code:expr`.
 * Only *named* children are kept (anonymous punctuation/keyword tokens carry no
 * graph meaning), so the subgraph is the abstract syntax tree, not the concrete
 * one. Keys are structural named-child ordinals → stable under whitespace
 * (ADR-0028 case-1 spirit: positional, never textual).
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { RawAst } from './types.js';

function isStatementType(type: string): boolean {
  return (
    type.endsWith('statement') ||
    type.endsWith('_clause') ||
    type.endsWith('_definition') ||
    type.endsWith('_declaration') ||
    type === 'block' ||
    type === 'statement_block' ||
    type === 'else_clause'
  );
}

/** A short, whitespace-collapsed label for an AST node (its first line, capped).
 * Descriptive only — never an id input (ids are the structural `key`). */
function astLabel(node: SyntaxNode): string {
  const firstLine = node.text.split('\n', 1)[0] ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > 48 ? `${collapsed.slice(0, 47)}…` : collapsed;
}

/**
 * Build the {@link RawAst} subtree rooted at `node`, keyed `key` relative to its
 * parent. Named children recurse, keyed by their named-child ordinal so the
 * path is deterministic and reorder-free.
 */
export function buildAst(node: SyntaxNode, key: string): RawAst {
  const kind: RawAst['kind'] = isStatementType(node.type) ? 'stmt' : 'expr';
  const children: RawAst[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child === null) continue;
    const childKind = isStatementType(child.type) ? 'stmt' : 'expr';
    children.push(buildAst(child, `${childKind}-${i}`));
  }
  return {
    key,
    kind,
    type: node.type,
    label: `${node.type}: ${astLabel(node)}`,
    span: [node.startIndex, node.endIndex],
    children,
  };
}
