/**
 * Python import & call edges — hand-drawn truth (7E, ADR-0026; ROADMAP §12
 * Unit/Integration rows), mirroring edges.test.ts for Python's import forms:
 * `import a.b`, `from . import x`, `from .mod import name`, package
 * `__init__` resolution, absolute in-repo imports, bare/external; the three
 * call tiers with `self`/`cls`; unresolved honesty (member/dynamic/ambiguous/
 * legal-redefinition duplicates); weight collapsing + sampled spans;
 * confidence attr; byte-determinism with edges present.
 */
import { encodeCanonical } from '@meridian/graph-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { CodeMapper } from '../src/index.js';
import { ingestBundle } from './edge-support.js';
import { inProcessMapper } from './support.js';

const mapper: CodeMapper = inProcessMapper();
afterAll(() => mapper.dispose());

describe('Python — code:imports edges (lexical resolution)', () => {
  it('each import form resolves against the ingested tree; bare is external', async () => {
    const ing = await ingestBundle(mapper, [
      {
        path: 'pkg/main.py',
        text: [
          'import math', // bare absolute → external, no edge
          'from . import util', // package-relative submodule → pkg/util.py
          'from .util import add', // relative module member → pkg/util.py
          'from .sub import helpers', // submodule of a package → pkg/sub/helpers.py
          'from pkg.util import twice', // absolute in-repo → pkg/util.py
          'def run(n: int) -> int:',
          '    return add(n, n) + twice(n)',
        ].join('\n'),
      },
      { path: 'pkg/util.py', text: 'def add(a: int, b: int) -> int:\n    return a + b\ndef twice(n: int) -> int:\n    return add(n, n)\n' },
      { path: 'pkg/sub/helpers.py', text: 'def helper() -> int:\n    return 1\n' },
      { path: 'pkg/sub/__init__.py', text: '' },
      { path: 'pkg/__init__.py', text: '' },
    ]);

    // Three statements resolve to pkg/util.py → one module→module edge, weight 3.
    const toUtil = ing.edgesBetween('code:imports', 'main.py', 'util.py');
    expect(toUtil).toHaveLength(1);
    expect(toUtil[0]!.weight).toBe(3);
    expect(toUtil[0]!.attrs['code:confidence']).toBe('syntactic');

    // `from .sub import helpers` names a submodule → edge re-based main.py → sub.
    expect(ing.edgesBetween('code:imports', 'main.py', 'sub')).toHaveLength(1);

    // `import math` is external: counted on the module, no edge.
    expect(ing.edges.some((e) => e.kind === 'code:imports' && ing.label(e.dst) === 'math')).toBe(false);
    expect(ing.nodeByLabel('main.py').attrs['code:imports-external']).toBe(1);
  });

  it("a from-import of a package's name falls back to its __init__ declarations", async () => {
    const ing = await ingestBundle(mapper, [
      { path: 'shapes/__init__.py', text: 'def area(r: float) -> float:\n    return r * r\n' },
      { path: 'use.py', text: 'from shapes import area\ndef ring(r: float) -> float:\n    return area(r) - area(r / 2)\n' },
    ]);
    // `area` is not a submodule → binds to shapes/__init__.py's declaration;
    // the import edge re-bases at the project: use.py → shapes (the package).
    expect(ing.edgesBetween('code:imports', 'use.py', 'shapes')).toHaveLength(1);
    // And the two area(…) calls resolve tier-2 into the package → one edge, weight 2.
    const calls = ing.edgesBetween('code:calls', 'use.py', 'shapes');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.weight).toBe(2);
    expect(ing.countersOf('ring')).toEqual([{ resolved: 2, unresolved: 0, external: 0 }]);
  });
});

