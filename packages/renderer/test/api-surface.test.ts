import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('@meridian/renderer public surface', () => {
  it('exports exactly the committed runtime names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CULL_PREFETCH_MARGIN_CSS_PX',
      'DEFAULT_SPATIAL_BATCH_SIZE',
      'GeometricCameraController',
      'OUTLINE_OVERSCAN',
      'OUTLINE_ROW_HEIGHT',
      'QUADTREE_CAPACITY',
      'QUADTREE_MAX_DEPTH',
      'buildQuadtree',
      'buildScenePlan',
      'computeNearestScrollTop',
      'computeVirtualWindow',
      'createCameraController',
      'createScene',
      'cullScenePlan',
      'fitCameraToBounds',
      'mountOutlineVirtualList',
      'mountProjectionCanvas',
      'queryQuadtree',
      'queryQuadtreeWithStats',
    ]);
  });

  it('constructs without DOM or GPU work and has an idempotent teardown', () => {
    const scene = api.createScene();

    expect(scene.stats()).toMatchObject({ frameCount: 0, drawCalls: 0, modelNodes: 0 });
    expect(() => scene.pick({ x: 0, y: 0 })).toThrow('requires a mounted scene');
    scene.destroy();
    expect(() => scene.destroy()).not.toThrow();
    expect(() => scene.on('hover', () => undefined)).toThrow('destroyed scene');
  });

  it('keeps Pixi references out of the public declaration entry point', async () => {
    const declaration = await readFile(
      fileURLToPath(new URL('../dist/index.d.ts', import.meta.url)),
      'utf8',
    );

    expect(declaration).not.toMatch(/pixi/i);
  });
});
