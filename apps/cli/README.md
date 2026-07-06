# @meridian/cli

**Responsibility.** The headless driver (`meridian`): proves the semantic
core end-to-end with no pixels. It is the composition root (§20) — a thin
presentation layer over the packages' pure functions; no semantic
computation and no domain knowledge lives here. All output is deterministic
(I6); `--json` is stable for scripting.

**Public API entry point.** The `meridian` binary (`src/main.ts`). This
package exports no library API.

**Forbidden imports.** Anything except `@meridian/graph-core`,
`@meridian/graph-store`, `@meridian/abstraction`, `@meridian/plugin-api`,
`@meridian/plugin-host`, built-in adapters, and Node builtins (enforced by
dependency-cruiser `cli-sees-only-core-packages`).

```
meridian validate <file> [--json]              # exit 0 ok · 1 invalid · 2 usage/I-O
meridian stats <file> [--json]
meridian inspect <file> <nodeId> [--json]
meridian mutate <file> --script <ops.json> [--out <f>] [--emit-delta <f>] [--json]
meridian invert <delta.json>
meridian watch <file> [--apply <ops.json>,…] [--json]
meridian cut <file> (--level <N> | --zoom <z>) [--focus <id>] [--json]
meridian ingest <source> [--adapter <domain>] [--out <f>] [--json]
meridian plugins list [--json]
```

`cut` (Phase 3) resolves the visible antichain of a document at a base level
(`--level N`, 0 = coarsest) or a zoom scalar (`--zoom z ∈ [0,1]`, 1 =
finest; ADR-0012) through the real pipeline — document → `GraphSpace` →
default level chain → `resolveLod` — and prints the covering node set plus
induced (aggregated) edges (ADR-0013). `--focus` is recorded in the cut
trace (inert for the mapping in v1).

Golden-file tests in `test/golden.test.ts` and `test/cut-golden.test.ts` pin
every output byte against `fixtures/goldens/cli/`. Goldens change only via
`pnpm goldens:update` (ROADMAP §5.2 — an explicit, reviewed regeneration),
never by hand. The cut goldens' *inputs* are themselves produced by the real
`meridian ingest` into the gitignored `fixtures/.cut-inputs/` on every run —
ingest is byte-deterministic, so the derived goldens are stable.
