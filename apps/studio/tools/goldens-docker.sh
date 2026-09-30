#!/usr/bin/env bash
# Studio screenshot goldens in the pinned Playwright image, the same image CI's
# e2e job runs in (.github/workflows/ci.yml), so goldens never depend on the
# host's fonts or fontconfig.
#
#   update  (pnpm goldens:update:ui:docker) runs the documented
#           `pnpm goldens:update:ui` in the image and copies the *-snapshots
#           directories back. Nothing else on the host changes.
#   check   (pnpm goldens:check:ui:docker) runs the same visual tests in the
#           image against the committed goldens without updating them.
#
# The working tree (tracked and untracked files, minus ignored ones) is copied
# into the container, so the host's node_modules and build output are never
# touched. Needs Docker and network access for the image, pnpm, and packages.
set -euo pipefail

mode="${1:-update}"
if [ "$mode" != update ] && [ "$mode" != check ]; then
  echo "usage: $0 [update|check]" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"
playwright_version="$(node -p "require('./apps/studio/package.json').devDependencies['@playwright/test']")"
pnpm_version="$(node -p "require('./package.json').packageManager.split('@')[1]")"
image="mcr.microsoft.com/playwright:v${playwright_version}-noble"
ci_image="$(grep -o 'mcr\.microsoft\.com/playwright:v[^[:space:]]*' .github/workflows/ci.yml | head -n 1)"
if [ "$ci_image" != "$image" ]; then
  echo "CI runs e2e in ${ci_image:-<none>} but @playwright/test is ${playwright_version};" \
    "update the container image in .github/workflows/ci.yml first" >&2
  exit 1
fi

echo "goldens ${mode} in ${image}"
git ls-files -z --cached --others --exclude-standard \
  | tar --null --ignore-failed-read -T - -cf - \
  | docker run --rm -i --ipc=host --init \
      -e MODE="$mode" -e PNPM_VERSION="$pnpm_version" \
      -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
      -v "$root/apps/studio/e2e:/out" \
      "$image" bash -euo pipefail -c '
        mkdir -p /work && cd /work && tar -xf -
        npm install --global --silent "pnpm@${PNPM_VERSION}"
        pnpm install --frozen-lockfile --reporter=silent
        if [ "$MODE" = update ]; then
          pnpm goldens:update:ui
          for dir in apps/studio/e2e/*-snapshots; do
            name="$(basename "$dir")"
            rm -rf "/out/${name}"
            cp -r "$dir" "/out/${name}"
            chown -R "${HOST_UID}:${HOST_GID}" "/out/${name}"
          done
        else
          pnpm build
          pnpm --filter @meridian/studio exec playwright test --grep "visual baselines|Unicode fallback"
        fi
      '

if [ "$mode" = update ]; then
  git status --short -- 'apps/studio/e2e/*-snapshots'
fi
