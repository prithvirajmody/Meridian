/**
 * Level chains: the default containment-depth chain (a domain declaring
 * nothing) and a manifest-declared chain (names + count used verbatim).
 */
import { describe, expect, it } from 'vitest';
import { buildLevelChain } from '../src/level-chain.js';
import { emptySpace, laddderSpace, singleNodeSpace } from './fixtures.js';

describe('buildLevelChain — default containment-depth chain', () => {
  it('one level per distinct depth, named level-0..N, domain from the root', () => {
    // ladder: n0 (depth 0) → n1 (depth 1) → n2 (depth 2, leaf) ⇒ 3 levels.
    const chain = buildLevelChain(laddderSpace());
    expect(chain.depth).toBe(3);
    expect(chain.levels.map((l) => l.name)).toEqual(['level-0', 'level-1', 'level-2']);
    expect(chain.levels.map((l) => l.index)).toEqual([0, 1, 2]);
    expect(chain.domain).toBe('doc');
  });

  it('single-node space ⇒ one level', () => {
    const chain = buildLevelChain(singleNodeSpace());
    expect(chain.depth).toBe(1);
    expect(chain.levels).toEqual([{ index: 0, name: 'level-0' }]);
  });

  it('empty space ⇒ zero levels, fallback domain', () => {
    const chain = buildLevelChain(emptySpace());
    expect(chain.depth).toBe(0);
    expect(chain.levels).toEqual([]);
    expect(chain.domain).toBe('core');
  });
});

describe('buildLevelChain — declared spec', () => {
  it('uses the declared names and count verbatim, ignoring forest depth', () => {
    const chain = buildLevelChain(laddderSpace(), {
      domain: 'markdown',
      levels: [{ name: 'document' }, { name: 'section' }],
    });
    expect(chain.domain).toBe('markdown');
    expect(chain.depth).toBe(2);
    expect(chain.levels).toEqual([
      { index: 0, name: 'document' },
      { index: 1, name: 'section' },
    ]);
  });
});
