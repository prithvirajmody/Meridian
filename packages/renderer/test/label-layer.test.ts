import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LABEL_CLASS_CONNECTED,
  type NodeId,
} from '@meridian/view-model';
import type { LabelPlan, PlannedLabel } from '../src/labels/plan.js';

const fallbackLog = vi.hoisted(() => ({
  created: 0,
  positions: [] as { x: number; y: number }[],
  texts: [] as string[],
}));

vi.mock('pixi.js', () => {
  class FakeContainer {
    label = '';
    readonly children: unknown[] = [];

    addChild(child: unknown): void {
      this.children.push(child);
    }

    destroy(): void {}
  }

  class FakeBitmapText {
    text: string;
    tint = 0xffffff;
    visible = true;
    readonly anchor = { set: (_value: number): void => {} };
    readonly position = { set: (_x: number, _y: number): void => {} };

    constructor(options: { text?: string } = {}) {
      this.text = options.text ?? '';
    }

    destroy(): void {}
  }

  class FakeText {
    private readonly index: number;
    tint = 0xffffff;
    visible = true;
    readonly anchor = { set: (_value: number): void => {} };
    readonly position: { set(x: number, y: number): void };

    constructor(options: { text?: string } = {}) {
      this.index = fallbackLog.created++;
      fallbackLog.texts[this.index] = options.text ?? '';
      this.position = {
        set: (x, y): void => {
          fallbackLog.positions[this.index] = { x, y };
        },
      };
    }

    get text(): string {
      return fallbackLog.texts[this.index] ?? '';
    }

    set text(value: string) {
      fallbackLog.texts[this.index] = value;
    }

    destroy(): void {}
  }

  return {
    Assets: { load: async (): Promise<{ fontFamily: string }> => ({ fontFamily: 'test' }) },
    BitmapText: FakeBitmapText,
    Container: FakeContainer,
    Text: FakeText,
  };
});

const { PixiLabelLayer } = await import('../src/pixi/label-layer.js');
const { Container } = await import('pixi.js');

function fallback(node: number, text = '中文'): PlannedLabel {
  return {
    nodeIndex: node,
    nodeId: `n-${node}` as NodeId,
    text,
    screenX: node * 100 + 10,
    screenY: 20,
    labelClass: LABEL_CLASS_CONNECTED,
    renderKind: 'fallback',
    forced: false,
    isHover: false,
    alpha: 1,
  };
}

function plan(labels: readonly PlannedLabel[]): LabelPlan {
  return {
    labels,
    bitmapLabelCount: 0,
    fallbackLabelCount: labels.length,
    omittedLabelCount: 0,
    diagnostics: [],
  };
}

beforeEach(() => {
  fallbackLog.created = 0;
  fallbackLog.positions = [];
  fallbackLog.texts = [];
});

describe('PixiLabelLayer fallback pooling', () => {
  it('keeps distinct live objects for different nodes with identical text', () => {
    const layer = new PixiLabelLayer(new Container());

    layer.sync(plan([fallback(0), fallback(1)]));

    expect(fallbackLog.created).toBe(2);
    expect(fallbackLog.texts).toEqual(['中文', '中文']);
    expect(fallbackLog.positions).toEqual([{ x: 10, y: 20 }, { x: 110, y: 20 }]);

    // A camera-only move reuses both identity-keyed objects.
    layer.sync(plan([
      { ...fallback(0), screenX: 30 },
      { ...fallback(1), screenX: 130 },
    ]));
    expect(fallbackLog.created).toBe(2);
    expect(fallbackLog.positions).toEqual([{ x: 30, y: 20 }, { x: 130, y: 20 }]);
  });
});
