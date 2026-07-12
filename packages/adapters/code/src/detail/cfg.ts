/**
 * The language-agnostic control-flow-graph builder (7F, ADR-0027). Consumes the
 * normalized {@link CfgStmt} IR (produced per-language by `ts-body.ts` /
 * `py-body.ts`) and emits a **structured CFG**: basic blocks (maximal runs of
 * straight-line statements) joined by labelled `code:flows-to` edges. Pure over
 * the IR; deterministic (source order); imports web-tree-sitter *types* only.
 *
 * ## The model (documented so the hand-drawn truth tests can pin it; flagged in
 * the 7F report as a candidate ADR-0027 amendment — CFG edge semantics are not
 * yet fixed by an ADR).
 *
 * - Two sentinel blocks bracket every body: `entry` (fn start) and `exit` (fn
 *   return point). Every function has exactly one of each.
 * - A basic block is a maximal straight-line run; a control-flow construct ends
 *   the current block and opens successors.
 * - `if`: `true` → consequent, `false` → alternative (or the join); both arms
 *   rejoin at a fresh block.
 * - `while`/`for`: a head block (the test) with `true` → body, `false` → after;
 *   the body's normal end takes a `loop` back-edge to the head. `do…while` tests
 *   at the tail. `break` → after, `continue` → head.
 * - `switch`/`match`: the discriminator block fans out (`true` per case,
 *   `false` when no arm is guaranteed); TS cases fall through (`fallthrough`)
 *   until a `break`, Python `match` arms each rejoin after.
 * - `return` → `exit` (`return`); `break`/`continue` → the loop/switch target;
 *   all route **through any enclosing `finally`** first.
 * - `throw`/`raise` and *implicit* exceptions → the innermost enclosing handler,
 *   else finalizer, else `exit`, all `exception`. Implicit-exception edges are
 *   modelled **once, from the protected region's entry block** (a bounded,
 *   documented over-approximation — a real analysis would edge every statement).
 * - `try`/`finally`: a `finally` region is a **single** block region every exit
 *   from the protected region routes through; its out-edges are the *union* of
 *   its continuations (the normal successor plus each abrupt target it
 *   intercepts). Precise for one finalizer; a documented over-approximation for
 *   nested finalizers (not in the v1 truth tests).
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { CfgStmt, FlowLabel } from './types.js';

/** A CFG block under construction: straight-line statement nodes + role/span. */
export interface CfgBlock {
  readonly key: string;
  readonly role: 'entry' | 'exit' | 'block';
  label: string;
  span: [number, number];
  readonly stmtNodes: SyntaxNode[];
}

export interface CfgEdge {
  readonly from: string;
  readonly to: string;
  readonly label: FlowLabel;
}

export interface CfgResult {
  readonly blocks: readonly CfgBlock[];
  readonly edges: readonly CfgEdge[];
}

/** A pending finalizer: the block that begins its region, plus the set of
 * continuations (normal + abrupt) its normal end must connect to. */
interface Finalizer {
  readonly entry: CfgBlock;
  readonly continuations: Array<{ readonly target: CfgBlock; readonly label: FlowLabel }>;
}

const UNSET: [number, number] = [0, 0];

class Builder {
  readonly blocks: CfgBlock[] = [];
  readonly edges: CfgEdge[] = [];
  private ordinal = 0;
  readonly entry: CfgBlock;
  readonly exit: CfgBlock;

  // Structured-jump context.
  private breakTargets: CfgBlock[] = [];
  private continueTargets: CfgBlock[] = [];
  /** Innermost-last stack of active exception targets (handler or finalizer). */
  private handlerTargets: CfgBlock[] = [];
  /** Innermost-last stack of active finalizers abrupt jumps route through. */
  private finalizers: Finalizer[] = [];

  constructor(bodySpan: readonly [number, number]) {
    this.entry = this.mk('entry', 'entry', 'entry', [bodySpan[0], bodySpan[0]]);
    this.exit = this.mk('exit', 'exit', 'exit', [bodySpan[1], bodySpan[1]]);
  }

  private mk(key: string, role: CfgBlock['role'], label: string, span: [number, number]): CfgBlock {
    const b: CfgBlock = { key, role, label, span, stmtNodes: [] };
    this.blocks.push(b);
    return b;
  }

  fresh(label = 'block'): CfgBlock {
    return this.mk(String(this.ordinal++), 'block', label, [...UNSET]);
  }

  link(from: CfgBlock, to: CfgBlock, label: FlowLabel): void {
    this.edges.push({ from: from.key, to: to.key, label });
  }

  /** Innermost enclosing exception target (handler/finalizer), else `exit`. */
  private exceptionTarget(): CfgBlock {
    return this.handlerTargets[this.handlerTargets.length - 1] ?? this.exit;
  }

