import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const RENDERER_SRC = fileURLToPath(new URL('../../../packages/renderer/src/', import.meta.url));

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${root}${root.endsWith('/') ? '' : '/'}${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('ADR-0022 architecture boundary', () => {
  it('React components import no Pixi/renderer internals and issue no scene draw calls', async () => {
    const componentRoot = `${SRC}components/`;
    for (const file of await sourceFiles(componentRoot)) {
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(/pixi\.js|renderer\/src\/pixi|SceneAdapter/);
      expect(source, file).not.toMatch(/\bscene\.(render|pick)\s*\(/);
    }
  });

  it('the Zustand state shape contains no engine, DOM, worker, or Pixi service', async () => {
    const source = await readFile(`${SRC}store.ts`, 'utf8');
    const stateBlock = source.slice(
      source.indexOf('export interface StudioState'),
      source.indexOf('export type StudioStore'),
    );
    expect(stateBlock).not.toMatch(/SceneAdapter|GraphStore|PluginHost|Worker|HTMLElement|HTMLCanvas|WebGL|Pixi/);
  });

  it('renderer source has no graph-store, abstraction, layout, React, or Zustand imports', async () => {
    for (const file of await sourceFiles(RENDERER_SRC)) {
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(
        /from ['"]@meridian\/(graph-store|abstraction|layout)['"]|from ['"](react|zustand)/,
      );
    }
  });

  it('all Studio scene render calls stay in the plain bridge module', async () => {
    for (const file of await sourceFiles(SRC)) {
      const source = await readFile(file, 'utf8');
      if (file.endsWith('/studio-scene-bridge.ts')) continue;
      expect(source, file).not.toMatch(/\bscene\.(render|pick)\s*\(/);
    }
  });
});