describe('Python — code:calls edges (the three tiers)', () => {
  const bundle = [
    {
      path: 'app/util.py',
      text: [
        'def add(a: int, b: int) -> int:',
        '    return a + b',
        'def twice(n: int) -> int:', // tier 1: local call below
        '    return add(n, n)',
        'def first(fns: list) -> int:', // dynamic: subscript callee
        '    return fns[0]()',
      ].join('\n'),
    },
    {
      path: 'app/models.py',
      text: [
        'class Box:',
        '    def __init__(self, v: int):',
        '        self.value = v',
        '    def get(self) -> int:',
        '        return self.value',
        '    def doubled(self) -> int:', // self ×2 → one edge, weight 2
        '        return self.get() + self.get()',
        '    @classmethod',
        '    def default(cls) -> "Box":', // cls call → tier 1 self
        '        return cls.make_default()',
        '    @staticmethod',
        '    def make_default() -> "Box":',
        '        return Box(0)', // tier 1: module-level class
        'def make() -> Box:',
        '    return Box(1)', // tier 1: class constructor
        'def redef(x: int) -> int:',
        '    return x',
        'def redef(x: int) -> int:', // legal redefinition: 2 candidates
        '    return x + 1',
        'def caller() -> int:',
        '    return redef(3)', // ambiguous → unresolved
      ].join('\n'),
    },
    {
      path: 'app/service.py',
      text: [
        'import json', // external
        'from . import util',
        'from .util import add, twice',
        'from .models import make',
        'def compute(a: int, b: int) -> int:',
        '    s = add(a, b)',
        '    return twice(s) + twice(s)', // tier 2 ×3 into util.py
        'def build():',
        '    return make()', // tier 2 into models.py
        'def dump(x) -> str:',
        '    return json.dumps(x)', // member call on a module object → unresolved
        'def indirect(n: int) -> int:',
        '    return util.twice(n)', // member call → unresolved (no type inference)
      ].join('\n'),
    },
    { path: 'app/__init__.py', text: '' },
  ];

  it('tier 1: local function, class constructor, and self/cls method calls', async () => {
    const ing = await ingestBundle(mapper, bundle);
    expect(ing.edgesBetween('code:calls', 'twice', 'add')).toHaveLength(1);
    expect(ing.countersOf('twice')).toEqual([{ resolved: 1, unresolved: 0, external: 0 }]);
    // make() → Box: a module-level class is a tier-1 callee.
    expect(ing.edgesBetween('code:calls', 'make', 'Box')).toHaveLength(1);
    // cls.make_default() resolves against the own class's members.
    expect(ing.edgesBetween('code:calls', 'default', 'make_default')).toHaveLength(1);
    // Box(0) inside a member of Box resolves (counter), but the portal rule
    // re-bases it to Box → Box — a link to one's own ancestor induces nothing,
    // so no edge object exists (same rule as markdown's ancestor self-links).
    expect(ing.edgesBetween('code:calls', 'make_default', 'Box')).toHaveLength(0);
    expect(ing.edgesBetween('code:calls', 'Box', 'Box')).toHaveLength(0);
    expect(ing.countersOf('make_default')).toEqual([{ resolved: 1, unresolved: 0, external: 0 }]);
  });

  it('tier 1 self: repeated self.method() collapses to ONE edge with weight and spans', async () => {
    const ing = await ingestBundle(mapper, bundle);
    const e = ing.edgesBetween('code:calls', 'doubled', 'get');
    expect(e).toHaveLength(1);
    expect(e[0]!.weight).toBe(2);
    expect((e[0]!.attrs['code:call-sites'] as string).split(',')).toHaveLength(2);
    expect(e[0]!.attrs['code:confidence']).toBe('syntactic');
    expect(ing.countersOf('doubled')).toEqual([{ resolved: 2, unresolved: 0, external: 0 }]);
  });

  it('tier 2: import-bound calls re-base to module→module edges; weights aggregate', async () => {
    const ing = await ingestBundle(mapper, bundle);
    const toUtil = ing.edgesBetween('code:calls', 'service.py', 'util.py');
    expect(toUtil).toHaveLength(1);
    expect(toUtil[0]!.weight).toBe(3); // add + twice + twice
    expect(ing.edgesBetween('code:calls', 'service.py', 'models.py')).toHaveLength(1);
    expect(ing.countersOf('compute')).toEqual([{ resolved: 3, unresolved: 0, external: 0 }]);
    expect(ing.countersOf('build')).toEqual([{ resolved: 1, unresolved: 0, external: 0 }]);
  });

  it('tier 3 honesty: member/dynamic/ambiguous calls are counted, never guessed', async () => {
    const ing = await ingestBundle(mapper, bundle);
    // json.dumps / util.twice: member calls on values of unknown type.
    expect(ing.countersOf('dump')).toEqual([{ resolved: 0, unresolved: 1, external: 0 }]);
    expect(ing.countersOf('indirect')).toEqual([{ resolved: 0, unresolved: 1, external: 0 }]);
    // fns[0](): dynamic callee.
    expect(ing.countersOf('first')).toEqual([{ resolved: 0, unresolved: 1, external: 0 }]);
    // redef(3): two legal same-name candidates → unresolved, never picked.
    expect(ing.countersOf('caller')).toEqual([{ resolved: 0, unresolved: 1, external: 0 }]);
    expect(ing.edges.some((e) => e.kind === 'code:calls' && ing.label(e.dst) === 'redef')).toBe(false);
    // No placeholder callee node was invented anywhere.
    expect([...ing.nodes.values()].every((n) => n.kind !== 'code:unresolved')).toBe(true);
  });

  it('every emitted edge carries confidence:syntactic and ingest is byte-deterministic', async () => {
    const a = await ingestBundle(mapper, bundle);
    for (const e of a.edges) expect(e.attrs['code:confidence']).toBe('syntactic');
    expect(a.edges.length).toBeGreaterThan(0);
    const b = await ingestBundle(mapper, bundle);
    expect(encodeCanonical(b.space)).toBe(encodeCanonical(a.space));
  });
});
