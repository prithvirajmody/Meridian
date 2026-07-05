# Phase 2 demo — `meridian ingest doc.md` → nested semantic graph

Roadmap §3 demo for Phase 2: *"`meridian ingest doc.md` → nested semantic
graph, via a plugin the core knows nothing about."* Executed 2026-07-05 from
the repo root after `pnpm build`.

## 1. Ingest a real markdown document

```
$ pnpm meridian ingest fixtures/corpora/markdown/links.md --out /tmp/links.meridian.json
INGESTED fixtures/corpora/markdown/links.md
  adapter    markdown (@meridian/adapter-markdown)
  emitted    1 document · 0 deltas
  graphs 6 · nodes 11 · edges 5 · roots 1 · max depth 4
  provenance source 22 · derived 0 · ai 0
  wrote /tmp/links.meridian.json
```

Six graphs from one file: the document root, the top section's detail graph,
and one detail graph per section that has children — recursion as flat
references (ADR-0001). The five edges are internal anchor links placed by the
portal rule: e.g. the two `#appendix` links inside the depth-3 "Deep Details"
section surface as **one** `doc:links-to` edge, weight 2, between *Chapter
One* and *Appendix* in their lowest common graph.

## 2. The output is an ordinary, valid graph document

```
$ pnpm meridian validate /tmp/links.meridian.json     # → OK
$ pnpm meridian stats /tmp/links.meridian.json
  graphs             6
  nodes              11
  edges              5
  ...
  nodes by kind:
    doc:paragraph  6
    doc:section    5
  edges by kind:
    doc:links-to  5
```

The whole Phase 0/1 pipeline (validate/stats/inspect/mutate/watch) works on
ingested documents unchanged — the adapter is just another producer of the
one IR. (Standalone `validate` reports `unregistered-namespace` *warnings*
for the `doc:` attrs: vocabulary registration lives with the plugin host, so
U8 is enforced as errors only at the ingest gate, where the registry exists —
`ValidateOptions.vocabulary` in graph-core.)

## 3. The core knows nothing about it

```
$ pnpm meridian plugins list
plugins (1):
  @meridian/adapter-markdown 0.1.0 — plugin-api ^0.1.0
    capabilities  domain-parser:markdown
    kinds         doc:break, doc:code, doc:html, doc:links-to, doc:list, doc:paragraph, doc:quote, doc:section
    attrs         doc:index, doc:items, doc:lang, doc:level, doc:ordered
```

Mechanically enforced, not aspirational: `pnpm depcruise` forbids
`graph-core`/`graph-store` from importing any `plugin-*` package or adapter,
and `pnpm audit:strings` fails CI if the string "markdown" appears anywhere
in the core packages' sources.

## 4. Determinism (acceptance criterion)

```
$ pnpm meridian ingest fixtures/corpora/markdown/basic.md --out /tmp/a.json
$ pnpm meridian ingest fixtures/corpora/markdown/basic.md --out /tmp/b.json
$ cmp /tmp/a.json /tmp/b.json && echo byte-identical
byte-identical
```

Same file → byte-identical document, stable IDs included (automated in
`apps/cli/test/ingest.test.ts`).

## 5. Containment (failure demo)

```
$ pnpm meridian ingest fixtures/corpora/markdown/reject/binary.bin
INGEST FAILED fixtures/corpora/markdown/reject/binary.bin
  [no-parser] no registered parser claims "fixtures/corpora/markdown/reject/binary.bin" (0 claimants)
$ pnpm meridian ingest fixtures/corpora/markdown/basic.md --adapter nope
INGEST FAILED fixtures/corpora/markdown/basic.md
  [unknown-parser] no registered parser has domain "nope"
```

Both exit 1 with typed, located errors; a parser that throws mid-ingest is
rolled back atomically (host tests + conformance kit).
