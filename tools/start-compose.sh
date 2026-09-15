#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${MOVIE_HARBOR_ENV_FILE:-.env}
output_file=${MOVIE_HARBOR_STORAGE_COMPOSE_OUTPUT:-compose.storage.generated.json}

cd "$project_root"
node tools/storage-compose.mjs --env "$env_file" --output "$output_file" --initialize
docker compose -f docker-compose.yml -f "$output_file" --env-file "$env_file" up -d --build --wait
