#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH=""
ORIGINAL_ARGS=("$@")

while (($#)); do
  case "$1" in
    --config)
      (($# >= 2)) || {
        printf '%s requires a path.\n' "$1" >&2
        exit 2
      }
      CONFIG_PATH="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[[ -n "$CONFIG_PATH" && -r "$CONFIG_PATH" ]] || {
  printf 'A readable --config path is required.\n' >&2
  exit 2
}

set +x
source "$CONFIG_PATH"
source "$SCRIPT_DIR/compose-project.sh"
validate_project_name

# The canonical vendor uses Docker Compose's standard project environment for
# every generated Compose command. Keep it aligned with the validated wrapper.
export COMPOSE_PROJECT_NAME="$PROJECT"
exec "$SCRIPT_DIR/../../templates/compose-autoupdate/autoupdate.sh" "${ORIGINAL_ARGS[@]}"
