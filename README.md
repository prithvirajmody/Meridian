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

Pre–Phase 0. The repo currently contains only the governing documents and
standing instructions (`CLAUDE.md`). Next step per the operator's guide:

> Read docs/ARCHITECTURE.md fully, then docs/ROADMAP.md Phase 0. Begin the
> ADR beat: draft ADR-0001 through ADR-0004 into docs/adr/ and stop for my
> review. Do not scaffold the monorepo yet.

Finalized decisions live as ADRs in [docs/adr/](docs/adr/). A decision without
a merged ADR is not finalized.
