# @meridian/adapter-markdown

## 0.1.0 — 2026-07-05 (Phase 2)

Initial adapter: CommonMark → nested semantic graphs (sections by heading
depth; paragraph/code/list/quote/html/break leaves; internal anchor links as
portal-rule `doc:links-to` edges with multiplicity weights; ADR-0002
deterministic IDs; line-aligned provenance spans). Parser: markdown-it
strict-commonmark, chosen for the 5MB-book-under-2s CI budget.
