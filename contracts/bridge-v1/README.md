# Bridge contract v1

Bridge v1 is the neutral artifact boundary between Meridian producers and
AutoBuild/SandBox consumers. The normative machine files are the three JSON
Schemas in `schemas/`; `fixtures/fixture-index.json` classifies the shared
valid/invalid corpus, and `fixtures/SHA256SUMS` pins every corpus byte.

## Correlation and validation

- A source is exactly `{repo, ref}`. `repo` is an absolute URI and `ref` is a
  lowercase 40-hex commit SHA. Consumers compare the repository string and SHA
  exactly; they do not resolve, shorten, or normalize a moving reference.
- A graph descriptor's `target`, its graph document's top-level `source`, and
  the surrounding containment/oracle/job target must agree. The document's
  `source.ingested_by` object must be byte-semantically identical to the
  descriptor's `produced_by` object.
- A diff descriptor's `from` and `to`, the two graph documents' `source`
  blocks, the structural delta's `from` and `to`, and surrounding baseline and
  target pins must agree.
- Paths are bundle-relative canonical POSIX paths. Absolute paths, backslashes,
  empty segments, `.`/`..` segments, symlinks, and paths escaping the bundle
  root are rejected before a file is opened.
- Consumers check declared size before reading, enforce their own (possibly
  lower) size policy, then hash the exact bytes with SHA-256 before parsing.
  Counts and domains are recomputed from verified documents; summaries are
  recomputed from the verified delta and never treated as the evidence of
  record.

## Artifact semantics

- Graph documents use Meridian `formatVersion: 1` plus an additive top-level
  `source` block:

  ```json
  {
    "repo": "https://example.test/repo.git",
    "ref": "0123456789abcdef0123456789abcdef01234567",
    "ingested_by": {
      "meridian_version": "0.1.0",
      "adapter": "code",
      "adapter_versions": { "@meridian/adapter-code": "0.2.0" }
    }
  }
  ```

- A structural delta is the replayable `diffSpaces` op list with a bridge-v1
  `schema_version`, `kind`, and endpoint pins added at the top level. Those
  additive fields are ignored by Meridian's existing delta decoder; `origin`
  and `ops` remain its one mutation vocabulary.
- `nodes_added`/`nodes_removed` and edge counts count corresponding op types.
  A stable child graph whose owning detail node changes between documents
  contributes one `nodes_moved`. A rename remains remove+add. `by_kind`
  aggregates node and edge additions/removals by their wire `kind`.
- Whitespace-only source changes may change the endpoint pin while producing
  an empty op list and all-zero summary. Structural differences are successful
  data: `meridian diff` may use exit 1 to mean "different", but consumers must
  reserve process/contract failure for exit 2 or an invalid artifact.

## Compatibility policy

Within schema major 1, producers may add optional fields only. Consumers must
ignore unknown optional fields after validating all v1-required fields, while
preserving the raw artifact bytes. A field removal, new required field, type or
meaning change, path/digest rule change, operation-vocabulary change, or
previously invalid document becoming valid requires bridge v2, new `$id`
values, a new fixture directory, and an explicit dual-read migration window.
Unknown schema majors and unknown graph/delta format versions are rejected.

Fixtures are immutable once accepted. A corpus update regenerates
`SHA256SUMS`, is copied verbatim to each participating repository, and must be
reviewed with the schema change. CI verifies both local checksums and the
recorded checksum of each sibling corpus; schema drift without the required
major-version process is a failing contract gate.
