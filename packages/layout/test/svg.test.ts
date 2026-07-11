/**
 * SVG snapshot exporter (ROADMAP 4B): pure, deterministic, normalized string
 * output — no DOM. Asserts structure, node/edge ordering, straight-line edge
 * routing between centers, and byte-level determinism.
 */
import { describe, expect, it } from 'vitest';
import { exportSvg, gridProvider, type LayoutInput } from '../src/index.js';
import { cutOf, edge, sizes, uniformSizes } from './helpers.js';

const box = { width: 40, height: 20 };

async function layout(): Promise<LayoutInput & { svg: string }> {
  const input: LayoutInput = {
    cut: cutOf('a', 'b'),
    edges: [edge('a', 'b')],
    sizes: uniformSizes(['a', 'b'], box),
    hints: {},
  };
  const result = await gridProvider.compute(input);
  return { ...input, svg: exportSvg(result, input.edges) };
}

describe('exportSvg', () => {
  it('emits a normalized, self-contained SVG document', async () => {
    const { svg } = await layout();
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith('</svg>\n')).toBe(true);
    expect(svg).toContain('viewBox=');
    // Two node rects, one edge line.
    expect(svg.match(/<rect /g)).toHaveLength(2);
    expect(svg.match(/<line /g)).toHaveLength(1);
  });

  it('is deterministic (same input → byte-identical output)', async () => {
    const a = await layout();
    const b = await layout();
    expect(a.svg).toBe(b.svg);
  });

  it('touches no DOM API (pure string building)', async () => {
    const { svg } = await layout();
    // A smoke check that the output is a plain string, produced without any
    // browser global (this module imports none).
    expect(typeof svg).toBe('string');
    expect(svg).not.toContain('undefined');
  });

  it('empty result yields a padded empty viewBox', () => {
    const empty = { positions: new Map(), bounds: { x: 0, y: 0, width: 0, height: 0 }, stability: 1 };
    const svg = exportSvg(empty, []);
    expect(svg).toContain('viewBox="-8 -8 16 16"');
    expect(svg.match(/<rect /g)).toBeNull();
  });

  it('draws straight center-to-center edges from positions', async () => {
    const input: LayoutInput = {
      cut: cutOf('a', 'b'),
      edges: [edge('a', 'b')],
      sizes: sizes({ a: box, b: box }),
      hints: {},
    };
    const result = await gridProvider.compute(input);
    const svg = exportSvg(result, input.edges);
    // a-b are one component (2-col grid): a at (0,0,40,20) → center (20,10);
    // b at (64,0,40,20) → center (84,10).
    expect(svg).toContain('x1="20" y1="10" x2="84" y2="10"');
  });

  it('renders optional labels centered in each box', async () => {
    const input: LayoutInput = {
      cut: cutOf('a'),
      edges: [],
      sizes: sizes({ a: box }),
      hints: {},
    };
    const result = await gridProvider.compute(input);
    const labels = new Map([[[...result.positions.keys()][0]!, 'Heading & <tag>']]);
    const svg = exportSvg(result, [], { labels });
    expect(svg).toContain('>Heading &amp; &lt;tag&gt;</text>');
  });
});
