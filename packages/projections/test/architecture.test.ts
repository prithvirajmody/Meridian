import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('@meridian/projections dependency boundary', () => {
  it('declares only the accepted Meridian dependencies', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(packageJson.dependencies).sort()).toEqual([
      '@meridian/layout',
      '@meridian/view-model',
    ]);
  });

  it('does not import renderer, stores, DOM frameworks, or application code', async () => {
    const sourceDirectory = new URL('../src/', import.meta.url);
    const files = (await readdir(sourceDirectory)).filter((file) => file.endsWith('.ts'));
    const source = (
      await Promise.all(files.map((file) => readFile(new URL(file, sourceDirectory), 'utf8')))
    ).join('\n');

    expect(source).not.toMatch(
      /from\s+['"](?:@meridian\/(?:renderer|graph-store|plugin-api|plugin-host)|react|zustand|pixi\.js|\.\.\/\.\.\/apps\/)/,
    );
    expect(source).not.toMatch(/\b(?:HTMLElement|HTMLCanvasElement|CanvasRenderingContext2D|GraphStore)\b/);
  });
});
