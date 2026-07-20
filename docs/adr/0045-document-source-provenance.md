# ADR-0045 — Pinned document source provenance for bridge-v1 graph artifacts

- **Status:** Accepted
- **Date:** 2026-07-19
- **Phase:** AutoBuild integration Milestone C1 / roadmap Phase 4B
- **Constitution:** ARCHITECTURE.md P1, P4, P10, P12; §3.3, §6, §15.4, §17, §20; ADR-0004, ADR-0009
- **Integration contract:** `contracts/bridge-v1/`; AutoBuild `ROADMAP.md` Phase 4; `docs/plans/integration/milestone-C-architecture-eye.md`
- **Numbering:** ADR-0041…0044 remain reserved by Meridian roadmap Phase 12; this integration uses the next free number

## Context

Bridge-v1 must prove that a Meridian graph document describes one exact
repository tree, not merely that a graph file was produced. Element-level
`provenance` already records source locations, and the document-level
`producer` records the graph encoder, but neither answers “this complete
document represents repository R at commit S.” SandBox stages a `git archive`
without `.git`, so Meridian cannot discover or verify that fact itself. The
caller knows the pin and must assert it; downstream consumers independently
cross-check the assertion against the descriptor and surrounding evidence.

The bridge contract already fixes the external vocabulary: a graph descriptor
has `target: {repo, ref}` and `produced_by`; the graph document must carry the
same pin plus identical producer/adapter provenance. Existing Meridian
documents must continue to decode, and the semantic core must not gain Git
operations or repository I/O.

## Decision

### 1. Add an optional, typed top-level `source` block to `GraphDocument`

The v1 document codec accepts and emits this additive field:

```ts
interface DocumentSource {
  repo: string; // absolute URI, copied exactly
  ref: string;  // lowercase 40-hex commit SHA
  ingested_by: {
    meridian_version: string;
    adapter: string;
    adapter_versions: Record<string, string>;
  };
}

interface GraphDocument {
  formatVersion: 1;
  producer: DocumentProducer;
  source?: DocumentSource;
  roots: string[];
  graphs: Graph[];
}
```

`source` is document provenance, not graph semantics. `graph-core` parses and
canonicalizes the value but does not resolve the URI, inspect Git, understand
an adapter domain, or use the pin in semantic computation. This is compatible
with P1: the core owns a neutral external-evidence envelope; the CLI remains
the composition root that supplies its values.

Documents without `source` remain valid and encode exactly as before. A decode
success exposes the optional source metadata alongside `space` so Studio and
other composition roots can display it without reparsing untrusted JSON.
`EncodeOptions` gains `source?`. Callers that transform graph state do **not**
implicitly carry source forward: a mutated graph is no longer proof of the
original committed tree. They must deliberately supply a new trusted pin or
emit an unpinned ordinary document. This prevents stale provenance.

Canonical key order for a pinned document is `formatVersion`, `producer`,
`source`, `roots`, `graphs`. Strings are NFC-normalized under ADR-0004. Same
space + producer + source therefore yields byte-identical `encodeCanonical`
output; no clock, cwd, absolute source-tree path, or random value enters it.

### 2. Define a backward-compatible pinned ingest mode

The existing unpinned command remains valid:

```text
meridian ingest <source> [--out <file>] ...
```

A bridge producer invocation is:

```text
meridian ingest <source> --repo <absolute-uri> --ref <full-sha>
  --out <graph.json> --descriptor <graph-artifact.json> ...
```

Supplying any of `--repo`, `--ref`, or `--descriptor` requires all four bridge
outputs/inputs (`--repo`, `--ref`, `--out`, `--descriptor`). `--ref` rejects
anything except lowercase 40-hex. `--repo` must be an absolute URI. These are
caller assertions; Meridian records them and never claims to verify the staged
tree against Git.

The selected plugin manifest supplies `adapter_versions`; users cannot
override producer versions. `meridian_version` is the CLI build version and
`adapter` is the selected parser domain. The document `source.ingested_by` and
descriptor `produced_by` are built from the same in-memory value, not two
parallel constructions.

Pinned mode writes canonical minified UTF-8 graph bytes with no BOM or trailing
newline. Existing unpinned `--out` retains its current pretty interchange form
to avoid an unrelated behavior change. The graph and descriptor must share a
directory, making the descriptor's `document` a canonical safe filename. The
CLI writes the graph first, computes exact size/SHA-256/counts/domains, and
writes the descriptor last. An incomplete pair has no descriptor completion
marker and is not trusted.

### 3. Descriptor and document agreement is mandatory

The descriptor conforms to
`contracts/bridge-v1/schemas/graph-artifact.schema.json`. Its `target` equals
document `source.{repo,ref}`; its `produced_by` equals
`source.ingested_by`; `graph_format_version` equals `formatVersion`; and node,
edge, and sorted-unique domain counts are derived from the exact graph bytes.
Consumers still verify all of those facts. Producer self-validation catches
bugs but does not replace consumer validation.

## Alternatives considered

- **Descriptor-only provenance.** Rejected: descriptor/document substitution
  would remain possible unless every consumer retained out-of-band state; the
  correlation rule deliberately has independent declarations to cross-check.
- **Read `.git` in Meridian.** Rejected: SandBox's staged tree intentionally has
  no Git metadata, and source verification belongs to the staging caller.
- **Put repo/ref on every element.** Rejected: redundant, large, and conflates
  document identity with element source locations already covered by P10.
- **Attach an untyped metadata bag.** Rejected: the field is an external trust
  boundary and therefore requires parse-don't-validate typing (P4/P12).
- **Automatically retain a pin after mutation/export.** Rejected: it would make
  a changed graph falsely claim to represent the original commit.

## Tradeoffs and consequences

The codec learns one neutral evidence shape and decode results grow an optional
field. In exchange, every pinned document is independently correlatable and
Studio can show its identity. Ordinary files remain byte-compatible. Pinned
mode's same-directory rule is intentionally conservative; a later need for
more layouts can add an explicit bundle-root option without weakening path
safety.

## Verification required after acceptance

- Legacy graph documents decode and re-encode byte-identically.
- Malformed URI, short/uppercase SHA, incomplete flag groups, mismatched
  producer values, unsafe output relationships, and descriptor write failures
  have explicit negative tests.
- The same fixture tree + repo/ref + versions ingested twice produces
  byte-identical graph and descriptor bytes.
- Changing repo, ref, Meridian version, or adapter version changes provenance
  and the corresponding digest deterministically.
- The produced pair passes the shared bridge-v1 valid corpus/validator and the
  graph opens in Studio; an unpinned legacy document still opens.

## Approval gate

Accepted by the user on 2026-07-19. This authorizes the additive codec/type
change and pinned ingest producer surface exactly as specified.
