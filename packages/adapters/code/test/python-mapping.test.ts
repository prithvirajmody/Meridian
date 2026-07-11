/**
 * Per-construct Python mapping rules (7D, ROADMAP §12 Unit row): each Python
 * feature → the expected eager nodes. The eager/lazy line is ADR-0027: class
 * *members* (methods, nested classes) are mapped; function/method *bodies* are
 * not (nested functions are absent). Inputs are inline strings — tight coupling
 * between a construct and its expected mapping, mirroring mapping.test.ts (TS).
 */
import { describe, expect, it } from 'vitest';
import type { RawDecl, RawModule } from '../src/index.js';
import { mapPy } from './support.js';

const kinds = (decls: readonly RawDecl[]): string[] => decls.map((d) => `${d.kind}:${d.name}`);
const find = (m: RawModule, name: string): RawDecl | undefined => m.decls.find((d) => d.name === name);
const child = (d: RawDecl, name: string): RawDecl | undefined => d.children.find((c) => c.name === name);

describe('Python mapping — declarations', () => {
  it('function definitions: plain, async, and their signatures', async () => {
    const m = await mapPy('f.py', [
      'def add(a: int, b: int) -> int:',
      '    return a + b',
      '',
      'async def load() -> None:',
      '    return None',
    ].join('\n'));
    expect(kinds(m.decls)).toEqual(['function:add', 'function:load']);
    const add = find(m, 'add')!;
    expect(add.signature).toMatchObject({ params: 2, returns: 'int', signature: '(a: int, b: int)' });
    expect(add.signature!.paramTypeList).toEqual(['int', 'int']);
    expect(find(m, 'load')!.signature!.async).toBe(true);
  });

  it('classes map methods and nested classes — but not method bodies', async () => {
    const m = await mapPy('c.py', [
      'class Circle:',
      '    PI = 3.14',
      '    def __init__(self, r: float):',
      '        self.r = r',
      '    def area(self) -> float:',
      '        return self.r',
      '    class Meta:',
      '        def describe(self) -> str:',
      '            return "x"',
    ].join('\n'));
    expect(kinds(m.decls)).toEqual(['class:Circle']);
    const circle = find(m, 'Circle')!;
    // Members: __init__, area (methods) + Meta (nested class). Plain attr `PI` skipped.
    expect(circle.children.map((c) => `${c.kind}:${c.name}`).sort()).toEqual(
      ['class:Meta', 'method:__init__', 'method:area'].sort(),
    );
    // Methods have no eager children (bodies are lazy); the nested class does.
    expect(child(circle, 'area')!.children).toEqual([]);
    expect(child(circle, 'Meta')!.children.map((c) => c.name)).toEqual(['describe']);
    expect(child(circle, 'Meta')!.children[0]!.kind).toBe('method');
  });

  it('staticmethod / classmethod / property carry flags, stay code:method', async () => {
    const m = await mapPy('s.py', [
      'class C:',
      '    @staticmethod',
      '    def unit() -> "C": return C()',
      '    @classmethod',
      '    def make(cls, r: float): return cls()',
      '    @property',
      '    def d(self) -> float: return 1.0',
      '    @d.setter',
      '    def d(self, v: float) -> None: pass',
    ].join('\n'));
    const c = find(m, 'C')!;
    expect(child(c, 'unit')!.kind).toBe('method');
    expect(child(c, 'unit')!.signature!.static).toBe(true);
    expect(child(c, 'make')!.signature!.classmethod).toBe(true);
    // Two `d` methods (getter + setter): distinct signatures, both property-flagged.
    const ds = c.children.filter((x) => x.name === 'd');
    expect(ds).toHaveLength(2);
    expect(ds.every((x) => x.signature!.property === true)).toBe(true);
    expect(ds[0]!.sigHash).not.toBe(ds[1]!.sigHash);
  });

  it('decorated functions capture their decorators as provenance', async () => {
    const m = await mapPy('d.py', [
      '@decorator',
      'def one() -> int: return 1',
      '@a.b',
      'def two(): pass',
    ].join('\n'));
    expect(find(m, 'one')!.decorators).toEqual(['decorator']);
    expect(find(m, 'two')!.decorators).toEqual(['a.b']);
  });

  it('binding-named lambdas are functions; plain value bindings are not (ADR-0028 case 1)', async () => {
    const m = await mapPy('b.py', [
      'scale = lambda v, k: v * k',
      "VERSION = '1'",
      'compose = lambda f: lambda g: lambda x: f(g(x))',
    ].join('\n'));
    // Identity is the binding name; a non-lambda binding is skipped; the walk
    // never descends into the lambda body, so inner lambdas are not eager.
    expect(kinds(m.decls)).toEqual(['function:scale', 'function:compose']);
    expect(find(m, 'scale')!.signature!.params).toBe(2);
    expect(find(m, 'scale')!.signature!.signature).toBe('(v, k)');
  });

  it('nested functions inside a body are NOT eager (ADR-0028 case 3 / ADR-0027)', async () => {
    const m = await mapPy('n.py', [
      'def outer() -> None:',
      '    def inner() -> None: pass',
      '    helper = lambda n: n + 1',
      '    del inner, helper',
    ].join('\n'));
    expect(kinds(m.decls)).toEqual(['function:outer']);
    expect(find(m, 'outer')!.children).toEqual([]);
  });

  it('@overload stubs → distinct signatures + code:overload flag (ADR-0028 case 2)', async () => {
    const m = await mapPy('o.py', [
      'from typing import overload',
      '@overload',
      'def parse(x: int) -> str: ...',
      '@overload',
      'def parse(x: str) -> int: ...',
      'def parse(x): return x',
    ].join('\n'));
    const parses = m.decls.filter((d) => d.name === 'parse');
    expect(parses).toHaveLength(3);
    // Three distinct signature hashes (two typed stubs + the untyped impl).
    expect(new Set(parses.map((d) => d.sigHash)).size).toBe(3);
    // The two stubs are flagged @overload; the implementation is not.
    expect(parses.filter((d) => d.overload === true)).toHaveLength(2);
  });

  it('return-annotation-only overloads are distinct (Python hash includes the return)', async () => {
    const m = await mapPy('r.py', [
      'from typing import overload',
      '@overload',
      'def read() -> str: ...',
      '@overload',
      'def read() -> int: ...',
    ].join('\n'));
    const reads = m.decls.filter((d) => d.name === 'read');
    expect(reads).toHaveLength(2);
    expect(reads[0]!.sigHash).not.toBe(reads[1]!.sigHash);
  });

  it('same-scope redefinition duplicates keep same signature (→ ~n at ID time)', async () => {
    const m = await mapPy('dup.py', [
      'def twice(a: str) -> None: pass',
      'def twice(a: str) -> None: pass',
      'class R: pass',
      'class R: pass',
    ].join('\n'));
    const twices = m.decls.filter((d) => d.name === 'twice');
    expect(twices).toHaveLength(2);
    expect(twices[0]!.sigHash).toBe(twices[1]!.sigHash); // identical shape
    expect(m.decls.filter((d) => d.name === 'R')).toHaveLength(2);
  });

  it('imports, control-flow, and plain assignments are not eager declarations', async () => {
    const m = await mapPy('t.py', [
      'import os',
      'from a import b',
      'X = 1',
      'if True:',
      '    def conditional(): pass',  // inside a block: not descended (mirrors TS)
      'def real(): pass',
    ].join('\n'));
    expect(kinds(m.decls)).toEqual(['function:real']);
  });
});

describe('Python mapping — whitespace invariance (ADR-0028 foundation)', () => {
  it('reformatting a signature does not change its mapping or hash', async () => {
    const tight = await mapPy('w.py', 'def f(a:str,b:int)->None:\n    pass\n');
    const loose = await mapPy('w.py', 'def f(\n    a: str,\n    b: int,\n) -> None:\n    pass\n');
    const t = tight.decls[0]!;
    const l = loose.decls[0]!;
    expect(l.sigHash).toBe(t.sigHash);
    expect(l.signature!.params).toBe(t.signature!.params);
    expect(l.name).toBe(t.name);
  });
});

describe('Python mapping — error tolerance', () => {
  it('a syntax-error file yields a partial, flagged module', async () => {
    const m = await mapPy('e.py', [
      'def healthy() -> int:',
      '    return 1',
      'def broken(:',
      '    return 2',
      'class Survivor:',
      '    def ok(self) -> bool: return True',
    ].join('\n'));
    expect(m.hasErrors).toBe(true);
    expect(m.errorCount).toBeGreaterThan(0);
    expect(m.decls.some((d) => d.name === 'healthy')).toBe(true);
  });
});
