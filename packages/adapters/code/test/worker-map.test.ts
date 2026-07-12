/**
 * Worker mapping (7C): the parse+map walk runs **inside the worker** (grammars
 * load only there — ROADMAP §12 architecture row), and produces byte-identical
 * output to the in-process walk (ADR-0027: laziness/hosting is a *when*, never a
 * *what*). Reuses 7B's Node worker-thread factory.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ParseWorkerHost } from '../src/index.js';
import { makeNodeFactory } from './node-factory.js';
import { mapPy, mapTs, resolveBodyBySpan } from './support.js';

const { factory } = makeNodeFactory();
const host = new ParseWorkerHost({ factory });
afterAll(() => host.dispose());

const SAMPLE = [
  'export class Circle {',
  '  constructor(public r: number) {}',
  '  area(): number { return this.r * this.r; }',
  '  static unit(): Circle { return new Circle(1); }',
  '}',
  'export function twice(a: string): void;',
  'export function twice(a: number): void;',
  'export function twice(a: unknown): void {}',
  'export const scale = (c: Circle, k: number) => new Circle(c.r * k);',
  'export default function main(): void {}',
  'namespace Geo { export function dist(): number { return 0; } }',
].join('\n');

describe('worker-hosted mapping', () => {
  it('the worker loads the grammar and returns a mapped RawModule', async () => {
    const { module } = await host.map({ language: 'typescript', source: 'shapes.ts', label: 'shapes.ts', text: SAMPLE });
    expect(module.language).toBe('typescript');
    expect(module.decls.some((d) => d.kind === 'class' && d.name === 'Circle')).toBe(true);
    expect(module.decls.filter((d) => d.name === 'twice')).toHaveLength(3);
  });

  it('worker output is byte-identical to the in-process walk (parity)', async () => {
    const { module } = await host.map({ language: 'typescript', source: 'shapes.ts', label: 'shapes.ts', text: SAMPLE });
    const inproc = await mapTs('shapes.ts', SAMPLE);
    expect(module).toEqual(inproc);
  });

  it('a syntax-error file maps to a partial, flagged module in the worker', async () => {
    const { module } = await host.map({
      language: 'typescript',
      source: 'e.ts',
      label: 'e.ts',
      text: 'export function ok(): number { return 1; }\nexport function broken(: {\n',
    });
    expect(module.hasErrors).toBe(true);
    expect(module.errorCount).toBeGreaterThan(0);
    expect(module.decls.some((d) => d.name === 'ok')).toBe(true);
  });

  it('resolveBody runs in the worker and matches the in-process build (7F parity)', async () => {
    // ADR-0027: `resolve` runs in the parse worker; hosting is a *when*, never
    // a *what* — the worker-built RawBody must be byte-identical in-process.
    const { module } = await host.map({ language: 'typescript', source: 'shapes.ts', label: 'shapes.ts', text: SAMPLE });
    const area = module.decls.find((d) => d.name === 'Circle')!.children.find((d) => d.name === 'area')!;
    expect(area.bodySpan).toBeDefined();
    const { body, resolveTimeMs } = await host.resolveBody({
      language: 'typescript',
      text: SAMPLE,
      declSpan: area.span,
    });
    expect(body).toBeDefined();
    expect(body!.blocks.some((b) => b.role === 'entry')).toBe(true);
    expect(body!.flows.length).toBeGreaterThan(0);
    expect(resolveTimeMs).toBeGreaterThanOrEqual(0);
    const inproc = await resolveBodyBySpan('typescript', SAMPLE, area.span);
    expect(body).toEqual(inproc);
  });

  it('maps Python in the worker, byte-identical to the in-process walk (7D parity)', async () => {
    const PY = [
      'class Circle:',
      '    def __init__(self, r: float):',
      '        self.r = r',
      '    @staticmethod',
      '    def unit() -> "Circle": return Circle(1)',
      'from typing import overload',
      '@overload',
      'def parse(x: int) -> str: ...',
      '@overload',
      'def parse(x: str) -> int: ...',
      'def parse(x): return x',
      'scale = lambda c, k: Circle(c.r * k)',
    ].join('\n');
    const { module } = await host.map({ language: 'python', source: 'shapes.py', label: 'shapes.py', text: PY });
    expect(module.language).toBe('python');
    expect(module.decls.some((d) => d.kind === 'class' && d.name === 'Circle')).toBe(true);
    expect(module.decls.filter((d) => d.name === 'parse')).toHaveLength(3);
    const inproc = await mapPy('shapes.py', PY);
    expect(module).toEqual(inproc);
  });
});
