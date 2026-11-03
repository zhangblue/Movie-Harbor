#!/bin/sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
# 脚本入口将参数原样交给打包工具，并保留其退出状态。
exec node "$REPO_ROOT/tools/offline-package.mjs" "$@"
