#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${MOVIE_HARBOR_ENV_FILE:-.env}
cd "$project_root"
exec node tools/upgrade-media-storage.mjs --env "$env_file" "$@"
