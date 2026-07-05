# Meridian

A domain-blind semantic graph platform: many domains flow in through parsers,
many visualizations flow out through projections, and the narrow waist is a
single Universal Semantic Graph. See the governing documents:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the architectural constitution
  (*what* and *why*; wins all conflicts)
- [docs/ROADMAP.md](docs/ROADMAP.md) — the phased implementation plan (*when*;
  per-phase specs, verification tables, Definitions of Done)
- [docs/DRIVING-OPUS.md](docs/DRIVING-OPUS.md) — operator's guide for
  implementing the roadmap with Claude Opus 4.8 in Claude Code

## Status

**Phase 0 build complete, gate not yet closed.** ADR-0001…0004 are drafted
([docs/adr/](docs/adr/), status *Proposed* — human review pending). The
monorepo, `@meridian/graph-core`, the `meridian` CLI, the fixture corpus,
and the full verification harness are in place and green.

```
pnpm install
pnpm test                # unit + property + failure + golden suites
pnpm ci                  # lint · typecheck · depcruise · build · test · bench
pnpm meridian validate fixtures/valid/deep-nest.meridian.json
```

Golden files change only via `pnpm goldens:update` (reviewed), never by
hand. Finalized decisions live as ADRs in [docs/adr/](docs/adr/) — a
decision without a merged ADR is not finalized.
