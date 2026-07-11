import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { meridianAtlasCodePoints } from '../src/labels/atlas-manifest.js';

/**
 * Guards ADR-0020's reproducibility contract: the baked MSDF atlas must contain
 * exactly the code points the coverage manifest promises. Drift here means the
 * `labelRenderKind` router would send covered glyphs to the fallback (or route
 * tofu to bitmap), so the checked-in `.fnt` and the manifest are pinned together.
 */
describe('MSDF atlas coverage matches the manifest', () => {
  it('bakes exactly the manifest code points', async () => {
    const fnt = await readFile(
      fileURLToPath(new URL('../assets/fonts/meridian-msdf.fnt', import.meta.url)),
      'utf8',
    );
    const baked = new Set<number>();
    for (const match of fnt.matchAll(/<char id="(\d+)"/g)) {
      baked.add(Number.parseInt(match[1]!, 10));
    }
    const expected = new Set(meridianAtlasCodePoints());
    const missing = [...expected].filter((cp) => !baked.has(cp)).sort((a, b) => a - b);
    const extra = [...baked].filter((cp) => !expected.has(cp)).sort((a, b) => a - b);
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('declares the MSDF distance field', async () => {
    const fnt = await readFile(
      fileURLToPath(new URL('../assets/fonts/meridian-msdf.fnt', import.meta.url)),
      'utf8',
    );
    expect(fnt).toMatch(/fieldType="msdf"/);
    expect(fnt).toMatch(/file="meridian-msdf\.png"/);
  });
});