  /** Route an abrupt jump to `target` through any enclosing finalizer first. */
  private abrupt(from: CfgBlock, target: CfgBlock, label: FlowLabel): void {
    const fin = this.finalizers[this.finalizers.length - 1];
    if (fin === undefined) {
      this.link(from, target, label);
      return;
    }
    this.link(from, fin.entry, label);
    fin.continuations.push({ target, label });
  }

  /** Compile a statement list threaded from `cur`; returns the block after the
   * list, or `null` if control cannot fall through (terminated by return/etc). */
  seq(stmts: readonly CfgStmt[], cur: CfgBlock): CfgBlock | null {
    let c: CfgBlock | null = cur;
    for (const s of stmts) {
      if (c === null) break; // unreachable in flow (still present in the AST)
      c = this.stmt(s, c);
    }
    return c;
  }

  private extendSpan(b: CfgBlock, span: readonly [number, number]): void {
    if (b.span[0] === 0 && b.span[1] === 0 && b.stmtNodes.length === 0) {
      b.span = [span[0], span[1]];
    } else {
      b.span = [Math.min(b.span[0], span[0]), Math.max(b.span[1], span[1])];
    }
  }

  private stmt(s: CfgStmt, cur: CfgBlock): CfgBlock | null {
    switch (s.t) {
      case 'simple': {
        cur.stmtNodes.push(s.node);
        this.extendSpan(cur, [s.node.startIndex, s.node.endIndex]);
        return cur;
      }
      case 'return': {
        cur.stmtNodes.push(s.node);
        this.extendSpan(cur, [s.node.startIndex, s.node.endIndex]);
        this.abrupt(cur, this.exit, 'return');
        return null;
      }
      case 'break': {
        cur.stmtNodes.push(s.node);
        this.extendSpan(cur, [s.node.startIndex, s.node.endIndex]);
        const target = this.breakTargets[this.breakTargets.length - 1] ?? this.exit;
        this.abrupt(cur, target, 'break');
        return null;
      }
      case 'continue': {
        cur.stmtNodes.push(s.node);
        this.extendSpan(cur, [s.node.startIndex, s.node.endIndex]);
        const target = this.continueTargets[this.continueTargets.length - 1] ?? this.exit;
        this.abrupt(cur, target, 'continue');
        return null;
      }
      case 'throw': {
        cur.stmtNodes.push(s.node);
        this.extendSpan(cur, [s.node.startIndex, s.node.endIndex]);
        this.link(cur, this.exceptionTarget(), 'exception');
        return null;
      }
      case 'if':
        return this.ifStmt(s, cur);
      case 'loop':
        return this.loopStmt(s, cur);
      case 'dowhile':
        return this.doWhileStmt(s, cur);
      case 'switch':
        return this.switchStmt(s, cur);
      case 'try':
        return this.tryStmt(s, cur);
    }
  }

  private ifStmt(s: Extract<CfgStmt, { t: 'if' }>, cur: CfgBlock): CfgBlock | null {
    this.extendSpan(cur, [s.cond.startIndex, s.cond.endIndex]);
    const after = this.fresh('if-join');
    const thenB = this.fresh('then');
    this.link(cur, thenB, 'true');
    const thenEnd = this.seq(s.then, thenB);
    if (thenEnd !== null) this.link(thenEnd, after, 'seq');
    if (s.otherwise.length > 0) {
      const elseB = this.fresh('else');
      this.link(cur, elseB, 'false');
      const elseEnd = this.seq(s.otherwise, elseB);
      if (elseEnd !== null) this.link(elseEnd, after, 'seq');
    } else {
      this.link(cur, after, 'false');
    }
    return after;
  }

  private loopStmt(s: Extract<CfgStmt, { t: 'loop' }>, cur: CfgBlock): CfgBlock | null {
    const preEnd = this.seq(s.pre, cur) ?? cur;
    const head = this.fresh('loop-head');
    if (s.cond !== undefined) this.extendSpan(head, [s.cond.startIndex, s.cond.endIndex]);
    this.link(preEnd, head, 'seq');
    const bodyB = this.fresh('loop-body');
    const after = this.fresh('loop-exit');
    this.link(head, bodyB, 'true');
    this.link(head, after, 'false');
    this.breakTargets.push(after);
    this.continueTargets.push(head);
    const bodyEnd = this.seq(s.body, bodyB);
    this.breakTargets.pop();
    this.continueTargets.pop();
    if (bodyEnd !== null) this.link(bodyEnd, head, 'loop');
    return after;
  }

  private doWhileStmt(s: Extract<CfgStmt, { t: 'dowhile' }>, cur: CfgBlock): CfgBlock | null {
    const bodyB = this.fresh('do-body');
    this.link(cur, bodyB, 'seq');
    const head = this.fresh('do-head');
    this.extendSpan(head, [s.cond.startIndex, s.cond.endIndex]);
    const after = this.fresh('do-exit');
    this.breakTargets.push(after);
    this.continueTargets.push(head);
    const bodyEnd = this.seq(s.body, bodyB);
    this.breakTargets.pop();
    this.continueTargets.pop();
    if (bodyEnd !== null) this.link(bodyEnd, head, 'seq');
    this.link(head, bodyB, 'true');
    this.link(head, after, 'false');
    return after;
  }

