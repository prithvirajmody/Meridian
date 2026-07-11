# `@meridian/adapter-code`

The source-code domain adapter (ROADMAP Phase 7). Subphase 7B ships the
parsing substrate only: one isomorphic grammar-loading shim over
`web-tree-sitter`, vendored TypeScript + Python WASM grammars
(`grammars/MANIFEST.md`), error-tolerant parse summaries, and a worker host
following ADR-0017's two-channel pattern — grammars load only in workers in
production wiring. Nothing graph-shaped yet (mapping rules land in 7C).

`src/` imports no `node:*` and no DOM (depcruise-enforced); environment
shims (Node `worker_threads` factory, fs/fetch grammar sources) live with
their environments — see `test/` for the Node wiring.
