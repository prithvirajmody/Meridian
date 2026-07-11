import { PixiScene } from './pixi/pixi-scene.js';
import type { SceneAdapter, SceneOptions } from './types.js';

/** Construct a side-effect-free adapter; GPU work starts only at `mount`. */
export function createScene(options: SceneOptions = {}): SceneAdapter {
  return new PixiScene(options);
}
