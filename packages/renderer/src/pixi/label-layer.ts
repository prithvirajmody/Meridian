/**
 * ADR-0020 label rendering leaf. Consumes the pure {@link LabelPlan} and draws it
 * into a screen-space overlay: the MSDF `BitmapText` fast path plus the bounded
 * shaped-Unicode `Text` fallback. Pixi lives only here; the plan itself is pure.
 *
 * `Text` is imported ONLY in this module — the architecture test enforces that.
 * Bitmap objects are pooled by slot; fallback `Text` is pooled by node identity
 * so pan and zoom reposition without re-rasterizing while two nodes with the
 * same label still receive two live objects (ADR-0020).
 */
import { Assets, BitmapText, Container, Text } from 'pixi.js';
import {
  LABEL_CLASS_CONNECTED,
  LABEL_CLASS_FORCED,
  LABEL_CLASS_ORDINARY,
  LABEL_CLASS_SUMMARY,
  type LabelClass,
  type NodeId,
} from '@meridian/view-model';
import { LABEL_NOMINAL_SIZE_CSS_PX, type LabelPlan, type PlannedLabel } from '../labels/index.js';

/** Retain a little slack over the 64 live-fallback cap before evicting strings. */
const FALLBACK_CACHE_LIMIT = 96;

const CLASS_TINT: Record<LabelClass, number> = {
  [LABEL_CLASS_FORCED]: 0xffffff,
  [LABEL_CLASS_SUMMARY]: 0xdbe7ff,
  [LABEL_CLASS_CONNECTED]: 0xaebbd6,
  [LABEL_CLASS_ORDINARY]: 0x8291a8,
};

interface FallbackEntry {
  readonly text: Text;
  sourceText: string;
  lastUsedFrame: number;
}

export class PixiLabelLayer {
  private readonly container = new Container();
  private fontFamily: string | null = null;
  private readonly bitmapPool: BitmapText[] = [];
  private readonly fallbackByNode = new Map<NodeId, FallbackEntry>();
  private frame = 0;

  constructor(parent: Container) {
    this.container.label = 'meridian-label-overlay';
    parent.addChild(this.container);
  }

  /** True once the MSDF atlas has been loaded through `Assets`. */
  get ready(): boolean {
    return this.fontFamily !== null;
  }

  /** Load the checked-in MSDF atlas. No network fetch — the asset is bundled. */
  async load(fontUrl: string): Promise<void> {
    const font = (await Assets.load({ src: fontUrl, data: { family: undefined } })) as
      | { fontFamily?: string }
      | undefined;
    this.fontFamily =
      typeof font?.fontFamily === 'string' && font.fontFamily !== '' ? font.fontFamily : 'DejaVuSans';
  }

  /** Reconcile the overlay with one frame's plan. */
  sync(plan: LabelPlan): void {
    this.frame++;
    let bitmapSlot = 0;
    for (const label of plan.labels) {
      if (label.renderKind === 'bitmap') this.drawBitmap(label, bitmapSlot++);
      else this.drawFallback(label);
    }
    for (let slot = bitmapSlot; slot < this.bitmapPool.length; slot++) {
      this.bitmapPool[slot]!.visible = false;
    }
    this.evictFallback();
  }

  private drawBitmap(label: PlannedLabel, slot: number): void {
    if (this.fontFamily === null) return;
    let text = this.bitmapPool[slot];
    if (text === undefined) {
      text = new BitmapText({
        text: label.text,
        style: { fontFamily: this.fontFamily, fontSize: LABEL_NOMINAL_SIZE_CSS_PX },
      });
      text.anchor.set(0.5);
      this.container.addChild(text);
      this.bitmapPool[slot] = text;
    }
    // Bitmap glyphs come from the atlas; changing text re-lays quads, never rasterizes.
    if (text.text !== label.text) text.text = label.text;
    text.position.set(label.screenX, label.screenY);
    text.tint = CLASS_TINT[label.labelClass];
    text.alpha = label.alpha;
    text.visible = true;
  }

  private drawFallback(label: PlannedLabel): void {
    let entry = this.fallbackByNode.get(label.nodeId);
    if (entry === undefined) {
      const text = new Text({
        text: label.text,
        style: { fontFamily: 'sans-serif', fontSize: LABEL_NOMINAL_SIZE_CSS_PX, fill: 0xffffff },
      });
      text.anchor.set(0.5);
      this.container.addChild(text);
      entry = { text, sourceText: label.text, lastUsedFrame: this.frame };
      this.fallbackByNode.set(label.nodeId, entry);
    } else if (entry.sourceText !== label.text) {
      // Identity is stable across camera movement and model revisions. A real
      // text change is the one case where the browser fallback must rerasterize.
      entry.text.text = label.text;
      entry.sourceText = label.text;
    }
    // Reused object: only position/tint change on pan/zoom, so no re-rasterization.
    entry.lastUsedFrame = this.frame;
    entry.text.position.set(label.screenX, label.screenY);
    entry.text.tint = CLASS_TINT[label.labelClass];
    entry.text.alpha = label.alpha;
    entry.text.visible = true;
  }

  private evictFallback(): void {
    for (const entry of this.fallbackByNode.values()) {
      if (entry.lastUsedFrame !== this.frame) entry.text.visible = false;
    }
    if (this.fallbackByNode.size <= FALLBACK_CACHE_LIMIT) return;
    const stale = [...this.fallbackByNode.entries()]
      .filter(([, entry]) => entry.lastUsedFrame !== this.frame)
      .sort((a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame);
    for (const [key, entry] of stale) {
      if (this.fallbackByNode.size <= FALLBACK_CACHE_LIMIT) break;
      entry.text.destroy();
      this.fallbackByNode.delete(key);
    }
  }

  destroy(): void {
    for (const text of this.bitmapPool) text.destroy();
    this.bitmapPool.length = 0;
    for (const entry of this.fallbackByNode.values()) entry.text.destroy();
    this.fallbackByNode.clear();
    this.container.destroy({ children: true });
  }
}
