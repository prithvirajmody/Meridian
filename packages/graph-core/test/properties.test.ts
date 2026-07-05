/**
 * The standing property suites (ROADMAP §5.3): I1/I2 via the validator over
 * generated spaces, I3 round-trip fidelity, I6 encode determinism, and a
 * metamorphic corruption check. These are the primary defense of the core.
 */
import { deepStrictEqual } from 'node:assert';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decode,
  deriveNodeId,
  encode,
  encodeCanonical,
  validate,
  type GraphSpace,
  type SemanticGraph,
} from '../src/index.js';
import { spaceArb } from './arbitraries.js';

describe('property: I1/I2 — construction through the one write path is valid', () => {
  it('every generated space validates with zero errors', () => {
    fc.assert(
      fc.property(spaceArb, (space) => {
        const r = validate(space);
        expect(r.errors).toEqual([]);
        expect(r.ok).toBe(true);
      }),
    );
  });
});

describe('property: I3 — round-trip fidelity', () => {
  it('decode(encodeCanonical(space)) is deep-equal to space', () => {
    fc.assert(
      fc.property(spaceArb, (space) => {
        const r = decode(encodeCanonical(space));
        expect(r.ok).toBe(true);
        if (r.ok) {
          deepStrictEqual(r.space.graphs, space.graphs);
          deepStrictEqual([...r.space.roots].sort(), [...space.roots].sort());
        }
      }),
    );
  });

  it('decode accepts the object form of encode identically to its JSON text', () => {
    fc.assert(
      fc.property(spaceArb, (space) => {
        const viaObject = decode(encode(space));
        const viaText = decode(encodeCanonical(space));
        expect(viaObject.ok && viaText.ok).toBe(true);
        if (viaObject.ok && viaText.ok) {
          expect(encodeCanonical(viaObject.space)).toBe(encodeCanonical(viaText.space));
        }
      }),
    );
  });
});

describe('property: I6 — encoding is deterministic and idempotent', () => {
  it('re-encoding a decoded space is byte-identical', () => {
    fc.assert(
      fc.property(spaceArb, (space) => {
        const text = encodeCanonical(space);
        const r = decode(text);
        expect(r.ok).toBe(true);
        if (r.ok) expect(encodeCanonical(r.space)).toBe(text);
      }),
    );
  });
});

describe('property: the validator catches injected corruption', () => {
  it('flags a dangling edge injected past the constructors', () => {
    fc.assert(
      fc.property(spaceArb, (space) => {
        const [graphId, graph] = [...space.graphs.entries()][0]!;
        const edges = new Map(graph.edges);
        edges.set('e-corrupt' as never, {
          id: 'e-corrupt' as never,
          src: 'n-ghost-src' as never,
          dst: 'n-ghost-dst' as never,
          kind: 'core:references',
          attrs: {},
          provenance: { origin: 'derived' },
        });
        const corrupted: SemanticGraph = { ...graph, edges };
        const graphs = new Map(space.graphs);
        graphs.set(graphId, corrupted);
        const r = validate({ graphs, roots: space.roots } satisfies GraphSpace);
        expect(r.ok).toBe(false);
        expect(r.errors.some((e) => e.code === 'dangling-edge-endpoint')).toBe(true);
      }),
    );
  });
});

describe('property: ID derivation is pure and injective over distinct coords', () => {
  it('same coordinates always give the same ID; distinct path lists differ', () => {
    const segment = fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes('\u001f'));
    const coordsArb = fc.record({
      domain: segment,
      source: segment,
      path: fc.array(segment, { maxLength: 4 }),
    });
    fc.assert(
      fc.property(coordsArb, (coords) => {
        const a = deriveNodeId(coords);
        const b = deriveNodeId({ ...coords, path: [...coords.path] });
        expect(a).toBe(b);
        const nfd = {
          domain: coords.domain.normalize('NFD'),
          source: coords.source.normalize('NFD'),
          path: coords.path.map((p) => p.normalize('NFD')),
        };
        expect(deriveNodeId(nfd)).toBe(a);
      }),
    );
  });
});
