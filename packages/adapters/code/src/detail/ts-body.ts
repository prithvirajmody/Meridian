/**
 * TypeScript body → normalized {@link CfgStmt} IR (7F). Turns a function/method
 * body's `statement_block` (or an arrow's concise expression body) into the
 * language-agnostic control-flow IR {@link buildCfg} consumes. Nested function
 * and class declarations are treated as **simple** statements — their bodies are
 * separate lazy resolves (ADR-0027), never part of this function's control flow.
 *
 * Pure over the tree-sitter tree; imports web-tree-sitter *types* only.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { CfgCase, CfgStmt } from './types.js';

/** A statement node, or the statements of a `statement_block`, as a flat list. */
function stmtList(node: SyntaxNode | null): SyntaxNode[] {
  if (node === null) return [];
  if (node.type === 'statement_block') {
    const out: SyntaxNode[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null) out.push(c);
    }
    return out;
  }
  return [node];
}

function normalizeList(nodes: readonly SyntaxNode[]): CfgStmt[] {
  const out: CfgStmt[] = [];
  for (const n of nodes) out.push(...normalizeStmt(n));
  return out;
}

/** The statements of a `statement_block`/single statement, normalized. */
function normalizeBody(node: SyntaxNode | null): CfgStmt[] {
  return normalizeList(stmtList(node));
}

function normalizeStmt(node: SyntaxNode): CfgStmt[] {
  switch (node.type) {
    case 'empty_statement':
    case 'comment':
      return [];
    case 'labeled_statement': {
      const inner = node.namedChild(node.namedChildCount - 1);
      return inner === null ? [] : normalizeStmt(inner);
    }
    case 'statement_block':
      return normalizeBody(node);
    case 'if_statement': {
      const cond = node.childForFieldName('condition') ?? node;
      const then = normalizeBody(node.childForFieldName('consequence'));
      const alt = node.childForFieldName('alternative');
      let otherwise: CfgStmt[] = [];
      if (alt !== null) {
        // `else_clause` wraps a statement (a block, or another `if` for else-if).
        const wrapped = alt.type === 'else_clause' ? alt.namedChild(0) : alt;
        otherwise = wrapped === null ? [] : normalizeStmt(wrapped);
      }
      return [{ t: 'if', node, cond, then, otherwise }];
    }
    case 'while_statement': {
      const cond = node.childForFieldName('condition') ?? node;
      return [{ t: 'loop', node, cond, pre: [], body: normalizeBody(node.childForFieldName('body')) }];
    }
    case 'for_statement': {
      const init = node.childForFieldName('initializer');
      const cond = node.childForFieldName('condition');
      const incr = node.childForFieldName('increment');
      const pre: CfgStmt[] = init !== null && init.type !== 'empty_statement' ? [{ t: 'simple', node: init }] : [];
      const body = normalizeBody(node.childForFieldName('body'));
      if (incr !== null) body.push({ t: 'simple', node: incr });
      return [{ t: 'loop', node, ...(cond !== null ? { cond } : {}), pre, body }];
    }
    case 'for_in_statement': {
      // `for … of/in` — an implicit has-next test, no explicit condition node.
      return [{ t: 'loop', node, pre: [], body: normalizeBody(node.childForFieldName('body')) }];
    }
    case 'do_statement': {
      const cond = node.childForFieldName('condition') ?? node;
      return [{ t: 'dowhile', node, cond, body: normalizeBody(node.childForFieldName('body')) }];
    }
    case 'switch_statement': {
      const disc = node.childForFieldName('value') ?? node;
      const body = node.childForFieldName('body');
      const cases: CfgCase[] = [];
      if (body !== null) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const c = body.namedChild(i);
          if (c === null) continue;
          if (c.type === 'switch_case') {
            const test = c.childForFieldName('value') ?? node;
            cases.push({ test, body: caseBody(c) });
          } else if (c.type === 'switch_default') {
            cases.push({ test: 'default', body: caseBody(c) });
          }
        }
      }
      return [{ t: 'switch', node, disc, cases, fallthrough: true }];
    }
    case 'return_statement':
      return [{ t: 'return', node }];
    case 'break_statement':
      return [{ t: 'break', node }];
    case 'continue_statement':
      return [{ t: 'continue', node }];
    case 'throw_statement':
      return [{ t: 'throw', node }];
    case 'try_statement': {
      const body = normalizeBody(node.childForFieldName('body'));
      const handler = node.childForFieldName('handler'); // catch_clause
      const finalizer = node.childForFieldName('finalizer'); // finally_clause
      const handlers: CfgStmt[][] = [];
      if (handler !== null) handlers.push(normalizeBody(handler.childForFieldName('body')));
      const fin = finalizer !== null ? normalizeBody(finalizer.childForFieldName('body')) : null;
      return [{ t: 'try', node, body, handlers, orelse: [], finalizer: fin }];
    }
    default:
      // Expression statements, declarations, nested functions: straight-line.
      return [{ t: 'simple', node }];
  }
}

/** A `switch_case`/`switch_default`'s statement children (skip the `value`). */
function caseBody(clause: SyntaxNode): CfgStmt[] {
  const value = clause.childForFieldName('value');
  const out: SyntaxNode[] = [];
  for (let i = 0; i < clause.namedChildCount; i++) {
    const c = clause.namedChild(i);
    if (c === null || (value !== null && c.id === value.id)) continue;
    out.push(c);
  }
  return normalizeList(out);
}

/** Normalize a TypeScript function/method body node (`statement_block` or a
 * concise arrow expression) into the control-flow IR. */
export function normalizeTsBody(body: SyntaxNode): CfgStmt[] {
  if (body.type === 'statement_block') return normalizeBody(body);
  // Concise arrow body: a single expression evaluated as the return value.
  return [{ t: 'simple', node: body }];
}
