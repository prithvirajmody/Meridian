# Contributing

Meridian is a personal project. Issues and pull requests are welcome, but
there is no promised review time.

## Before you open a pull request

1. Install with `pnpm install` (Node.js 24, pnpm 11).
2. Run the full gate with `pnpm run ci`, not bare `pnpm ci`. It runs lint,
   type checks, dependency rules, the domain-word audit, the build, tests,
   evals, browser tests, and benchmarks. The browser tests need Playwright's
   Chromium: `pnpm --filter @meridian/studio exec playwright install chromium`.
3. Never edit golden files by hand. Regenerate CLI goldens with
   `pnpm goldens:update:cli` and screenshot goldens with
   `pnpm goldens:update:ui:docker` (needs Docker), then review the diff as a
   contract change. Screenshots rendered on a desktop use its fonts and will
   not match CI; compare with `pnpm goldens:check:ui:docker` instead.

## Ground rules

The working rules are in [CLAUDE.md](CLAUDE.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

- All mutation goes through op-based deltas. There is one write path.
- `graph-core`, `graph-store`, and `abstraction` contain no domain words, no
  DOM, and no AI imports. `pnpm depcruise` and `pnpm audit:strings` check this.
- A design decision the docs leave open gets an ADR draft in `docs/adr/`
  before any code.

## License

By contributing, you agree that your contribution is licensed under the
[MIT license](LICENSE).
