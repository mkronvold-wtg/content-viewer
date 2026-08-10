#!/usr/bin/env bash

set -Eeuo pipefail

readonly EXPECTED_IMAGE=ghcr.io/mkronvold-wtg/content-viewer:dev
readonly EXPECTED_PUBLIC_URL=https://kpe-content.dev.e2open.com/
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH=""
prior_image_id=""
rollback_required=false

usage() {
  printf 'Usage: %s --config PATH\n' "$0" >&2
  exit 2
}

while (($#)); do
  case "$1" in
    --config)
      shift
      (($#)) || usage
      CONFIG_PATH="$1"
      shift
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "$CONFIG_PATH" && -r "$CONFIG_PATH" ]] || usage

set +x
source "$CONFIG_PATH"
source "$SCRIPT_DIR/compose-project.sh"
validate_project_name

readonly -a COMPOSE_ARGS=(-p "$PROJECT" --env-file .env -f docker-compose.npm.yml)
readonly ROLLBACK_IMAGE="${AUTOUPDATE_BOOTSTRAP_ROLLBACK_IMAGE:-}"
readonly RECORD_PATH="${AUTOUPDATE_BOOTSTRAP_RECORD_PATH:-}"
readonly PUBLIC_URL="${AUTOUPDATE_BOOTSTRAP_PUBLIC_URL:-}"
readonly EXPECTED_VOLUME="${PROJECT}_content-viewer-content"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

run_compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}

container_volume() {
  docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/content"}}{{.Name}}{{end}}{{end}}' "$1"
}

verify_volume() {
  local container volume
  container="$(run_compose ps -q content-viewer)"
  [[ -n "$container" ]] || die 'content-viewer is not running in the configured project.'
  volume="$(container_volume "$container")"
  [[ "$volume" == "$EXPECTED_VOLUME" ]] || die "content-viewer must use $EXPECTED_VOLUME at /app/content."
}

restore_prior_image() {
  [[ -n "$prior_image_id" ]] || return 0
  docker image tag "$prior_image_id" "$EXPECTED_IMAGE"
  run_compose up -d --no-build --no-deps content-viewer
  AUTOUPDATE_PROJECT_NAME="$PROJECT" "$SCRIPT_DIR/healthcheck.sh" --services content-viewer
}

on_error() {
  local status=$?
  trap - ERR
  if [[ "$rollback_required" == true ]]; then
    printf 'Bootstrap failed; restoring the retained pre-GHCR image.\n' >&2
    restore_prior_image || printf 'Rollback recreation failed; retained image is %s.\n' "$ROLLBACK_IMAGE" >&2
  fi
  exit "$status"
}

trap on_error ERR

[[ "$AUTOUPDATE_ALLOWED_SERVICES" == content-viewer ]] || die 'Bootstrap requires only the content-viewer allowlist.'
[[ "$AUTOUPDATE_ALLOWED_IMAGES" == *"content-viewer=$EXPECTED_IMAGE"* ]] || die 'Bootstrap image is not the exact allowlisted GHCR development image.'
[[ "${AUTOUPDATE_TARGET_PLATFORM:-}" == linux/amd64 ]] || die 'Bootstrap requires linux/amd64.'
[[ "${AUTOUPDATE_REGISTRY_PROFILE:-}" == ghcr-dev ]] || die 'Bootstrap requires the ghcr-dev registry profile.'
[[ "$PUBLIC_URL" == "$EXPECTED_PUBLIC_URL" ]] || die "Bootstrap public URL must be $EXPECTED_PUBLIC_URL."
[[ "$ROLLBACK_IMAGE" =~ ^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$ && "$ROLLBACK_IMAGE" != *"@"* ]] \
  || die 'AUTOUPDATE_BOOTSTRAP_ROLLBACK_IMAGE must be a mutable local image tag.'
[[ -n "$RECORD_PATH" ]] || die 'AUTOUPDATE_BOOTSTRAP_RECORD_PATH is required.'
[[ ! -e "$RECORD_PATH" ]] || die "Bootstrap was already recorded at $RECORD_PATH."
command -v curl >/dev/null 2>&1 || die 'curl is required to verify the public route.'

verify_volume
container="$(run_compose ps -q content-viewer)"
prior_image_id="$(docker inspect --format '{{.Image}}' "$container")"
[[ -n "$prior_image_id" ]] || die 'Running content-viewer has no image ID to retain.'
docker image tag "$prior_image_id" "$ROLLBACK_IMAGE"
rollback_required=true

run_compose pull content-viewer
run_compose up -d --no-build --no-deps content-viewer
AUTOUPDATE_PROJECT_NAME="$PROJECT" "$SCRIPT_DIR/healthcheck.sh" --services content-viewer
curl --fail --silent --show-error --max-time 20 "$PUBLIC_URL" >/dev/null
verify_volume

mkdir -p -- "$(dirname -- "$RECORD_PATH")"
umask 077
temporary_record="$(mktemp "${RECORD_PATH}.tmp.XXXXXX")"
{
  printf 'project=%s\n' "$PROJECT"
  printf 'volume=%s\n' "$EXPECTED_VOLUME"
  printf 'previous_image_id=%s\n' "$prior_image_id"
  printf 'rollback_image=%s\n' "$ROLLBACK_IMAGE"
  printf 'candidate_image=%s\n' "$EXPECTED_IMAGE"
  printf 'public_url=%s\n' "$PUBLIC_URL"
} >"$temporary_record"
mv -- "$temporary_record" "$RECORD_PATH"
rollback_required=false
printf 'Bootstrap completed; retained rollback image %s.\n' "$ROLLBACK_IMAGE"
