/**
 * The lazy body IR (7F, ADR-0027). A function's *body* is the lazy frontier:
 * its control-flow graph (`code:block` nodes + `code:flows-to` edges) and its
 * abstract syntax subgraph (`code:stmt`/`code:expr` nodes) are materialized on
 * drill-in, never at ingest. This module holds the **structured-clone-safe**
 * intermediate the worker-side body builder emits — the analogue of 7C's
 * {@link ../map/raw.js RawModule}: graph-shaped, pre-ID plain data. Final ids
 * are derived host-side by {@link ../detail/build-detail.js} through `ctx.ids`
 * (ADR-0002/0028), so a body's ids are byte-identical whether it were
 * materialized eagerly or lazily — laziness is a *when*, never a *what*.
 *
 * The CFG algorithm and the AST walk are language-agnostic; only the
 * normalization of grammar-specific statements into {@link CfgStmt} is
 * per-language (`ts-body.ts` / `py-body.ts`), the same "factor only the shared
 * walk" discipline as the eager mapper.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';

// ---------------------------------------------------------------- normalized IR

/** A `code:flows-to` edge label (ADR §7 edge kind `code:flows-to`): the reason
 * one basic block flows to another. Descriptive provenance on the edge. */
export type FlowLabel =
  | 'seq' // straight-line fall-through / unconditional
  | 'true' // branch taken (if-consequent, loop-enter, matched case)
  | 'false' // branch not taken (if-alternative, loop-exit)
  | 'loop' // loop back-edge (body → head)
  | 'break' // `break` → loop/switch exit
  | 'continue' // `continue` → loop head
  | 'return' // `return` → function exit
  | 'exception' // `throw`/`raise` or implicit → handler/finally/exit
  | 'fallthrough' // switch case → next case (TS fallthrough)
  | 'finally'; // protected-region completion → finalizer

/**
 * A control-flow statement, normalized from a grammar-specific subtree. The
 * per-language normalizers ({@link ../detail/ts-body.js}, {@link
 * ../detail/py-body.js}) produce these; {@link ../detail/cfg.js} consumes them.
 * `node` refs stay tree-sitter-side (they never cross the worker boundary — the
 * boundary crossing is {@link RawBody}, built after CFG+AST run worker-side).
 */
export type CfgStmt =
  /** A straight-line statement (expression stmt, assignment, `pass`, decl…). Its
   * subtree becomes the AST detail of whatever block it lands in. */
  | { readonly t: 'simple'; readonly node: SyntaxNode }
  /** `if (cond) then [else otherwise]`. `elif`/`else if` fold into `otherwise`. */
  | {
      readonly t: 'if';
      readonly node: SyntaxNode;
      readonly cond: SyntaxNode;
      readonly then: readonly CfgStmt[];
      readonly otherwise: readonly CfgStmt[];
    }
  /** `while`/`for` — a head-tested loop. `pre` runs once before the head
   * (for-init); `cond` is the head test (absent = `while true`/`for … of`). */
  | {
      readonly t: 'loop';
      readonly node: SyntaxNode;
      readonly cond?: SyntaxNode;
      readonly pre: readonly CfgStmt[];
      readonly body: readonly CfgStmt[];
    }
  /** `do { body } while (cond)` — a tail-tested loop (TS only). */
  | { readonly t: 'dowhile'; readonly node: SyntaxNode; readonly cond: SyntaxNode; readonly body: readonly CfgStmt[] }
  /** `switch` (TS, `fallthrough: true`) / `match` (Python, `fallthrough: false`). */
  | {
      readonly t: 'switch';
      readonly node: SyntaxNode;
      readonly disc: SyntaxNode;
      readonly cases: readonly CfgCase[];
      readonly fallthrough: boolean;
    }
  | { readonly t: 'return'; readonly node: SyntaxNode }
  | { readonly t: 'break'; readonly node: SyntaxNode }
  | { readonly t: 'continue'; readonly node: SyntaxNode }
  /** `throw` (TS) / `raise` (Python). */
  | { readonly t: 'throw'; readonly node: SyntaxNode }
  /** `try { body } [catch/except handlers] [else orelse] [finally finalizer]`. */
  | {
      readonly t: 'try';
      readonly node: SyntaxNode;
      readonly body: readonly CfgStmt[];
      readonly handlers: readonly (readonly CfgStmt[])[];
      readonly orelse: readonly CfgStmt[];
      readonly finalizer: readonly CfgStmt[] | null;
    };

/** One `switch`/`match` case. `test === 'default'` is the default/wildcard arm. */
export interface CfgCase {
  readonly test: SyntaxNode | 'default';
  readonly body: readonly CfgStmt[];
}

// ------------------------------------------------------------ structured-clone

/** One CFG basic block, pre-ID (structured-clone-safe). `key` is the stable
 * body-local discriminator → segment `block-<key>` (`entry`/`exit` for the
 * sentinels, else the source-order ordinal). */
export interface RawBlock {
  readonly key: string;
  readonly role: 'entry' | 'exit' | 'block';
  readonly label: string;
  readonly span: readonly [number, number];
  /** The block's straight-line statements (source order) → its AST detail. */
  readonly stmts: readonly RawAst[];
}

/** One `code:flows-to` edge, pre-ID. `from`/`to` are {@link RawBlock} keys. */
export interface RawFlow {
  readonly from: string;
  readonly to: string;
  readonly label: FlowLabel;
}

/** One AST node (statement or expression), pre-ID. `key` is the body-local
 * segment relative to its parent (`stmt-<n>` / `expr-<n>`); nesting appends. */
export interface RawAst {
  readonly key: string;
  readonly kind: 'stmt' | 'expr';
  /** The grammar node type (e.g. `call_expression`) — the `code:ast-kind` attr. */
  readonly type: string;
  readonly label: string;
  readonly span: readonly [number, number];
  readonly children: readonly RawAst[];
}

/** A materialized function body: its CFG (blocks + flows) with each block's AST
 * detail attached. The one payload the resolver's worker step returns. */
export interface RawBody {
  readonly blocks: readonly RawBlock[];
  readonly flows: readonly RawFlow[];
}
