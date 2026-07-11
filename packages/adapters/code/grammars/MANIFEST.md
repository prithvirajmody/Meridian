# Vendored tree-sitter grammars

Prebuilt WASM grammars vendored under the package per ROADMAP Phase 7 §3
(subphase 7B). These are build artifacts, not goldens — they change only by
re-running the vendoring command below and updating this manifest.

| File | Language | ABI | sha256 |
|---|---|---|---|
| `tree-sitter-typescript.wasm` | TypeScript | 14 | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-python.wasm` | Python | 15 | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |

**Source:** [`@vscode/tree-sitter-wasm@0.3.1`](https://www.npmjs.com/package/@vscode/tree-sitter-wasm)
(Microsoft-maintained prebuilds; built with `tree-sitter-cli 0.25.10`).

**Runtime pairing.** The tree-sitter *runtime* (`tree-sitter.wasm`) is
deliberately **not** vendored: it must byte-match the JS glue of the pinned
`web-tree-sitter` dependency (exact version in `package.json`), so it ships
from that package. Only grammar files live here. Compatibility (runtime
`0.26.10` ⇄ both grammars, ABI 14/15) is asserted by the smoke tests.

**Regenerate:**

```sh
cd packages/adapters/code
npm pack @vscode/tree-sitter-wasm@<version>
tar xzf vscode-tree-sitter-wasm-<version>.tgz
cp package/wasm/tree-sitter-{typescript,python}.wasm grammars/
rm -r package vscode-tree-sitter-wasm-<version>.tgz
sha256sum grammars/*.wasm   # then update this manifest
pnpm test                   # ABI compatibility is test-asserted
```
