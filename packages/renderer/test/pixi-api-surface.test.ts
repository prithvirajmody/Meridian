import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_EXPORTS = new Set([
  'Assets',
  'BitmapFont',
  'BitmapText',
  'Buffer',
  'BufferUsage',
  'Container',
  'Geometry',
  'Mesh',
  'Shader',
  'Text',
  'UniformGroup',
  'WebGLRenderer',
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) result.push(path);
  }
  return result;
}

describe('ADR-0019 Pixi boundary', () => {
  it('allows direct pixi.js imports only inside src/pixi', async () => {
    const files = await sourceFiles(resolve(ROOT, 'src'));
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (source.includes("from 'pixi.js'") && !relative(ROOT, file).startsWith('src/pixi/')) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses only the accepted Pixi export allowlist', async () => {
    const files = await sourceFiles(resolve(ROOT, 'src/pixi'));
    const imports = new Set<string>();
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/import\s*{([\s\S]*?)}\s*from\s*'pixi\.js'/g)) {
        for (const raw of match[1]!.split(',')) {
          const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
          if (name !== '') imports.add(name!);
        }
      }
    }
    expect([...imports].filter((name) => !ALLOWED_EXPORTS.has(name))).toEqual([]);
  });

  it('does not smuggle excluded convenience layers into the Pixi leaf', async () => {
    const source = (
      await Promise.all(
        (await sourceFiles(resolve(ROOT, 'src/pixi'))).map((file) => readFile(file, 'utf8')),
      )
    ).join('\n');
    expect(source).not.toMatch(/\b(Application|Ticker|Graphics|Sprite|HTMLText|Culler)\b/);
  });
});
