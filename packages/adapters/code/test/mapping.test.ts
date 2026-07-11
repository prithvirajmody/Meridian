/**
 * Per-construct mapping rules (7C, ROADMAP §12 Unit row): each TypeScript
 * feature → the expected eager nodes. The eager/lazy line is ADR-0027: class
 * and namespace *members* are mapped; function/method *bodies* are not (nested
 * functions are absent). Inputs are inline strings — tight coupling between a
 * construct and its expected mapping.
 */
import { describe, expect, it } from 'vitest';
import type { RawDecl, RawModule } from '../src/index.js';
import { mapTs } from './support.js';

const kinds = (decls: readonly RawDecl[]): string[] => decls.map((d) => `${d.kind}:${d.name}`);
const find = (m: RawModule, name: string): RawDecl | undefined => m.decls.find((d) => d.name === name);

describe('TypeScript mapping — declarations', () => {
  it('function declarations: plain, async, generator, exported', async () => {
    const m = await mapTs('f.ts', [
      'export function add(a: number, b: number): number { return a + b; }',
      'async function load(): Promise<void> {}',
      'function* gen(): Generator<number> { yield 1; }',
    ].join('\n'));
    expect(kinds(m.decls)).toEqual(['function:add', 'function:load', 'function:gen']);
    const add = find(m, 'add')!;
    expect(add.exported).toBe(true);
    expect(add.signature).toMatchObject({ params: 2, returns: 'number', signature: '(a: number, b: number)' });
    expect(find(m, 'load')!.signature!.async).toBe(true);
    expect(find(m, 'gen')!.signature!.generator).toBe(true);
  });

  it('classes map methods, accessors, constructor, static, generator — but not bodies', async () => {
    const m = await mapTs('c.ts', [
      'export class Circle {',
      '  field = 1;',
      '  constructor(r: number) {}',
      '  area(): number { return 0; }',
      '  get d(): number { return 0; }',
      '  static unit(): Circle { return new Circle(1); }',
      '  async *samples(): AsyncGenerator<number> { yield 1; }',
      '  handler = (e: string): void => {};',
      '}',
    ].join('\n'));
    expect(kinds(m.decls)).toEqual(['class:Circle']);
    const circle = find(m, 'Circle')!;
    expect(circle.exported).toBe(true);
    // Members: constructor, area, get d, static unit, generator samples, arrow field handler.
    // Plain data `field` is not a method → not mapped.
    expect(circle.children.map((c) => c.name).sort()).toEqual(
      ['area', 'constructor', 'd', 'handler', 'samples', 'unit'].sort(),
    );
    const unit = circle.children.find((c) => c.name === 'unit')!;
    expect(unit.kind).toBe('method');
    expect(unit.signature!.static).toBe(true);
    expect(circle.children.find((c) => c.name === 'samples')!.signature!.generator).toBe(true);
    // Arrow-bound field is a method whose params come from the arrow.
    expect(circle.children.find((c) => c.name === 'handler')!.signature!.params).toBe(1);
    // A method has no eager children (its body is lazy).
    expect(circle.children.every((c) => c.children.length === 0)).toBe(true);
  });

  it('abstract class + abstract method', async () => {
    const m = await mapTs('a.ts', 'export abstract class S { abstract area(): number; }');
    const s = find(m, 'S')!;
    expect(s.abstract).toBe(true);
    expect(s.children[0]!.signature!.abstract).toBe(true);
  });

  it('binding-named functions: arrow and function-expression (ADR-0028 case 1)', async () => {
    const m = await mapTs('b.ts', [
      'export const scale = (v: number, k: number): number => v * k;',
      'const helper = function (n: number): number { return n; };',
      "export const VERSION = '1';",
    ].join('\n'));
    // Identity is the binding name; a non-function const is skipped.
    expect(kinds(m.decls)).toEqual(['function:scale', 'function:helper']);
    expect(find(m, 'scale')!.exported).toBe(true);
    expect(find(m, 'scale')!.signature!.params).toBe(2);
  });

  it('nested functions inside a body are NOT eager (ADR-0028 case 3 / ADR-0027)', async () => {
    const m = await mapTs('n.ts', [
      'export function outer(): void {',
      '  function inner(): void {}',
      '  const cb = (): number => 0;',
      '  void inner; void cb;',
      '}',
    ].join('\n'));
    expect(kinds(m.decls)).toEqual(['function:outer']);
    expect(find(m, 'outer')!.children).toEqual([]);
  });

  it('overloads → distinct signatures on same name (ADR-0028 case 2)', async () => {
    const m = await mapTs('o.ts', [
      'export function parse(x: string): object;',
      'export function parse(x: number): object;',
      'export function parse(x: unknown): object { return {}; }',
    ].join('\n'));
    const parses = m.decls.filter((d) => d.name === 'parse');
    expect(parses).toHaveLength(3);
    expect(new Set(parses.map((d) => d.sigHash)).size).toBe(3);
  });

  it('anonymous default export → the `default` segment; named default keeps its name', async () => {
    const anon = await mapTs('d1.ts', 'export default function (m: string): void {}');
    expect(kinds(anon.decls)).toEqual(['function:default']);
    expect(find(anon, 'default')!.defaultExport).toBe(true);

    const named = await mapTs('d2.ts', 'export default class Application { run(): void {} }');
    expect(kinds(named.decls)).toEqual(['class:Application']);
    expect(find(named, 'Application')!.defaultExport).toBe(true);
  });

  it('namespaces are scope containers with eager members', async () => {
    const m = await mapTs('ns.ts', [
      'export namespace Geo {',
      '  export function dist(): number { return 0; }',
      '  export class Point { norm(): number { return 0; } }',
      '  export namespace Inner { export function tag(): string { return ""; } }',
      '}',
    ].join('\n'));
    expect(kinds(m.decls)).toEqual(['namespace:Geo']);
    const geo = find(m, 'Geo')!;
    expect(geo.children.map((c) => `${c.kind}:${c.name}`).sort()).toEqual(
      ['class:Point', 'function:dist', 'namespace:Inner'].sort(),
    );
    const inner = geo.children.find((c) => c.name === 'Inner')!;
    expect(inner.children.map((c) => c.name)).toEqual(['tag']);
  });

  it('interfaces / enums / type-aliases are not eager code:* declarations (7C scope)', async () => {
    const m = await mapTs('t.ts', [
      'export interface Thing { x: number; }',
      'export enum Color { Red, Green }',
      'export type Alias = string;',
      'export function real(): void {}',
    ].join('\n'));
    expect(kinds(m.decls)).toEqual(['function:real']);
  });
});

describe('TypeScript mapping — whitespace invariance (ADR-0028 foundation)', () => {
  it('reformatting a signature does not change its mapping or hash', async () => {
    const tight = await mapTs('w.ts', 'export function f(a:string,b:number):void{}');
    const loose = await mapTs('w.ts', 'export function f(\n  a: string,\n  b: number,\n): void {\n}\n');
    const t = tight.decls[0]!;
    const l = loose.decls[0]!;
    expect(l.sigHash).toBe(t.sigHash);
    expect(l.signature!.params).toBe(t.signature!.params);
    // Only the span (byte offsets) may differ — everything identity-bearing is stable.
    expect(l.name).toBe(t.name);
  });
});

describe('TypeScript mapping — error tolerance', () => {
  it('a syntax-error file yields a partial, flagged module', async () => {
    const m = await mapTs('e.ts', [
      'export function healthy(): number { return 1; }',
      'export function broken(: {',
      'export class Survivor { ok(): boolean { return true; } }',
    ].join('\n'));
    expect(m.hasErrors).toBe(true);
    expect(m.errorCount).toBeGreaterThan(0);
    // Recovery still surfaces the well-formed declarations around the error.
    expect(m.decls.some((d) => d.name === 'healthy')).toBe(true);
  });
});
