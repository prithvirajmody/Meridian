#!/usr/bin/env bash
# Static Studio build for GitHub Pages, with Meridian's own source as the
# sample corpus.
#
#   bash apps/studio/tools/build-pages.sh [base]
#
# base is the URL path the site is served under: "/Meridian/" (the default) for
# the project site https://<owner>.github.io/Meridian/, or "/" for a root site.
#
# Writes apps/studio/dist/: the Studio built for that base; samples/ with an
# ingest of this repository's packages/, docs/ARCHITECTURE.md and two fixtures;
# LICENSE.txt, THIRD_PARTY_NOTICES.md and THIRD_PARTY_LICENSES.txt (the npm
# packages a build can bundle). Run `pnpm install` first. Needs no network and
# no API keys.
set -euo pipefail

base="${1:-/Meridian/}"
case "$base" in
  /*/ | /) ;;
  *) echo "base must start and end with '/': ${base}" >&2; exit 2 ;;
esac

root="$(git rev-parse --show-toplevel)"
cd "$root"
for required in LICENSE THIRD_PARTY_NOTICES.md; do
  if [ ! -f "$required" ]; then
    echo "${required} is missing; the hosted demo must ship with it" >&2
    exit 1
  fi
done
out=apps/studio/dist

# The CLI (for the sample ingest) and the Studio's workspace dependencies.
pnpm exec turbo run build --filter='@meridian/cli...' --filter='@meridian/studio^...' --output-logs=errors-only

# The landing view opens the code graph; `?sample=<file>` picks another sample.
VITE_MERIDIAN_DEFAULT_SAMPLE=meridian-packages.meridian.json \
  pnpm --filter @meridian/studio exec vite build --base "$base"

mkdir -p "$out/samples"
# Meridian's own TypeScript packages as a code graph; tests, build output and
# the renderer's dev harness are left out. Paths in the document are relative.
node apps/cli/dist/main.js ingest packages --lang typescript \
  --exclude '**/test/**,**/dist/**,**/harness/**' \
  --out "$out/samples/meridian-packages.meridian.json"
cp docs/ARCHITECTURE.md "$out/samples/meridian-architecture.md"
cp fixtures/corpora/markdown/commonmark-edges.md \
  fixtures/corpora/conversation/claude-two-topics.json "$out/samples/"

cp LICENSE "$out/LICENSE.txt"
cp THIRD_PARTY_NOTICES.md "$out/THIRD_PARTY_NOTICES.md"
node apps/studio/tools/third-party-licenses.mjs > "$out/THIRD_PARTY_LICENSES.txt"

echo "built ${out} for base ${base}"
ls -l "$out/samples"
