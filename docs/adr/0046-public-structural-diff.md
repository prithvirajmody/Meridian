# ADR-0046 — Public deterministic structural diff for bridge-v1

- **Status:** Accepted
- **Date:** 2026-07-19
- **Phase:** AutoBuild integration Milestone C2 / roadmap Phase 4C
- **Constitution:** ARCHITECTURE.md P1, P4, P5, P7, P10, P12; §3.3, §6, §15.4, §17, §20; ADR-0004, ADR-0009
- **Integration contract:** `contracts/bridge-v1/`; AutoBuild `ROADMAP.md` Phase 4; `docs/plans/integration/milestone-C-architecture-eye.md`
- **Numbering:** ADR-0041…0044 remain reserved by Meridian roadmap Phase 12; this integration uses the next free number

## Context

AutoBuild needs a machine-readable answer to “what changed structurally between
these two pinned repository snapshots?” Meridian already owns graph identity and
the `diffSpaces` semantic diff engine, but it does not expose that capability as
a stable CLI producer. Consumers must not infer architecture changes from text
diffs, duplicate Meridian's identity rules, or treat “different” as an execution
failure.

Bridge-v1 fixes the transport envelope, operation vocabulary, summary, and
artifact integrity rules. This ADR defines how Meridian maps its existing
semantic result into that neutral contract without creating a second diff
algorithm or leaking plugin-specific internals across the boundary.

## Decision

### 1. Expose `diffSpaces` through one public CLI command

The CLI adds:

```text
meridian diff <from-graph.json> <to-graph.json> [--json]
meridian diff <from-graph.json> <to-graph.json>
  --delta-out <structural-delta.json> --descriptor <diff-artifact.json>
```

Both inputs are decoded through the public graph codec and compared only with
`diffSpaces`. The command does not implement an alternate comparison path and
does not load source repositories or adapters. Human output remains concise;
`--json` emits the same deterministic summary data used by artifact mode.

Supplying either `--delta-out` or `--descriptor` requires both. Artifact mode
also requires both documents to contain the accepted source provenance from
ADR-0045. The descriptor's `from` and `to` blocks are copied from those decoded
pins, then checked against the delta endpoints before any completion marker is
written.

### 2. Map semantic changes to the shared replayable delta

The delta conforms to
`contracts/bridge-v1/schemas/structural-delta.schema.json`:

```ts
interface StructuralDelta {
  schema_version: 1;
  kind: "meridian-structural-delta";
  from: { repo: string; ref: string };
  to: { repo: string; ref: string };
  origin: { actor: "meridian:diff" };
  ops: BridgeOperation[];
}
```

The operation list uses exactly the bridge-v1 nine-operation vocabulary and
preserves `diffSpaces`' deterministic, replay-safe phase ordering. Stable
identifiers and full before/after values come from `diffSpaces`; no timestamps,
cwd values, temporary paths, or random identifiers enter the result. A node
rename is represented as remove + add because stable identity changed. Edge
identity changes follow the same rule.

The delta must be replayable: applying every operation in order to the decoded
from-space must produce the decoded to-space exactly. Meridian runs this replay
check before publishing artifact mode output. This is a producer invariant;
AutoBuild independently repeats it at the consumer boundary.

### 3. Derive one deterministic summary from the delta

The descriptor summary is derived from the final operation list rather than a
parallel traversal:

- `nodes_added`, `nodes_removed`, `edges_added`, and `edges_removed` count their
  corresponding operations.
- `nodes_moved` counts stable nodes whose owning `(parent graph, node)` relation
  changes between spaces. A rename is not a move because it has no stable node
  identity across the pair.
- `by_kind` is a sorted mapping from added/removed node or edge wire kind to its
  `{added, removed}` counts. Attribute, metadata, and detail operations remain
  fully present in the raw delta but do not invent extra v1 summary fields.

This same in-memory summary drives human output, `--json`, and the
`diff-artifact` descriptor. The descriptor records the delta filename, exact
byte size, SHA-256, endpoint pins, graph format versions, and
`{meridian_version, diff_engine, diff_engine_version}`. Artifact mode writes
canonical minified UTF-8 delta bytes first and the descriptor last. The files
must share a directory, so the descriptor contains only a canonical safe
filename.

### 4. Define whitespace and exit-code semantics

The command promises semantic rather than textual comparison. Whitespace-only
source edits yield an empty structural delta only when the selected adapters
produce identical spaces. If an adapter intentionally preserves a whitespace
change in semantic fields or provenance, Meridian reports that change honestly;
the CLI does not erase it after ingestion.

Exit status is part of the public interface:

- `0`: inputs are valid and structurally identical;
- `1`: inputs are valid and structurally different (successful data result);
- `2`: usage error, invalid document, contract failure, or I/O failure.

The difference exit is therefore usable in scripts without conflating a found
change with a crash. Diagnostics go to stderr; machine JSON/delta output is not
mixed with diagnostics.

### 5. Keep production neutral and policy-free

Meridian may compare pins from different absolute repository URIs. It records
the exact endpoints and produces facts; it does not decide whether a cross-repo
comparison is allowed, whether removals exceed a threshold, or whether a public
module may disappear. Those are AutoBuild consumer policies. Meridian enforces
only schema validity, internal agreement, deterministic encoding, and replay.

## Alternatives considered

- **Text or Git diff in the CLI.** Rejected: it duplicates source tooling and
  cannot express architecture semantics or stable graph identity.
- **A new bridge-specific diff engine.** Rejected: two semantic engines would
  drift and violate the one-core rule.
- **Non-replayable summary only.** Rejected: consumers could not audit the
  evidence or reconstruct the claimed target graph.
- **Treat exit 1 as failure.** Rejected: a difference is the command's expected
  successful result and must remain distinguishable from invalid evidence.
- **Suppress all whitespace-derived changes.** Rejected: that could discard
  provenance or adapter-defined semantics and make the output dishonest.
- **Apply AutoBuild policy in Meridian.** Rejected: Meridian produces neutral
  facts; orchestration-specific acceptance belongs at the consumer boundary.

## Tradeoffs and consequences

The CLI gains a stable public surface and a contract mapping layer, while the
semantic core remains the single source of truth. Replay validation costs an
extra in-memory pass but turns producer bugs into local failures rather than
trusted bad evidence. Exit code 1 requires callers to opt into the documented
three-way interpretation instead of relying on generic zero/non-zero handling.

## Verification required after acceptance

- Identical inputs produce an empty replayable delta and exit 0.
- Every operation family has a deterministic golden test; reordered source JSON
  still produces identical canonical artifacts.
- A real semantic change exits 1 while producing valid JSON/artifacts; malformed
  input, unsafe paths, missing provenance, and endpoint mismatch exit 2.
- Rename is remove + add; stable reparenting increments `nodes_moved` once;
  attribute-only edits remain in the delta without changing add/remove counts.
- Adapter-ignored whitespace produces an empty delta, while provenance-changing
  whitespace remains visible.
- Applying the delta to the from-space reproduces the to-space exactly, and the
  output passes both the shared bridge-v1 corpus and AutoBuild's verifier.
- Two runs over the same graph bytes and producer version are byte-identical.

## Approval gate

Accepted by the user on 2026-07-19. This authorizes the public CLI command and
bridge artifact producer exactly as specified.
