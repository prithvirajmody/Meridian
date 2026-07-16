/**
 * The full golden corpus against the sqlite backend (SUBPHASES 11B: "full
 * golden corpus passes"): every valid fixture survives
 * document → project file → reopen → document byte-identically, and a
 * mutate + invert cycle through the durable store restores the bytes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decode, encodePretty, type GraphSpace } from '@meridian/graph-core';
import { invertDelta } from '@meridian/graph-store';
import { openProject, openProjectStore } from '../src/node/index.js';
import { addGraphDelta, tmpProjectPath } from './helpers.js';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/valid');
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.meridian.json'));

describe.each(files)('golden corpus via sqlite backend: %s', (file) => {
  const text = readFileSync(join(FIXTURES, file), 'utf8');

  function spaceOf(): GraphSpace {
    const decoded = decode(text);
    if (!decoded.ok) throw new Error(`fixture ${file} failed decode`);
    return decoded.space;
  }

  // The canonical-rendering byte-identity idiom of graph-store's
  // fixtures.test.ts, now across the persistence boundary.
  it('import → close → reopen → encodePretty is byte-identical', async () => {
    const path = tmpProjectPath();
    const created = await openProject(path, { initialSpace: spaceOf() });
    await created.close();

    const reopened = await openProject(path);
    expect(encodePretty(reopened.space)).toBe(encodePretty(spaceOf()));
    await reopened.close();
  });

  it('durable mutate + invert restores the original bytes across reopen', async () => {
    const path = tmpProjectPath();
    const created = await openProject(path, { initialSpace: spaceOf() });
    await created.close();

    {
      const { project, store } = await openProjectStore(path);
      const applied = store.apply(addGraphDelta(1, 'roundtrip'));
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        const undone = store.apply(invertDelta(applied.delta));
        expect(undone.ok).toBe(true);
      }
      await project.close();
    }

    const reopened = await openProject(path);
    expect(reopened.version.counter).toBe(2); // two durable commits happened
    expect(encodePretty(reopened.space)).toBe(encodePretty(spaceOf()));
    await reopened.close();
  });
});
