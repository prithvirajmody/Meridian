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
      name: 'graph-store-only-graph-core',
      severity: 'error',
      comment:
        'graph-store imports only graph-core (§20; ROADMAP Phase 1 §12) — no zod, no domain, no presentation.',
      from: { path: '^packages/graph-store/src' },
      to: {
        pathNot: '^packages/graph-store/src|^packages/graph-core',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'graph-store-no-node-builtins',
      severity: 'error',
      comment:
        'graph-store stays isomorphic (browser + workers + Node): no node:* imports.',
      from: { path: '^packages/graph-store/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'abstraction-only-core-and-store',
      severity: 'error',
      comment:
        'abstraction imports graph-core and graph-store only (§20; ROADMAP Phase 3 §12) — no domain, no presentation, no AI, not even plugin-api.',
      from: { path: '^packages/abstraction/src' },
      to: {
        pathNot: '^packages/abstraction/src|^packages/graph-core|^packages/graph-store',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'abstraction-no-node-builtins',
      severity: 'error',
      comment:
        'abstraction stays isomorphic (browser + workers + Node): no node:* imports.',
      from: { path: '^packages/abstraction/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'view-model-only-semantic-types',
      severity: 'error',
      comment:
        'view-model is the pure presentation waist: abstraction plus a direct graph-core TYPE edge approved in ADR-0022. No graph-store, layout, renderer, DOM framework, or I/O dependency.',
      from: { path: '^packages/view-model/src' },
      to: {
        pathNot: '^packages/view-model/src|^packages/abstraction|^packages/graph-core',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'view-model-graph-core-type-only',
      severity: 'error',
      comment: 'ADR-0022 permits view-model → graph-core for types only; no runtime core call.',
      from: { path: '^packages/view-model/src' },
      to: { path: '^packages/graph-core', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'view-model-no-node-builtins',
      severity: 'error',
      comment: 'view-model stays pure/isomorphic: no node:* imports.',
      from: { path: '^packages/view-model/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'layout-only-view-model-and-engines',
      severity: 'error',
      comment:
        'ADR-0015/0022 permanent topology: layout imports Meridian contracts through @meridian/view-model only, plus comlink/elkjs/d3-force. No DOM, domain, AI, plugin-api, abstraction, or graph-core edge.',
      from: { path: '^packages/layout/src' },
      to: {
        pathNot:
          '^packages/layout/src|^packages/view-model|^node_modules/(\\.pnpm/)?comlink|^node_modules/(\\.pnpm/)?elkjs|^node_modules/(\\.pnpm/)?d3-force',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'layout-no-direct-semantic-core',
      severity: 'error',
      comment:
        '5B closed the time-boxed waypoint: layout may not import graph-core, graph-store, or abstraction even as types; use view-model re-exports.',
      from: { path: '^packages/layout/src' },
      to: { path: '^packages/(graph-core|graph-store|abstraction)' },
    },
    {
      name: 'layout-no-node-builtins',
      severity: 'error',
      comment: 'layout stays isomorphic (browser + workers + Node): no node:* imports.',
      from: { path: '^packages/layout/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'plugin-api-types-only',
      severity: 'error',
      comment:
        'plugin-api is the versioned contract: types + descriptors only; its single allowed dependency edge, graph-core, must stay type-only (§20; ADR-0011).',
      from: { path: '^packages/plugin-api/src' },
      to: {
        pathNot: '^packages/plugin-api/src',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'plugin-host-only-plugin-api',
      severity: 'error',
      comment:
        'plugin-host registers, validates, resolves, isolates — through the contract only: plugin-api + zod, nothing else (§20).',
      from: { path: '^packages/plugin-host/src' },
      to: {
        pathNot:
          '^packages/plugin-host/src|^packages/plugin-api|^node_modules/(\\.pnpm/)?zod',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'plugin-host-no-node-builtins',
      severity: 'error',
      comment: 'plugin-host stays isomorphic (browser + workers + Node): no node:* imports.',
      from: { path: '^packages/plugin-host/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'conformance-kit-only-contract-and-core',
      severity: 'error',
      comment:
        'conformance-kit tests the contract: plugin-api + graph-core + vitest (§20). Node builtins allowed — it is a test harness.',
      from: { path: '^packages/conformance-kit/src' },
      to: {
        pathNot:
          '^packages/conformance-kit/src|^packages/plugin-api|^packages/graph-core|^node_modules/(\\.pnpm/)?(vitest|@vitest)',
        dependencyTypesNot: ['type-only', 'core'],
      },
    },
    {
      name: 'adapters-see-only-plugin-api',
      severity: 'error',
      comment:
        'adapters and all third-party plugins see only plugin-api; importing any other Meridian package (or another adapter) breaks the hourglass (§20).',
      from: { path: '^packages/adapters/([^/]+)/src' },
      to: { path: '^packages/', pathNot: '^packages/adapters/$1/src|^packages/plugin-api' },
    },
    {
      name: 'adapters-no-node-builtins',
      severity: 'error',
      comment: 'adapters stay isomorphic (browser + workers + Node): no node:* imports.',
      from: { path: '^packages/adapters/[^/]+/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'core-never-sees-plugins',
      severity: 'error',
      comment:
        'graph-core/graph-store/abstraction may not import plugin-* or any adapter (ROADMAP Phase 2 §12, Phase 3 §12) — domain logic cannot leak into the core, not even as types.',
      from: { path: '^packages/(graph-core|graph-store|abstraction)/src' },
      to: { path: '^packages/(plugin-api|plugin-host|conformance-kit|adapters)' },
    },
    {
      name: 'cli-sees-only-core-packages',
      severity: 'error',
      comment:
        'apps depend downward; cli is the composition root: graph-core, graph-store, abstraction, layout, plugin-api, plugin-host, and built-in adapters (Phase 2/3/4).',
      from: { path: '^apps/cli/src' },
      to: {
        path: '^packages/',
        pathNot:
          '^packages/(graph-core|graph-store|abstraction|layout|plugin-api|plugin-host|adapters/markdown)',
      },
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
