/**
 * CFG builder vs hand-drawn truth (7F, ROADMAP §12 Unit row: "CFG builder vs
 * hand-drawn truth for tricky control flow"). Each case fixes the exact block
 * set (`key:role`) and labelled flow set (`from->to:label`) the {@link buildCfg}
 * model (documented in `src/detail/cfg.ts`) must produce — early returns,
 * try/finally, loops with break/continue, and switch (TS) / match (Python), in
 * both languages. Block ordinals are source-order-deterministic, so the sets
 * are pinned exactly; every case is also checked for structural well-formedness.
 */
import { describe, expect, it } from 'vitest';
import type { RawBody } from '../src/index.js';
import { cfgSummary, resolveBodyByName } from './support.js';

/** Structural invariants every CFG must satisfy. */
function assertWellFormed(body: RawBody): void {
  const roles = body.blocks.map((b) => b.role);
  expect(roles.filter((r) => r === 'entry')).toHaveLength(1);
  expect(roles.filter((r) => r === 'exit')).toHaveLength(1);
  const keys = new Set(body.blocks.map((b) => b.key));
  for (const f of body.flows) {
    expect(keys.has(f.from)).toBe(true);
    expect(keys.has(f.to)).toBe(true);
  }
  // The entry is never a target; the exit is never a source.
  expect(body.flows.some((f) => f.to === 'entry')).toBe(false);
  expect(body.flows.some((f) => f.from === 'exit')).toBe(false);
}

describe('CFG — TypeScript, hand-drawn truth', () => {
  it('early return: if-return then straight-line return', async () => {
    // entry —true→ [return 1] —return→ exit ; entry —false→ [g(); return 2] —return→ exit
    const body = await resolveBodyByName('typescript', `function f(x){ if (x) { return 1; } g(); return 2; }`, 'f');
    assertWellFormed(body);
    expect(cfgSummary(body)).toEqual({
      blocks: ['0:block', '1:block', 'entry:entry', 'exit:exit'],
      flows: ['0->exit:return', '1->exit:return', 'entry->0:false', 'entry->1:true'].sort(),
    });
  });

  it('loop with continue and break', async () => {
    const body = await resolveBodyByName(
      'typescript',
      `function f(){ for (let i=0;i<3;i++){ if(i==1) continue; if(i==2) break; h(i); } done(); }`,
      'f',
    );
    assertWellFormed(body);
    // 0=loop-head 1=loop-body 2=loop-exit 3,5=inner if-joins 4=continue 6=break
    expect(cfgSummary(body).flows).toEqual(
      [
        'entry->0:seq',
        '0->1:true',
        '0->2:false',
        '1->4:true',
        '4->0:continue',
        '1->3:false',
        '3->6:true',
        '6->2:break',
        '3->5:false',
        '5->0:loop',
        '2->exit:seq',
      ].sort(),
    );
    // The back-edge, the break→exit-of-loop, and the continue→head are present.
    expect(body.flows).toContainEqual({ from: '5', to: '0', label: 'loop' });
    expect(body.flows).toContainEqual({ from: '6', to: '2', label: 'break' });
    expect(body.flows).toContainEqual({ from: '4', to: '0', label: 'continue' });
  });

  it('switch with fallthrough, break, and default', async () => {
    const body = await resolveBodyByName(
      'typescript',
      `function f(x){ switch(x){ case 1: a(); break; case 2: b(); default: c(); } d(); }`,
      'f',
    );
    assertWellFormed(body);
    // 0=switch-join(d()) 1=case1 2=case2 3=default
    expect(cfgSummary(body).flows).toEqual(
      [
        'entry->1:true',
        '1->0:break',
        'entry->2:true',
        '2->3:fallthrough',
        'entry->3:true',
        '3->0:seq',
        '0->exit:seq',
      ].sort(),
    );
    // case 2 falls through into default (no break between them).
    expect(body.flows).toContainEqual({ from: '2', to: '3', label: 'fallthrough' });
  });

  it('try/finally routes a return through the finalizer', async () => {
    const body = await resolveBodyByName('typescript', `function f(){ try { a(); return 1; } finally { c(); } d(); }`, 'f');
    assertWellFormed(body);
    // 2=try-body 1=finally 0=after(d, unreachable: try always returns)
    expect(cfgSummary(body).flows).toEqual(
      ['entry->2:seq', '2->1:exception', '2->1:return', '1->exit:return', '0->exit:seq'].sort(),
    );
    // The return does not jump straight to exit — it passes through finally.
    expect(body.flows).toContainEqual({ from: '2', to: '1', label: 'return' });
    expect(body.flows).toContainEqual({ from: '1', to: 'exit', label: 'return' });
    expect(body.flows.some((f) => f.from === '2' && f.to === 'exit')).toBe(false);
  });
});

describe('CFG — Python, hand-drawn truth', () => {
  it('early return', async () => {
    const body = await resolveBodyByName('python', `def f(x):\n  if x:\n    return 1\n  g()\n  return 2\n`, 'f');
    assertWellFormed(body);
    expect(cfgSummary(body)).toEqual({
      blocks: ['0:block', '1:block', 'entry:entry', 'exit:exit'],
      flows: ['0->exit:return', '1->exit:return', 'entry->0:false', 'entry->1:true'].sort(),
    });
  });

  it('loop with continue and break', async () => {
    const body = await resolveBodyByName(
      'python',
      `def f():\n  for i in r:\n    if i:\n      continue\n    if i:\n      break\n    h(i)\n  done()\n`,
      'f',
    );
    assertWellFormed(body);
    expect(cfgSummary(body).flows).toEqual(
      [
        'entry->0:seq',
        '0->1:true',
        '0->2:false',
        '1->4:true',
        '4->0:continue',
        '1->3:false',
        '3->6:true',
        '6->2:break',
        '3->5:false',
        '5->0:loop',
        '2->exit:seq',
      ].sort(),
    );
  });

  it('match arms rejoin (no fallthrough)', async () => {
    const body = await resolveBodyByName(
      'python',
      `def f(x):\n  match x:\n    case 1:\n      a()\n    case _:\n      b()\n  d()\n`,
      'f',
    );
    assertWellFormed(body);
    // 0=match-join(d()) 1=case 1 arm 2=wildcard arm — each rejoins, no fallthrough.
    expect(cfgSummary(body).flows).toEqual(
      ['entry->1:true', '1->0:seq', 'entry->2:true', '2->0:seq', '0->exit:seq'].sort(),
    );
    expect(body.flows.some((f) => f.label === 'fallthrough')).toBe(false);
  });

  it('try/except/else/finally: return through finally, handler rejoin', async () => {
    const body = await resolveBodyByName(
      'python',
      `def f():\n  try:\n    a()\n    return 1\n  except E:\n    b()\n  else:\n    e()\n  finally:\n    c()\n  d()\n`,
      'f',
    );
    assertWellFormed(body);
    // 2=try-body 3=except 1=finally 0=after(d())
    expect(cfgSummary(body).flows).toEqual(
      [
        'entry->2:seq',
        '2->3:exception',
        '2->1:return',
        '3->1:finally',
        '1->exit:return',
        '1->0:seq',
        '0->exit:seq',
      ].sort(),
    );
    // The exception path reaches the handler; the return path reaches finally.
    expect(body.flows).toContainEqual({ from: '2', to: '3', label: 'exception' });
    expect(body.flows).toContainEqual({ from: '2', to: '1', label: 'return' });
  });
});
