#!/usr/bin/env bash
# Fetch the pinned OSS scale fixture (ROADMAP Phase 7 §11: a real ~100k-LOC
# repo) into a gitignored path OUTSIDE the committed tree. We do NOT vendor
# 100k LOC into this monorepo — only the compact summary golden
# (fixtures/goldens/oss/) is committed. Network access is required.
#
# Usage:   fixtures/oss/fetch.sh
# Result:  fixtures/oss/clones/vue-core  pinned to the commit below.
#
# The scale gate test (apps/cli/test/oss-scale.test.ts) auto-discovers the
# clone at that path, or honors $MERIDIAN_OSS_REPO if set; it SKIPS when the
# clone is absent (so normal CI, which never fetches, stays green).
set -euo pipefail

REPO_URL="https://github.com/vuejs/core.git"
COMMIT="c0606e91798c8dca4f33d101e1dd836d672592c1"   # pinned; the golden is bound to it

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/clones/vue-core"

if [ -d "$dest/.git" ] && [ "$(git -C "$dest" rev-parse HEAD 2>/dev/null)" = "$COMMIT" ]; then
  echo "already at pinned commit: $dest"
  exit 0
fi

rm -rf "$dest"
mkdir -p "$here/clones"
echo "cloning $REPO_URL @ $COMMIT ..."
# Fetch exactly the pinned commit (shallow) — no full history downloaded.
git init -q "$dest"
git -C "$dest" remote add origin "$REPO_URL"
git -C "$dest" fetch -q --depth 1 origin "$COMMIT"
git -C "$dest" checkout -q FETCH_HEAD
echo "fetched: $dest @ $(git -C "$dest" rev-parse HEAD)"
