# Third-party notices

Meridian's own code, documentation, fixtures and generated test assets are
released under the MIT license in [LICENSE](LICENSE). This file lists the
third-party material that is committed to this repository, and how the
dependencies installed by `pnpm install` are licensed.

## Third-party files committed here

| Path | What it is | Upstream | License |
|---|---|---|---|
| `packages/adapters/code/grammars/tree-sitter-typescript.wasm` | Prebuilt TypeScript grammar | [`@vscode/tree-sitter-wasm`](https://github.com/microsoft/vscode-tree-sitter-wasm) 0.3.1, built from [tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | MIT (texts below) |
| `packages/adapters/code/grammars/tree-sitter-python.wasm` | Prebuilt Python grammar | [`@vscode/tree-sitter-wasm`](https://github.com/microsoft/vscode-tree-sitter-wasm) 0.3.1, built from [tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) | MIT (texts below) |
| `packages/renderer/assets/fonts/DejaVuSans.ttf` | DejaVu Sans font | [DejaVu fonts](https://dejavu-fonts.github.io/) | Bitstream Vera license; DejaVu changes are in the public domain. Full text in [`LICENSE-DejaVu.txt`](packages/renderer/assets/fonts/LICENSE-DejaVu.txt) |
| `packages/renderer/assets/fonts/meridian-msdf.fnt`, `meridian-msdf.png`, and the copies in `packages/renderer/harness/public/fonts/` | MSDF glyph atlas generated from DejaVu Sans by `packages/renderer/tools/generate-msdf-font.mjs` | Derived from DejaVu Sans | Same as DejaVu Sans |

The two `.wasm` files are byte-identical to the files in the published
`@vscode/tree-sitter-wasm@0.3.1` npm package (SHA-256 values in
[`grammars/MANIFEST.md`](packages/adapters/code/grammars/MANIFEST.md)).

## Dependencies installed by pnpm

Dependencies are not committed. `pnpm licenses list --prod` reports 77
production packages: 53 MIT, 11 ISC, 5 Apache-2.0, 3 BSD-3-Clause,
1 BSD-2-Clause, 1 Python-2.0 (`argparse`), 1 MIT OR WTFPL
(`expand-template`), 1 BSD-2-Clause OR MIT OR Apache-2.0 (`rc`), and
1 EPL-2.0 (`elkjs`). None is GPL, LGPL or AGPL.

`elkjs` is used unmodified by `@meridian/layout` for layered layout. A Studio
build bundles it, so anyone redistributing such a build must keep its notice:
the source is at <https://github.com/kieler/elkjs> and the license is the
[Eclipse Public License 2.0](https://www.eclipse.org/legal/epl-2.0/).

Run `pnpm licenses list` (add `--prod` for runtime packages only) to see the
full list for the current lockfile.

## Fixtures, corpora and media

- Every corpus under `fixtures/` and `evals/` was written for this repository
  and is synthetic: a short Markdown "book" and CommonMark edge cases, a
  pedestrianization essay, short chat exports (recursion, gardening,
  sourdough and telescopes), sample organization definitions, and small
  TypeScript and Python projects.
- `fixtures/goldens/oss/vue-core.summary.json` holds only counts and a digest
  computed from [vuejs/core](https://github.com/vuejs/core) (MIT) at the
  commit pinned in [`fixtures/oss/README.md`](fixtures/oss/README.md). No
  vuejs/core source is committed; `fixtures/oss/fetch.sh` clones it outside
  the tracked tree.
- `contracts/org-v1/` is vendored from AutoBuild, another project by the same
  author, and is covered by this repository's license.
- The screenshot goldens, layout SVG goldens and `docs/demos/phase-05.webm`
  were rendered by Meridian from the fixtures above.

## License texts

### @vscode/tree-sitter-wasm

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
```

### tree-sitter-typescript

```
The MIT License (MIT)

Copyright (c) 2017 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### tree-sitter-python

```
The MIT License (MIT)

Copyright (c) 2016 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
