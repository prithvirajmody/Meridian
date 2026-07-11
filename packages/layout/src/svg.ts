/**
 * SVG snapshot exporter (ROADMAP Phase 4 §1, §11): renders a `LayoutResult`
 * into a deterministic, normalized SVG string so layout quality is reviewable
 * and regression-testable **without a renderer or a GPU**.
 *
 * **Pure string-building — no DOM APIs anywhere.** The architecture row (§12)
 * forbids DOM outside the 4C worker-host shim, and 4B has no worker host, so
 * this module never touches `document`, `SVGElement`, or any browser global;
 * it concatenates strings. Output is **canonical/normalized**: nodes emitted in
 * ascending `NodeId` order, edges in `(src, dst, kind)` order, every coordinate
 * rounded to a fixed precision with `-0` folded to `0`, LF line endings, one
 * element per line — so goldens diff stably (I6).
 *
 * Edges are drawn as straight center-to-center lines unless `result.edgeRoutes`
 * carries a polyline for the edge's `"src→dst→kind"` identity (ADR-0013/0015);
 * 4B providers emit straight lines (§9c). Optional `labels`/`ids` are *data*
 * passed by the caller (e.g. the CLI) — no domain words live in this code.
 */
import type { InducedEdge, NodeId } from '@meridian/view-model';
import type { Point, Rect } from './coords.js';
import { centerOf } from './geometry.js';
import type { LayoutResult } from './types.js';

/** Options for {@link exportSvg}. All optional and presentation-neutral. */
export interface SvgOptions {
  /** World-unit margin added around `bounds` for the viewBox. Default `8`. */
  readonly padding?: number;
  /** Optional per-node text drawn centered in the box (e.g. labels from the
   * CLI). Absent ⇒ boxes only. */
  readonly labels?: ReadonlyMap<NodeId, string>;
  /** Font size (world units) for labels. Default `10`. */
  readonly fontSize?: number;
}

/** Round to 2 decimals, trim, and fold `-0` → `0` for byte-stable output. */
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

/** XML-escape text content / attribute values. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function edgeKey(e: InducedEdge): string {
  return `${e.src}→${e.dst}→${e.kind}`;
}

/**
 * Render `result` (and its `edges`, for straight-line routing) to a normalized
 * SVG document string. Deterministic: identical inputs yield byte-identical
 * output.
 */
export function exportSvg(
  result: LayoutResult,
  edges: readonly InducedEdge[],
  opts: SvgOptions = {},
): string {
  const pad = opts.padding ?? 8;
  const fontSize = opts.fontSize ?? 10;
  const b = result.bounds;
  const vbX = b.x - pad;
  const vbY = b.y - pad;
  const vbW = b.width + 2 * pad;
  const vbH = b.height + 2 * pad;

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(vbW)}" height="${fmt(vbH)}" ` +
      `viewBox="${fmt(vbX)} ${fmt(vbY)} ${fmt(vbW)} ${fmt(vbH)}">`,
  );

  // --- edges (under nodes) ---------------------------------------------------
  const sortedEdges = [...edges].sort(
    (x, y) => compareStr(x.src, y.src) || compareStr(x.dst, y.dst) || compareStr(x.kind, y.kind),
  );
  lines.push('  <g class="edges" fill="none" stroke="#888" stroke-width="1">');
  for (const e of sortedEdges) {
    const key = edgeKey(e);
    const route: readonly Point[] | undefined = result.edgeRoutes?.get(key);
    if (route !== undefined && route.length >= 2) {
      const pts = route.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');
      lines.push(`    <polyline data-edge="${esc(key)}" points="${pts}" />`);
      continue;
    }
    const s = result.positions.get(e.src);
    const d = result.positions.get(e.dst);
    if (s === undefined || d === undefined) continue;
    const cs = centerOf(s);
    const cd = centerOf(d);
    lines.push(
      `    <line data-edge="${esc(key)}" x1="${fmt(cs.x)}" y1="${fmt(cs.y)}" x2="${fmt(cd.x)}" y2="${fmt(cd.y)}" />`,
    );
  }
  lines.push('  </g>');

  // --- nodes -----------------------------------------------------------------
  const ids = [...result.positions.keys()].sort(compareStr);
  lines.push('  <g class="nodes" fill="#e8eef7" stroke="#33517a" stroke-width="1">');
  for (const id of ids) {
    const r: Rect = result.positions.get(id)!;
    lines.push(
      `    <rect data-id="${esc(id)}" x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.width)}" height="${fmt(r.height)}" />`,
    );
    const label = opts.labels?.get(id);
    if (label !== undefined && label.length > 0) {
      const c = centerOf(r);
      lines.push(
        `    <text x="${fmt(c.x)}" y="${fmt(c.y)}" font-size="${fmt(fontSize)}" ` +
          `text-anchor="middle" dominant-baseline="central" fill="#1a2a44" stroke="none">${esc(label)}</text>`,
      );
    }
  }
  lines.push('  </g>');

  lines.push('</svg>');
  return lines.join('\n') + '\n';
}
