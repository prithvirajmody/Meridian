/**
 * Python body → normalized {@link CfgStmt} IR (7F). Turns a
 * `function_definition` body (`block`) into the language-agnostic control-flow
 * IR {@link buildCfg} consumes. Nested `def`/`class` are **simple** statements —
 * their bodies are separate lazy resolves (ADR-0027). `with` bodies inline
 * (their control flow is straight-line for our purposes). Pure over the
 * tree-sitter tree; imports web-tree-sitter *types* only.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { CfgCase, CfgStmt } from './types.js';

function blockStmts(node: SyntaxNode | null): SyntaxNode[] {
  if (node === null) return [];
  if (node.type === 'block') {
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

function normalizeBlock(node: SyntaxNode | null): CfgStmt[] {
  return normalizeList(blockStmts(node));
}

/** Fold a Python `if` chain's `elif`/`else` clauses into nested `otherwise`. */
function ifChain(node: SyntaxNode): CfgStmt {
  const cond = node.childForFieldName('condition') ?? node;
  const then = normalizeBlock(node.childForFieldName('consequence'));
  const elifs: SyntaxNode[] = [];
  let elseClause: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c === null) continue;
    if (c.type === 'elif_clause') elifs.push(c);
    else if (c.type === 'else_clause') elseClause = c;
  }
  let otherwise: CfgStmt[] = elseClause !== null ? normalizeBlock(elseClause.childForFieldName('body')) : [];
  for (let i = elifs.length - 1; i >= 0; i--) {
    const e = elifs[i]!;
    otherwise = [
      {
        t: 'if',
        node: e,
        cond: e.childForFieldName('condition') ?? e,
        then: normalizeBlock(e.childForFieldName('consequence')),
        otherwise,
      },
    ];
  }
  return { t: 'if', node, cond, then, otherwise };
}

/** The subject-guarded arms of a `match_statement`. */
function matchCases(node: SyntaxNode): CfgCase[] {
  const cases: CfgCase[] = [];
  const consider = (clause: SyntaxNode): void => {
    if (clause.type !== 'case_clause') return;
    const body = clause.childForFieldName('consequence');
    // The test is the first non-block, non-guard child (a pattern). `case _`
    // (a lone wildcard) is the default arm.
    let test: SyntaxNode | 'default' = 'default';
    for (let i = 0; i < clause.namedChildCount; i++) {
      const c = clause.namedChild(i);
      if (c === null || c.type === 'block' || c.type === 'guard') continue;
      test = c.text.trim() === '_' ? 'default' : c;
      break;
    }
    cases.push({ test, body: normalizeBlock(body) });
  };
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c === null) continue;
    if (c.type === 'case_clause') consider(c);
    else if (c.type === 'block') {
      for (let j = 0; j < c.namedChildCount; j++) {
        const cc = c.namedChild(j);
        if (cc !== null) consider(cc);
      }
    }
  }
  return cases;
}

function normalizeStmt(node: SyntaxNode): CfgStmt[] {
  switch (node.type) {
    case 'comment':
      return [];
    case 'if_statement':
      return [ifChain(node)];
    case 'while_statement': {
      const cond = node.childForFieldName('condition') ?? node;
      return [{ t: 'loop', node, cond, pre: [], body: normalizeBlock(node.childForFieldName('body')) }];
    }
    case 'for_statement':
      // `for x in it:` — an implicit has-next test, no explicit condition node.
      return [{ t: 'loop', node, pre: [], body: normalizeBlock(node.childForFieldName('body')) }];
    case 'with_statement':
      // Straight-line for control flow: inline the managed block.
      return normalizeBlock(node.childForFieldName('body'));
    case 'match_statement': {
      const disc = node.childForFieldName('subject') ?? node.namedChild(0) ?? node;
      return [{ t: 'switch', node, disc, cases: matchCases(node), fallthrough: false }];
    }
    case 'return_statement':
      return [{ t: 'return', node }];
    case 'break_statement':
      return [{ t: 'break', node }];
    case 'continue_statement':
      return [{ t: 'continue', node }];
    case 'raise_statement':
      return [{ t: 'throw', node }];
    case 'try_statement': {
      const body = normalizeBlock(node.childForFieldName('body'));
      const handlers: CfgStmt[][] = [];
      let orelse: CfgStmt[] = [];
      let finalizer: CfgStmt[] | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c === null) continue;
        if (c.type === 'except_clause' || c.type === 'except_group_clause') {
          handlers.push(normalizeBlock(clauseBlock(c)));
        } else if (c.type === 'else_clause') {
          orelse = normalizeBlock(c.childForFieldName('body') ?? clauseBlock(c));
        } else if (c.type === 'finally_clause') {
          finalizer = normalizeBlock(clauseBlock(c));
        }
      }
      return [{ t: 'try', node, body, handlers, orelse, finalizer }];
    }
    default:
      // Expression statements, assignments, `pass`, nested def/class: simple.
      return [{ t: 'simple', node }];
  }
}

/** The `block` child of a try clause (`except`/`else`/`finally`). */
function clauseBlock(clause: SyntaxNode): SyntaxNode | null {
  for (let i = clause.namedChildCount - 1; i >= 0; i--) {
    const c = clause.namedChild(i);
    if (c !== null && c.type === 'block') return c;
  }
  return null;
}

/** Normalize a Python function/method body node (`block`) into the IR. */
export function normalizePyBody(body: SyntaxNode): CfgStmt[] {
  return normalizeBlock(body);
}
