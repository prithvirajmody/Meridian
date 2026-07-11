# `@meridian/adapter-code`

The source-code domain adapter (ROADMAP Phase 7). **Imports only
`@meridian/plugin-api`** of Meridian (plus `web-tree-sitter` + `comlink`) — the
hourglass (§20).

- **7B — parsing substrate.** One isomorphic grammar-loading shim over
  `web-tree-sitter`, vendored TypeScript + Python WASM grammars
  (`grammars/MANIFEST.md`), error-tolerant parse summaries, and a worker host
  following ADR-0017's two-channel pattern.
- **7C — TypeScript mapping, eager levels.** `createCodePlugin({ mapper })`
  maps a project to `code:project → package → module →
  class/function/method` **signatures** (ADR-0027: signatures are eager,
  bodies are lazy — nested functions are *not* emitted). Containment is the
  detail-graph relation, so 7C emits no edges (imports/calls are 7E). Stable
  IDs come from `ctx.ids` over ADR-0002/0028 coordinates — `source` = the
  repo-relative POSIX path, `path[]` = the qualifiedName scope chain, with
  `#<sigHash>` for overloads and `~<n>` for illegal duplicates. Provenance
  spans on every node; a syntax-error file yields a flagged partial graph.

The mapping **walk runs where the tree lives** — in the worker in production
wiring (grammars load only in workers), shipping graph-shaped `RawModule`s
back; the host derives IDs. An in-process mapper (`createInProcessMapper`) runs
the same pure walk on the calling thread for tests/conformance.

A whole directory reaches the adapter as one bundle
(`CODE_PROJECT_MEDIA_TYPE`) the composition root built (ADR-0009); a lone
`.ts` file is a one-module project. Wired into `meridian ingest <dir>
--adapter code`.

`src/` imports no `node:*` and no DOM (depcruise-enforced); environment shims
(Node `worker_threads` factory, fs/fetch grammar sources) live with their
environments — see `test/` and `apps/cli` for the Node wiring.
