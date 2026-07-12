# @meridian/cli

## Unreleased — Phase 7H

- **Adapter options (ROADMAP Phase 7 §6)** on `ingest <dir>` and `watch <dir>`:
  `--include`/`--exclude` (comma-separated POSIX globs — `**`, `*`, `?` — over
  repo-relative paths; exclude wins) and `--lang` (allowlist: `typescript`,
  `python`). The CLI is the composition root: filtered files are never read
  (ADR-0027 as amended — user globs filter the walk; `code:excluded` stays for
  budget/size exclusions of walked files). The directory walk is symlink-safe
  (realpath visited-set; symlinks not followed), so cycles neither hang nor
  duplicate.

## Unreleased — Phase 7G

- **`watch <repo/>`** now recognises a directory as a source repo and follows
  it with the code adapter's incremental session (`IncrementalAdapter`): each
  file save is re-parsed into a **minimal** code delta (ADR-0028 — whitespace
  edits are no-ops), applied to a live store whose change events stream out.
  `--edits <script.json>` replays a recorded edit sequence and exits
  (deterministic, for scripts/tests); without it, `fs.watch` follows the tree
  live. A file argument still means the Phase-1 GraphDocument follower.

## Unreleased — Phase 3E

- **Phase 3:** `cut <file> (--level <N> | --zoom <z>) [--focus <id>]
  [--json]` — resolves the visible cut through the real pipeline (document →
  `GraphSpace` → default level chain → `resolveLod`): covering node set with
  per-node trace reasons, induced (aggregated) edges with witness samples
  and the labeled fan-out cap, frontier, and coverage proof. `--level` maps
  to the band center of a canonical evenly-spaced `ZoomPolicy`, so both
  flags route through the same resolver path. Deterministic output (I6);
  exit contract unchanged (0 ok · 1 invalid input · 2 usage). New goldens:
  `cut.*` across the markdown corpus at every level
  (`test/cut-golden.test.ts`); provider proposal → real store → cut
  integration (`test/proposal-cut.test.ts`).

## 0.1.0 — 2026-07-05 (Phases 0–2)

- **Phase 0:** `validate`, `stats`, `inspect`.
- **Phase 1:** `mutate --script/--out/--emit-delta`, `invert`, `watch
  [--apply]`.
- **Phase 2:** `ingest <source> [--adapter] [--out]` (composition root:
  injects graph-core ID derivation into the plugin host, registers built-in
  Tier 0 plugins, runs the IR gate with the registered vocabulary) and
  `plugins list`.
