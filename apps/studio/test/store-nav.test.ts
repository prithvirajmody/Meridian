/**
 * 6D zustand nav slice: serializable values only, reset on a new open, and
 * the viewport published by the bridge for the minimap.
 */
import { describe, expect, it } from 'vitest';
import { createStudioStore, StudioStoreCommands, type StudioNavState } from '../src/store.js';

const NAV: StudioNavState = {
  depth: 2,
  zoom: 0.5,
  level: 1,
  breadcrumbs: [
    { graphId: 'g-root', node: null, label: null },
    { graphId: 'g-a', node: 'n-a', label: 'A' },
  ],
  focus: 'n-a',
  cutSize: 7,
  notice: null,
  urlFragment: '#g=g-root&ctx=n-a&z=0.5&cam=0,0,1',
  transition: { active: false, count: 3, lastMode: 'choreographed' },
  saturated: false,
};

describe('nav slice', () => {
  it('starts empty, accepts a published NavState, and clears on the next open', () => {
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    expect(store.getState().nav).toBeNull();

    commands.setNav(NAV);
    expect(store.getState().nav).toEqual(NAV);

    commands.beginOpen({ generation: 2, name: 'next.md', bytes: 1 });
    expect(store.getState().nav).toBeNull(); // a new corpus starts unnavigated
  });

  it('publishes the canvas viewport for the minimap', () => {
    const store = createStudioStore();
    const commands = new StudioStoreCommands(store);
    expect(store.getState().viewport).toBeNull();
    commands.setViewport({ width: 1280, height: 800 });
    expect(store.getState().viewport).toEqual({ width: 1280, height: 800 });
  });
});
