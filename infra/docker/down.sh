#!/usr/bin/env bash

set -Eeuo pipefail

readonly -a COMPOSE_ARGS=(--env-file .env -f docker-compose.npm.yml)

# Persistent content lives in the named volume. This wrapper always preserves it.
for argument in "$@"; do
  case "$argument" in
    -v|--volumes|--volumes=*)
      printf 'Refusing to remove persistent volumes.\n' >&2
      exit 2
      ;;
  esac
done

exec docker compose "${COMPOSE_ARGS[@]}" down "$@"
