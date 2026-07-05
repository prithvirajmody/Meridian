/**
 * Dependency law (ARCHITECTURE.md §20): arrows are exhaustive, direction is
 * strictly downward, graph-core imports nothing but zod. A new edge in the
 * dependency graph is a reviewed, deliberate act — extend these rules in the
 * same change that adds the package.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No cycles, ever — a cycle is a merged charter (§20).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'graph-core-only-zod',
      severity: 'error',
      comment: 'graph-core imports nothing but zod (ROADMAP Phase 0 §11; §20).',
      from: { path: '^packages/graph-core/src' },
      to: {
        pathNot: '^packages/graph-core/src|^node_modules/(\\.pnpm/)?zod',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'graph-core-no-node-builtins',
      severity: 'error',
      comment:
        'graph-core stays isomorphic (browser + workers + Node): no node:* imports.',
      from: { path: '^packages/graph-core/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'cli-sees-only-graph-core',
      severity: 'error',
      comment: 'apps depend downward; cli may use graph-core only (Phase 0).',
      from: { path: '^apps/cli/src' },
      to: { path: '^packages/', pathNot: '^packages/graph-core' },
    },
    {
      name: 'src-never-imports-tests',
      severity: 'error',
      from: { path: '/src/' },
      to: { path: '/(test|tests)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default', 'types'],
    },
  },
};
