#!/usr/bin/env bash
set -euo pipefail

# Builds and uploads a release.
function build() {
  npm run build
}

function upload {
  local target="$1"
  scp -r dist "$target"
}

build
upload "${1:-release-host}"
