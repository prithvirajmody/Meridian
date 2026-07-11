import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createPerformanceRenderModel, createUnicodeRenderModel } from '../src/performance-fixtures.js';

describe('browser acceptance fixtures', () => {
  it('builds the exact 10k fixture with representative bounded label classes', () => {
    const model = createPerformanceRenderModel();
    expect(model.nodeIds).toHaveLength(10_000);
    expect(model.labelClasses[0]).toBe(0);
    expect([...model.labelClasses].filter((value) => value === 1)).toHaveLength(312);
    expect([...model.labelClasses].filter((value) => value === 2)).toHaveLength(9_687);
  });

  it('mirrors the pinned Unicode corpus labels and NFC-normalizes decomposed text', async () => {
    const document = JSON.parse(
      await readFile(new URL('../../../fixtures/valid/unicode-labels.meridian.json', import.meta.url), 'utf8'),
    ) as { graphs: Array<{ nodes: Array<{ id: string; label: string }> }> };
    const expected = document.graphs[0]!.nodes
      .sort((left, right) => ['n-cjk', 'n-emoji', 'n-rtl', 'n-decomposed'].indexOf(left.id) - ['n-cjk', 'n-emoji', 'n-rtl', 'n-decomposed'].indexOf(right.id))
      .map((node) => node.label.normalize('NFC'));
    expect(createUnicodeRenderModel().labelTable).toEqual(expected);
    expect(createUnicodeRenderModel().labelTable.at(-1)).toBe('café');
  });
});
