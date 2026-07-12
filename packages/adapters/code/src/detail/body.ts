/**
 * Worker-side body materialization (7F, ADR-0027). Given a parsed file and a
 * cold function/method's declaration span, locate the declaration, extract its
 * body, and build the {@link RawBody} — the CFG (`code:block` + `code:flows-to`)
 * with each block's AST detail (`code:stmt`/`code:expr`). This is the analogue
 * of {@link ../map/map-module.js mapModuleTree}: it runs where the tree lives
 * (the worker in production wiring, ADR-0017), and only the structured-clone-
 * safe {@link RawBody} crosses the boundary — never the parse tree.
 *
 * Pure over the tree-sitter tree; imports web-tree-sitter *types* only.
 */
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { CodeLanguage } from '../languages.js';
import { buildAst } from './ast.js';
import { buildCfg } from './cfg.js';
import { normalizePyBody } from './py-body.js';
import { normalizeTsBody } from './ts-body.js';
import type { CfgStmt, RawBlock, RawBody } from './types.js';

/** All nodes whose byte span is exactly `[start, end]`, in pre-order (parent
 * before child) — the eager provenance span may equal both a wrapper and its
 * declaration (e.g. Python `expression_statement` ⊇ `assignment`). */
function spanMatches(root: SyntaxNode, span: readonly [number, number]): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (n: SyntaxNode): void => {
    if (n.startIndex > span[0] || n.endIndex < span[1]) return; // span not inside n
    if (n.startIndex === span[0] && n.endIndex === span[1]) out.push(n);
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c !== null) visit(c);
    }
  };
  visit(root);
  return out;
}

/** The body node of a TypeScript declaration, unwrapping binding/field forms. */
function tsBodyOf(node: SyntaxNode): SyntaxNode | null {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_expression':
    case 'generator_function':
    case 'arrow_function':
    case 'method_definition':
      return node.childForFieldName('body');
    case 'variable_declarator':
    case 'public_field_definition': {
      const value = node.childForFieldName('value');
      return value !== null ? tsBodyOf(value) : null;
    }
    default:
      return null;
  }
}

/** The body node of a Python declaration, unwrapping a `name = lambda` binding. */
function pyBodyOf(node: SyntaxNode): SyntaxNode | null {
  switch (node.type) {
    case 'function_definition':
      return node.childForFieldName('body');
    case 'lambda':
      return node.childForFieldName('body');
    case 'assignment': {
      const right = node.childForFieldName('right');
      return right !== null && right.type === 'lambda' ? pyBodyOf(right) : null;
    }
    default:
      return null;
  }
}

/** Locate the declaration at `span` and return its body node, or null. */
function bodyNodeAt(root: SyntaxNode, span: readonly [number, number], language: CodeLanguage): SyntaxNode | null {
  const bodyOf = language === 'python' ? pyBodyOf : tsBodyOf;
  for (const candidate of spanMatches(root, span)) {
    const body = bodyOf(candidate);
    if (body !== null) return body;
  }
  return null;
}

function normalize(body: SyntaxNode, language: CodeLanguage): CfgStmt[] {
  return language === 'python' ? normalizePyBody(body) : normalizeTsBody(body);
}

/**
 * Build the {@link RawBody} for the function/method whose declaration span is
 * `declSpan`. Returns `undefined` when no resolvable body is found (an abstract
 * signature, an overload stub, or a stale span) — the caller reports honestly.
 */
export function buildBody(tree: Tree, language: CodeLanguage, declSpan: readonly [number, number]): RawBody | undefined {
  const body = bodyNodeAt(tree.rootNode, declSpan, language);
  if (body === null) return undefined;
  const stmts = normalize(body, language);
  const cfg = buildCfg(stmts, [body.startIndex, body.endIndex]);
  const blocks: RawBlock[] = cfg.blocks.map((b) => ({
    key: b.key,
    role: b.role,
    label: b.label,
    span: [b.span[0], b.span[1]],
    stmts: b.stmtNodes.map((n, i) => buildAst(n, `stmt-${i}`)),
  }));
  return { blocks, flows: cfg.edges.map((e) => ({ from: e.from, to: e.to, label: e.label })) };
}
