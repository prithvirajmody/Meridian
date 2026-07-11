/**
 * Worker mapping (7C): the parse+map walk runs **inside the worker** (grammars
 * load only there — ROADMAP §12 architecture row), and produces byte-identical
 * output to the in-process walk (ADR-0027: laziness/hosting is a *when*, never a
 * *what*). Reuses 7B's Node worker-thread factory.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ParseWorkerHost } from '../src/index.js';
import { makeNodeFactory } from './node-factory.js';
import { mapTs } from './support.js';

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

  it('mapping an unimplemented language fails honestly (Python is 7D)', async () => {
    await expect(
      host.map({ language: 'python', source: 'x.py', label: 'x.py', text: 'def f(): pass\n' }),
    ).rejects.toThrow(/not implemented in 7C/);
  });
});
