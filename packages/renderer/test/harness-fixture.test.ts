import { describe, expect, it } from 'vitest';
import {
  LABEL_CLASS_CONNECTED,
  LABEL_CLASS_FORCED,
  LABEL_CLASS_SUMMARY,
  NODE_FLAG_SELECTED,
  NODE_FLAG_SELECTION_ANCHOR,
} from '@meridian/view-model';
import { createHarnessFixture } from '../harness/fixture.js';

describe('10k renderer harness fixture', () => {
  it('uses representative label classes with one forced selection anchor', () => {
    const model = createHarnessFixture();
    const classes = [...model.labelClasses];

    expect(model.nodeIds).toHaveLength(10_000);
    expect(model.edgeKeys).toHaveLength(9_900);
    expect(classes.filter((value) => value === LABEL_CLASS_FORCED)).toHaveLength(1);
    expect(classes.filter((value) => value === LABEL_CLASS_SUMMARY)).toHaveLength(312);
    expect(classes.filter((value) => value === LABEL_CLASS_CONNECTED)).toHaveLength(9_687);
    expect(model.nodeFlags[0]).toBe(NODE_FLAG_SELECTED | NODE_FLAG_SELECTION_ANCHOR);
    expect([...model.nodeDegrees].every((degree) => degree > 0)).toBe(true);
  });
});
