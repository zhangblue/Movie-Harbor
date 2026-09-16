#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$script_dir/compose.yml" ] && [ -f "$script_dir/start.sh" ]; then
  project_root=$script_dir
else
  project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
fi
env_file=${MOVIE_HARBOR_ENV_FILE:-.env}
cd "$project_root"
exec node "$script_dir/upgrade-media-storage.mjs" --env "$env_file" "$@"
