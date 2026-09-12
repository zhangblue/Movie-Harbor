#!/bin/sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$REPO_ROOT/tools/offline-package.mjs" "$@"
