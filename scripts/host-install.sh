#!/usr/bin/env bash
set -euo pipefail
# New private personal-install directory only; never touch services or live state.
if [[ $# -ne 1 || "$1" != /* ]]; then
  printf 'Usage: bash scripts/host-install.sh /absolute/new/private/install-directory\n' >&2
  exit 2
fi
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
destination="$1"
if [[ -e "$destination" || -L "$destination" ]]; then
  printf 'Refusing an existing install directory. Build a new version and quiesce before owner-approved switching.\n' >&2
  exit 1
fi
umask 077
cd "$source_root"
npm run build
mkdir -m 700 -- "$destination"
mkdir -m 700 -- "$destination/build" "$destination/build/host" "$destination/build/host/src" "$destination/scripts" "$destination/native"
# Runtime JS only: no source maps, tests, declarations or coordinator implementation.
cp -- build/host/src/*.js "$destination/build/host/src/"
cp -- package.json package-lock.json README.md "$destination/"
cp -- scripts/runtime-*.mjs scripts/host-smoke.mjs scripts/host-speech-init.mjs scripts/operation-state.mjs "$destination/scripts/"
cp -- native/README.md "$destination/native/"
# Public Markdown only; never copy build artifacts, hidden files or linked private data.
for public_docs in docs native/docs; do
  while IFS= read -r -d '' document; do
    mkdir -p -- "$destination/$(dirname -- "$document")"
    cp -- "$document" "$destination/$document"
  done < <(find "$public_docs" -type f -name '*.md' ! -path '*/.*' -print0)
done
find "$destination" -type d -exec chmod 700 {} +
find "$destination" -type f -exec chmod 600 {} +
# Exact lockfile; no lifecycle scripts, global npm install, downloads or service changes.
npm ci --prefix "$destination" --omit=dev --ignore-scripts --offline
printf 'Private host package installed. No state, login, grant or service was activated.\n'
