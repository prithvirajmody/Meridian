# @meridian/cli

**Responsibility.** The headless driver (`meridian`): proves the semantic
core end-to-end with no pixels. Phase 0 commands: `validate`, `stats`,
`inspect`. All output is deterministic; `--json` is stable for scripting.

**Public API entry point.** The `meridian` binary (`src/main.ts`). This
package exports no library API.

**Forbidden imports.** Anything except `@meridian/graph-core` and Node
builtins (enforced by dependency-cruiser `cli-sees-only-graph-core`).

```
meridian validate <file> [--json]     # exit 0 valid · 1 invalid · 2 usage/I-O
meridian stats <file> [--json]
meridian inspect <file> <nodeId> [--json]
```

Golden-file tests in `test/golden.test.ts` pin every output byte against
`fixtures/goldens/cli/`. Goldens change only via `pnpm goldens:update`
(ROADMAP §5.2 — an explicit, reviewed regeneration), never by hand.
