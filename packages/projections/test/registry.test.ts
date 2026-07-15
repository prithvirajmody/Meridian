import { EMPTY_FOCUS, EMPTY_SELECTION, type ProjectionModel } from '@meridian/view-model';
import { describe, expect, it } from 'vitest';
import {
  ProjectionRegistry,
  type ProjectionHost,
  type ProjectionInstance,
  type ViewProjection,
} from '../src/index.js';

const MODEL: ProjectionModel = {
  cutLevel: 0,
  nodes: [],
  inducedEdges: [],
  selection: EMPTY_SELECTION,
  focus: EMPTY_FOCUS,
  domainMeta: { domain: 'test', label: 'Test' },
  diagnostics: [],
};

const INSTANCE: ProjectionInstance = {
  render: () => undefined,
  applySelection: () => undefined,
  applyFocus: () => undefined,
  revealFocus: () => undefined,
  captureViewState: () => null,
  restoreViewState: () => undefined,
  destroy: () => undefined,
};

function projection(id: string, label: string, suitability: number): ViewProjection {
  return {
    id,
    label,
    suitability: () => suitability,
    mount: async (_host: ProjectionHost) => INSTANCE,
  };
}

describe('ProjectionRegistry', () => {
  it('resolves in registration order and ranks by normalized suitability', () => {
    const low = projection('low', 'Low', -3);
    const high = projection('high', 'High', 4);
    const invalid = projection('invalid', 'Invalid', Number.NaN);
    const registry = new ProjectionRegistry([low, high, invalid]);

    expect(registry.list()).toEqual([low, high, invalid]);
    expect(registry.get('high')).toBe(high);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.ranked(MODEL)).toEqual([
      { projection: high, suitability: 1 },
      { projection: invalid, suitability: 0 },
      { projection: low, suitability: 0 },
    ]);
  });

  it('rejects empty and duplicate ids', () => {
    const registry = new ProjectionRegistry([projection('map', 'Map', 1)]);
    expect(() => registry.register(projection('map', 'Another map', 1))).toThrow(
      'duplicate projection id',
    );
    expect(() => registry.register(projection('   ', 'Blank', 1))).toThrow(
      'projection id must not be empty',
    );
  });
});
