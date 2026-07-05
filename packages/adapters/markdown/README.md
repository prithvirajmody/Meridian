# @meridian/adapter-markdown

The first domain adapter (ROADMAP Phase 2) — the deterministic exemplar
(ARCHITECTURE.md §7.3): CommonMark documents → nested semantic graphs, no AI,
no network, byte-for-byte reproducible.

## Mapping

- **Sections from headings** (ATX and setext), nested by depth with ragged
  hierarchies welcome: a section node (`doc:section`, attrs `doc:level`,
  `doc:index`) carries `detail` → the graph of its children iff it has any.
- **Blocks are leaves** under their section: `doc:paragraph`, `doc:code`
  (`doc:lang`), `doc:list` (`doc:items`, `doc:ordered`), `doc:quote`,
  `doc:html`, `doc:break`. Labels are ≤80-char excerpts; `doc:index` is
  reading order within the graph. v1 does not recurse below block level.
- **Internal anchor links** (`#github-style-slug`, duplicates suffixed)
  become `doc:links-to` edges placed by the **portal rule** (ADR-0001 §4.3):
  recorded in the lowest common graph between the endpoint's ancestors
  there, `weight` = multiplicity. Unresolved anchors and links to an
  element's own ancestor induce nothing.
- **IDs** are ADR-0002 coordinates: domain `markdown`, source = the
  descriptor URI, path = section slug chain (+ per-type block ordinals) —
  re-ingesting an unchanged file yields identical IDs.
- **Provenance** on every element: `origin: 'source'`, the source URI, and
  line-aligned byte spans.

Parser: **markdown-it, strict `commonmark` preset** — chosen over the
micromark/mdast stack because the Phase 2 perf budget (5MB book < 2s,
`benchmarks/ingest-markdown.bench.mjs`) is a CI gate and micromark measured
~40× slower; markdown-it passes the CommonMark spec suite and resolves
reference links at parse time.

**Public API entry point:** `@meridian/adapter-markdown` — one export,
`markdownPlugin` (plus its `manifest`), no module-scope side effects
(ADR-0009).

**Forbidden imports:** every Meridian package except `@meridian/plugin-api`
(adapters see only the contract, §20 — dependency-cruiser-enforced), and no
node builtins (isomorphic). External parser dependency: `markdown-it` only.

Corpus: `fixtures/corpora/markdown/` (CommonMark edge cases, pathological
nesting, links, empties, binary rejects) — run through
`@meridian/conformance-kit` in `test/conformance.test.ts`.