  private switchStmt(s: Extract<CfgStmt, { t: 'switch' }>, cur: CfgBlock): CfgBlock | null {
    this.extendSpan(cur, [s.disc.startIndex, s.disc.endIndex]);
    const after = this.fresh('switch-join');
    // `break` exits the switch; `continue` still refers to an enclosing loop.
    this.breakTargets.push(after);
    const caseBlocks = s.cases.map((c) => this.fresh(c.test === 'default' ? 'case-default' : 'case'));
    let reachedEnd: CfgBlock | null = null;
    s.cases.forEach((cse, i) => {
      this.link(cur, caseBlocks[i]!, cse.test === 'default' ? 'true' : 'true');
      const end = this.seq(cse.body, caseBlocks[i]!);
      if (end !== null) {
        if (s.fallthrough && i + 1 < caseBlocks.length) this.link(end, caseBlocks[i + 1]!, 'fallthrough');
        else this.link(end, after, 'seq');
        reachedEnd = end;
      }
    });
    void reachedEnd;
    // No default arm ⇒ the discriminator may match nothing and skip to after.
    if (!s.cases.some((c) => c.test === 'default')) this.link(cur, after, 'false');
    this.breakTargets.pop();
    return after;
  }

  private tryStmt(s: Extract<CfgStmt, { t: 'try' }>, cur: CfgBlock): CfgBlock | null {
    const after = this.fresh('try-join');
    const hasFinally = s.finalizer !== null;
    const finEntry = hasFinally ? this.fresh('finally') : null;

    const bodyEntry = this.fresh('try-body');
    this.link(cur, bodyEntry, 'seq');

    const handlerBlocks = s.handlers.map(() => this.fresh('catch'));
    // Implicit-exception edge: modelled once, from the protected region entry.
    const excTarget = handlerBlocks[0] ?? finEntry ?? this.exceptionTarget();
    this.link(bodyEntry, excTarget, 'exception');

    // A finalizer intercepts abrupt jumps and normal completion of try/handlers.
    let fin: Finalizer | null = null;
    if (finEntry !== null) {
      fin = { entry: finEntry, continuations: [] };
      this.finalizers.push(fin);
    }
    // While in the try body, an explicit throw targets the handler (else finally).
    this.handlerTargets.push(excTarget);
    const bodyEnd = this.seq(s.body, bodyEntry);
    this.handlerTargets.pop();

    // Normal completion of the try body: run `else` (Python), then finally/after.
    const normalTarget = finEntry ?? after;
    let normalEnd: CfgBlock | null = bodyEnd;
    if (s.orelse.length > 0 && normalEnd !== null) {
      const elseB = this.fresh('try-else');
      this.link(normalEnd, elseB, 'seq');
      normalEnd = this.seq(s.orelse, elseB);
    }
    if (normalEnd !== null) {
      this.link(normalEnd, normalTarget, hasFinally ? 'finally' : 'seq');
      if (fin !== null) fin.continuations.push({ target: after, label: 'seq' });
    }

    // Handlers: reached by the exception edge; an exception inside one goes to
    // the finalizer (if any) else propagates outward.
    if (fin !== null) this.handlerTargets.push(fin.entry);
    s.handlers.forEach((handler, i) => {
      if (i > 0) this.link(bodyEntry, handlerBlocks[i]!, 'exception');
      const hEnd = this.seq(handler, handlerBlocks[i]!);
      if (hEnd !== null) {
        this.link(hEnd, normalTarget, hasFinally ? 'finally' : 'seq');
        if (fin !== null) fin.continuations.push({ target: after, label: 'seq' });
      }
    });
    if (fin !== null) this.handlerTargets.pop();

    // The finalizer body runs with the finalizer itself no longer active.
    if (fin !== null && finEntry !== null) {
      this.finalizers.pop();
      const finEnd = this.seq(s.finalizer ?? [], finEntry);
      if (finEnd !== null) {
        const seen = new Set<string>();
        for (const c of fin.continuations) {
          const k = `${c.target.key} ${c.label}`;
          if (seen.has(k)) continue;
          seen.add(k);
          this.link(finEnd, c.target, c.label);
        }
      }
    }
    return after;
  }
}

/**
 * Build the CFG of a function body from its normalized statement list.
 * `bodySpan` is the body's byte span (entry/exit sentinels sit at its ends).
 */
export function buildCfg(stmts: readonly CfgStmt[], bodySpan: readonly [number, number]): CfgResult {
  const b = new Builder(bodySpan);
  const end = b.seq(stmts, b.entry);
  if (end !== null) b.link(end, b.exit, 'seq');
  return { blocks: b.blocks, edges: b.edges };
}
