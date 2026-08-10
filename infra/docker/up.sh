#!/usr/bin/env bash

set -Eeuo pipefail

readonly -a COMPOSE_ARGS=(--env-file .env -f docker-compose.npm.yml)

usage() {
  printf 'Usage: %s --services content-viewer\n' "$0" >&2
  exit 2
}

services=()
while (($#)); do
  case "$1" in
    --services)
      shift
      (($#)) || usage
      services=("$@")
      break
      ;;
    *)
      usage
      ;;
  esac
done

[[ -z "${AUTOUPDATE_SERVICES:-}" || "${AUTOUPDATE_SERVICES}" == "content-viewer" ]] || usage
[[ "${services[*]:-}" == "content-viewer" ]] || usage

# The updater acquires the candidate image and retains rollback tags. This wrapper only
# recreates the allowlisted application service and never creates a build.
exec docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --no-deps "${services[@]}"
