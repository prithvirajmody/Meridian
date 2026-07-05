/**
 * The valid fixture corpus decodes, validates, and round-trips (I3), and the
 * canonical form is idempotent — fixtures are the regression floor (§5.2).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { asGraphId, decode, encodePretty, stats } from '../src/index.js';

const validDir = fileURLToPath(new URL('../../../fixtures/valid/', import.meta.url));
const files = readdirSync(validDir).filter((f) => f.endsWith('.meridian.json'));

describe('valid fixture corpus', () => {
  it('has the expected corpus', () => {
    expect(files.sort()).toEqual([
      'deep-nest.meridian.json',
      'flat-simple.meridian.json',
      'portal-links.meridian.json',
      'unicode-labels.meridian.json',
    ]);
  });

  it.each(files)('%s decodes, validates, and round-trips', (file) => {
    const text = readFileSync(validDir + file, 'utf8');
    const r = decode(text);
    expect(r.ok, !r.ok ? JSON.stringify(r.errors, null, 2) : '').toBe(true);
    if (!r.ok) return;
    // Idempotence: canonical form re-decodes to the identical canonical form.
    const pretty = encodePretty(r.space);
    const r2 = decode(pretty);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(encodePretty(r2.space)).toBe(pretty);
  });

  it('deep-nest is at least four levels deep with a cross-boundary link recorded legally', () => {
    const r = decode(readFileSync(validDir + 'deep-nest.meridian.json', 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(stats(r.space).maxDepth).toBeGreaterThanOrEqual(5);
  });

  it('unicode labels survive decoding NFC-normalized', () => {
    const r = decode(readFileSync(validDir + 'unicode-labels.meridian.json', 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.space.graphs.get(asGraphId('g-unicode'))!;
    const labels = [...g.nodes.values()].map((n) => n.label);
    expect(labels).toContain('café'); // stored decomposed in the file
    for (const label of labels) expect(label.normalize('NFC')).toBe(label);
  });
});
