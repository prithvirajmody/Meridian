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

**Phases 0–2 built, gates green; ADR review pending.** ADR-0001…0011 are
drafted ([docs/adr/](docs/adr/), status *Proposed* — human review pending).
In place: the monorepo; `@meridian/graph-core` (model, IDs, validation,
codec) with the Phase 2 U8 vocabulary gate; `@meridian/graph-store` (op-based
deltas, the one write path); the plugin boundary — `@meridian/plugin-api`
(versioned contract), `@meridian/plugin-host` (registry, arbitration,
isolation), `@meridian/conformance-kit` (executable adapter law) — and the
first domain adapter, `@meridian/adapter-markdown`; the `meridian` CLI
(`validate` · `stats` · `inspect` · `mutate` · `invert` · `watch` · `ingest`
· `plugins list`); fixtures, corpora, goldens, and perf budgets as CI gates.

```
pnpm install
pnpm test                # unit + property + failure + golden + conformance suites
pnpm run ci              # lint · typecheck · depcruise · string audit · build · test · bench
pnpm meridian ingest fixtures/corpora/markdown/links.md
```

(Use `pnpm run ci` — bare `pnpm ci` is pnpm's own clean-install command, not
this script.)

Golden files change only via `pnpm goldens:update` (reviewed), never by
hand. Finalized decisions live as ADRs in [docs/adr/](docs/adr/) — a
decision without a merged ADR is not finalized.
