#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/compose-project.sh"
validate_project_name
readonly -a COMPOSE_ARGS=(-p "$PROJECT" --env-file .env -f docker-compose.npm.yml)
readonly MAX_ATTEMPTS=20
readonly RETRY_SECONDS=3

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

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  if docker compose "${COMPOSE_ARGS[@]}" exec -T content-viewer node -e \
    "fetch('http://127.0.0.1:8080/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    exit 0
  fi
  sleep "$RETRY_SECONDS"
done

printf 'content-viewer did not pass /api/health within %s seconds.\n' "$((MAX_ATTEMPTS * RETRY_SECONDS))" >&2
exit 1
