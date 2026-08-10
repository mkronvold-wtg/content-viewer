#!/usr/bin/env bash
#
# Reviewed, vendorable Compose application-image updater. Copy this file into an
# app repository; do not execute it from this standards repository at runtime.

set -Eeuo pipefail
IFS=$'\n\t'

readonly AUTOUPDATE_NOOP_EXIT=10
readonly AUTOUPDATE_LOCKED_EXIT=75

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${AUTOUPDATE_CONFIG:-${SCRIPT_DIR}/autoupdate.conf}"
RUN_ONCE=false
DRY_RUN=false
INTERVAL_OVERRIDE=""
ROLLBACK_ARMED=false
ROLLBACK_IN_PROGRESS=false

log() {
  local level="$1"
  shift
  printf '%s level=%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$level" "$*" >&2
}

die() {
  log error "$*"
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: autoupdate.sh [--config PATH] [--once] [--dry-run] [--interval SECONDS]

--once               Run one checked update cycle.
--dry-run            Resolve and validate only; never pull, restart, tag, or write records.
--interval SECONDS   Run repeatedly with the given positive interval.
USAGE
}

is_digest() {
  [[ "$1" =~ ^sha256:[a-f0-9]{64}$ ]]
}

is_service_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]
}

is_rollback_tag_for_service() {
  local rollback_tag="$1"
  local service="$2"
  local prefix timestamp
  prefix="${AUTOUPDATE_ROLLBACK_IMAGE_PREFIX}/${service}:"
  [[ "$rollback_tag" == "$prefix"* ]] || return 1
  timestamp="${rollback_tag#"$prefix"}"
  [[ "$timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

reference_repository() {
  local reference="${1%@*}"
  local final_segment="${reference##*/}"
  if [[ "$final_segment" == *:* ]]; then
    printf '%s' "${reference%:*}"
  else
    printf '%s' "$reference"
  fi
}

command_path() {
  if [[ "$1" == /* ]]; then
    printf '%s' "$1"
  else
    printf '%s/%s' "$AUTOUPDATE_WORKDIR" "$1"
  fi
}

run_compose() {
  (
    cd -- "$AUTOUPDATE_WORKDIR"
    DOCKER_DEFAULT_PLATFORM="$AUTOUPDATE_TARGET_PLATFORM" \
      docker compose "${compose_arguments[@]}" "$@"
  )
}

run_app_command() {
  local command="$1"
  local rollback_mode="$2"
  shift 2
  local services_csv
  services_csv="$(IFS=,; printf '%s' "$*")"

  (
    cd -- "$AUTOUPDATE_WORKDIR"
    export DOCKER_DEFAULT_PLATFORM="$AUTOUPDATE_TARGET_PLATFORM"
    AUTOUPDATE_SERVICES="$services_csv" \
      AUTOUPDATE_ROLLBACK="$rollback_mode" \
      "$command" --services "$@"
  )
}

install_rollback_traps() {
  ROLLBACK_ARMED=true
  ROLLBACK_IN_PROGRESS=false
  trap 'handle_interrupted_update HUP' HUP
  trap 'handle_interrupted_update INT' INT
  trap 'handle_interrupted_update TERM' TERM
}

clear_rollback_traps() {
  ROLLBACK_ARMED=false
  trap - HUP INT TERM
}

handle_interrupted_update() {
  local signal="$1"
  local exit_status
  case "$signal" in
    HUP) exit_status=129 ;;
    INT) exit_status=130 ;;
    TERM) exit_status=143 ;;
    *) exit_status=1 ;;
  esac

  if [[ "$ROLLBACK_IN_PROGRESS" == true ]]; then
    log error "status=interrupted signal=$signal reason=rollback-already-running"
    exit "$exit_status"
  fi

  ROLLBACK_IN_PROGRESS=true
  ROLLBACK_ARMED=false
  # Ignore a repeated service-manager signal while the one bounded rollback runs.
  trap '' HUP INT TERM
  log warn "status=interrupted signal=$signal action=restore-prior-images"
  if ! restore_prior_images; then
    log error "status=rollback-failed signal=$signal"
  fi
  exit "$exit_status"
}

rollback_after_candidate_failure() {
  ROLLBACK_ARMED=false
  trap '' HUP INT TERM
  restore_prior_images
}

contains_value() {
  local needle="$1"
  shift
  local value
  for value in "$@"; do
    [[ "$value" == "$needle" ]] && return 0
  done
  return 1
}

image_for_service() {
  local requested_service="$1"
  local index
  for index in "${!image_services[@]}"; do
    if [[ "${image_services[$index]}" == "$requested_service" ]]; then
      printf '%s' "${image_references[$index]}"
      return 0
    fi
  done
  return 1
}

validate_command() {
  local name="$1"
  local command="$2"
  [[ -n "$command" ]] || die "$name is required"
  [[ "$command" != *[[:space:]]* ]] || die "$name must be one executable path; use a wrapper for arguments"
  [[ "$command" == ./* && "/$command/" != */../* ]] || die "$name must be a path beneath AUTOUPDATE_WORKDIR"
  [[ -x "$(command_path "$command")" ]] || die "$name is not an executable file under AUTOUPDATE_WORKDIR"
}

validate_image_reference() {
  local image="$1"
  [[ -n "$image" ]] || die "allowed image is empty"
  [[ "$image" != *@* ]] || die "immutable digest pins are not valid for mutable auto-update: $image"
  [[ "$image" != *[[:space:]]* ]] || die "allowed image contains whitespace"
  local final_segment="${image##*/}"
  [[ "$final_segment" == *:* ]] || die "allowed image must include a mutable tag: $image"
}

validate_profile_images() {
  local index image
  case "$AUTOUPDATE_REGISTRY_PROFILE" in
    ghcr-dev)
      [[ "$AUTOUPDATE_TARGET_PLATFORM" == linux/* ]] || die "ghcr-dev requires a linux target platform"
      [[ -n "${AUTOUPDATE_GHCR_MUTABLE_TAG:-}" ]] || die "ghcr-dev requires AUTOUPDATE_GHCR_MUTABLE_TAG"
      [[ "$AUTOUPDATE_GHCR_MUTABLE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] \
        || die "AUTOUPDATE_GHCR_MUTABLE_TAG is invalid"
      for index in "${!image_references[@]}"; do
        image="${image_references[$index]}"
        [[ "$image" == ghcr.io/* ]] || die "ghcr-dev allows only ghcr.io images: $image"
        [[ "${image##*:}" == "$AUTOUPDATE_GHCR_MUTABLE_TAG" ]] \
          || die "ghcr-dev image must use explicitly configured mutable tag ${AUTOUPDATE_GHCR_MUTABLE_TAG}: $image"
      done
      ;;
    artifactory-repo-ops)
      [[ "$AUTOUPDATE_TARGET_PLATFORM" == "linux/amd64" ]] || die "artifactory-repo-ops requires AUTOUPDATE_TARGET_PLATFORM=linux/amd64"
      [[ -n "${AUTOUPDATE_ARTIFACTORY_MAPPING_PATH:-}" ]] || die "artifactory-repo-ops requires AUTOUPDATE_ARTIFACTORY_MAPPING_PATH"
      [[ -r "$AUTOUPDATE_ARTIFACTORY_MAPPING_PATH" ]] || die "Artifactory source-to-pull mapping is unreadable"
      for index in "${!image_references[@]}"; do
        image="${image_references[$index]}"
        [[ "$image" == repo.ops/* ]] || die "artifactory-repo-ops runtime pulls must use repo.ops, never sv4.art: $image"
        [[ "$image" != sv4.art/* ]] || die "artifactory-repo-ops runtime pulls must never use sv4.art"
      done
      ;;
    *)
      die "AUTOUPDATE_REGISTRY_PROFILE must be ghcr-dev or artifactory-repo-ops"
      ;;
  esac
}

validate_configuration() {
  local required
  for required in \
    AUTOUPDATE_WORKDIR \
    AUTOUPDATE_COMPOSE_FILES \
    AUTOUPDATE_COMPOSE_ENV_FILES \
    AUTOUPDATE_ALLOWED_SERVICES \
    AUTOUPDATE_ALLOWED_IMAGES \
    AUTOUPDATE_REGISTRY_PROFILE \
    AUTOUPDATE_TARGET_PLATFORM \
    AUTOUPDATE_UP_COMMAND \
    AUTOUPDATE_HEALTH_COMMAND \
    AUTOUPDATE_ROLLBACK_COMMAND \
    AUTOUPDATE_LOCK_PATH \
    AUTOUPDATE_DIGEST_RECORD_PATH \
    AUTOUPDATE_ROLLBACK_IMAGE_PREFIX; do
    [[ -n "${!required:-}" ]] || die "$required is required"
  done

  [[ -d "$AUTOUPDATE_WORKDIR" ]] || die "AUTOUPDATE_WORKDIR does not exist"
  [[ "$AUTOUPDATE_TARGET_PLATFORM" =~ ^linux/[A-Za-z0-9_.-]+$ ]] || die "AUTOUPDATE_TARGET_PLATFORM must be a Linux platform"
  [[ "$AUTOUPDATE_ROLLBACK_IMAGE_PREFIX" != *[[:space:]]* ]] || die "AUTOUPDATE_ROLLBACK_IMAGE_PREFIX contains whitespace"
  if [[ -z "${AUTOUPDATE_ROLLBACK_IMAGE_RETENTION+x}" ]]; then
    AUTOUPDATE_ROLLBACK_IMAGE_RETENTION=3
  fi
  [[ "$AUTOUPDATE_ROLLBACK_IMAGE_RETENTION" =~ ^([1-9]|10)$ ]] \
    || die "AUTOUPDATE_ROLLBACK_IMAGE_RETENTION must be an integer from 1 through 10"

  compose_arguments=()
  local compose_file env_file
  local -a compose_files env_files
  IFS=' ' read -r -a compose_files <<<"$AUTOUPDATE_COMPOSE_FILES"
  IFS=' ' read -r -a env_files <<<"$AUTOUPDATE_COMPOSE_ENV_FILES"
  ((${#compose_files[@]} > 0)) || die "AUTOUPDATE_COMPOSE_FILES is empty"
  ((${#env_files[@]} > 0)) || die "AUTOUPDATE_COMPOSE_ENV_FILES is empty"
  for compose_file in "${compose_files[@]}"; do
    [[ "$compose_file" != /* && "/$compose_file/" != */../* ]] || die "Compose files must be relative to AUTOUPDATE_WORKDIR"
    [[ -f "$AUTOUPDATE_WORKDIR/$compose_file" ]] || die "Compose file is missing: $compose_file"
    compose_arguments+=(-f "$compose_file")
  done
  for env_file in "${env_files[@]}"; do
    [[ "$env_file" != /* && "/$env_file/" != */../* ]] || die "Compose env files must be relative to AUTOUPDATE_WORKDIR"
    [[ -f "$AUTOUPDATE_WORKDIR/$env_file" ]] || die "Compose env file is missing: $env_file"
    compose_arguments+=(--env-file "$env_file")
  done

  IFS=' ' read -r -a allowed_services <<<"$AUTOUPDATE_ALLOWED_SERVICES"
  ((${#allowed_services[@]} > 0)) || die "AUTOUPDATE_ALLOWED_SERVICES is empty"
  local service
  for service in "${allowed_services[@]}"; do
    is_service_name "$service" || die "invalid allowed service: $service"
    ! contains_value "$service" "${checked_services[@]:-}" || die "duplicate allowed service: $service"
    checked_services+=("$service")
  done

  local entry mapped_service mapped_image
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    entry="$(trim "$entry")"
    [[ -z "$entry" || "$entry" == \#* ]] && continue
    [[ "$entry" == *=* ]] || die "AUTOUPDATE_ALLOWED_IMAGES entries must be service=image"
    mapped_service="$(trim "${entry%%=*}")"
    mapped_image="$(trim "${entry#*=}")"
    contains_value "$mapped_service" "${allowed_services[@]}" || die "image mapping references a non-allowlisted service: $mapped_service"
    ! contains_value "$mapped_service" "${image_services[@]:-}" || die "duplicate image mapping for service: $mapped_service"
    validate_image_reference "$mapped_image"
    image_services+=("$mapped_service")
    image_references+=("$mapped_image")
  done <<<"$AUTOUPDATE_ALLOWED_IMAGES"

  for service in "${allowed_services[@]}"; do
    image_for_service "$service" >/dev/null || die "allowed service has no image mapping: $service"
  done

  validate_command AUTOUPDATE_UP_COMMAND "$AUTOUPDATE_UP_COMMAND"
  validate_command AUTOUPDATE_HEALTH_COMMAND "$AUTOUPDATE_HEALTH_COMMAND"
  validate_command AUTOUPDATE_ROLLBACK_COMMAND "$AUTOUPDATE_ROLLBACK_COMMAND"
  validate_profile_images
}

validate_tools() {
  command -v docker >/dev/null 2>&1 || die "docker is required"
  command -v flock >/dev/null 2>&1 || die "flock is required"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
  docker buildx version >/dev/null 2>&1 || die "docker buildx is required for manifest inspection"
}

validate_rendered_services() {
  local -a rendered_services rendered_images rendered_platforms
  mapfile -t rendered_services < <(run_compose config --services)
  local service image expected_image rendered_platform
  for service in "${allowed_services[@]}"; do
    contains_value "$service" "${rendered_services[@]}" || die "allowlisted service is absent from rendered Compose config: $service"
    mapfile -t rendered_images < <(run_compose config --images "$service")
    ((${#rendered_images[@]} == 1)) || die "allowlisted service must render exactly one image: $service"
    image="${rendered_images[0]}"
    expected_image="$(image_for_service "$service")"
    [[ "$image" == "$expected_image" ]] || die "rendered image is not the allowlisted image for $service"
    mapfile -t rendered_platforms < <(run_compose config "$service" | awk '/^[[:space:]]*platform:[[:space:]]*/ { sub(/^[[:space:]]*platform:[[:space:]]*/, ""); gsub(/["[:space:]]/, ""); print }')
    for rendered_platform in "${rendered_platforms[@]}"; do
      [[ "$rendered_platform" == "$AUTOUPDATE_TARGET_PLATFORM" ]] \
        || die "rendered service platform conflicts with AUTOUPDATE_TARGET_PLATFORM for $service: $rendered_platform"
    done
  done
}

running_image_id() {
  local service="$1"
  local container_id image_id
  container_id="$(run_compose ps -q "$service")"
  [[ -n "$container_id" ]] || die "allowlisted service is not running: $service"
  image_id="$(docker inspect --format '{{.Image}}' "$container_id")" || die "could not inspect running service: $service"
  [[ -n "$image_id" ]] || die "running service has no image id: $service"
  printf '%s' "$image_id"
}

digest_for_image_id() {
  local image_id="$1"
  local image_reference="$2"
  local repository digest_line
  repository="$(reference_repository "$image_reference")"
  while IFS= read -r digest_line; do
    [[ "$digest_line" == "$repository@"* ]] || continue
    digest_line="${digest_line#*@}"
    is_digest "$digest_line" || continue
    printf '%s' "$digest_line"
    return 0
  done < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id")
  die "running image has no manifest digest for $repository"
}

remote_manifest_digest() {
  local image_reference="$1"
  local digest
  digest="$(DOCKER_DEFAULT_PLATFORM="$AUTOUPDATE_TARGET_PLATFORM" docker buildx imagetools inspect --format '{{printf "%s" .Manifest.Digest}}' "$image_reference")" \
    || die "registry or manifest lookup failed for $image_reference"
  digest="$(trim "$digest")"
  is_digest "$digest" || die "registry did not return a manifest digest for $image_reference"
  printf '%s' "$digest"
}

remote_oci_revision() {
  local image_reference="$1"
  local revision
  revision="$(DOCKER_DEFAULT_PLATFORM="$AUTOUPDATE_TARGET_PLATFORM" docker buildx imagetools inspect \
    --format '{{with index .Image.Config.Labels "org.opencontainers.image.revision"}}{{printf "%s" .}}{{end}}' "$image_reference")" \
    || die "could not read OCI revision for $image_reference"
  revision="$(trim "$revision")"
  [[ -n "$revision" && "$revision" != "<no value>" ]] || die "image lacks org.opencontainers.image.revision: $image_reference"
  printf '%s' "$revision"
}

linux_amd64_manifest_digest() {
  local media_type platform_digest direct_platform
  media_type="$(docker buildx imagetools inspect --format '{{printf "%s" .Manifest.MediaType}}' "$1")" \
    || die "could not inspect manifest media type for $1"
  media_type="$(trim "$media_type")"

  case "$media_type" in
    *manifest.list*|*image.index*)
      ;;
    *)
      direct_platform="$(docker buildx imagetools inspect --format '{{printf "%s/%s" .Image.OS .Image.Architecture}}' "$1")" \
        || die "could not inspect image platform for $1"
      [[ "$(trim "$direct_platform")" == "linux/amd64" ]] \
        || die "image does not provide a Linux/amd64 manifest: $1"
      remote_manifest_digest "$1"
      return
      ;;
  esac

  platform_digest="$(docker buildx imagetools inspect \
    --format '{{range .Manifest.Manifests}}{{if and (eq .Platform.OS "linux") (eq .Platform.Architecture "amd64")}}{{printf "%s" .Digest}}{{end}}{{end}}' \
    "$1")" || die "could not inspect Linux/amd64 manifest for $1"
  platform_digest="$(trim "$platform_digest")"
  if [[ -n "$platform_digest" ]]; then
    is_digest "$platform_digest" || die "Linux/amd64 manifest digest is invalid for $1"
    printf '%s' "$platform_digest"
    return
  fi
  die "image index does not provide a Linux/amd64 manifest: $1"
}

validate_artifactory_mapping() {
  local pull_reference="$1"
  local pull_digest="$2"
  local remote_revision="$3"
  local entry mapped_pull mapped_digest source_reference source_digest platform revision extra
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    entry="$(trim "$entry")"
    [[ -z "$entry" || "$entry" == \#* ]] && continue
    IFS='|' read -r mapped_pull mapped_digest source_reference source_digest platform revision extra <<<"$entry"
    [[ -z "${extra:-}" ]] || die "invalid Artifactory mapping record"
    [[ "$mapped_pull" == "$pull_reference" && "$mapped_digest" == "$pull_digest" ]] || continue
    [[ "$source_reference" == sv4.art/repo.ops/* ]] || die "Artifactory mapping source must be sv4.art/repo.ops"
    is_digest "$source_digest" || die "Artifactory mapping source digest is invalid"
    [[ "$source_reference" == *"@$source_digest" ]] || die "Artifactory mapping source reference must contain its source digest"
    [[ "$platform" == "linux/amd64" ]] || die "Artifactory mapping platform must be linux/amd64"
    [[ -n "$revision" && "$revision" == "$remote_revision" ]] || die "OCI revision does not match the protected Artifactory mapping"
    return 0
  done <"$AUTOUPDATE_ARTIFACTORY_MAPPING_PATH"
  die "no protected source-to-pull mapping for $pull_reference@$pull_digest"
}

validate_remote_profile_contract() {
  local image_reference="$1"
  local remote_digest="$2"
  [[ "$AUTOUPDATE_REGISTRY_PROFILE" == "artifactory-repo-ops" ]] || return 0
  local platform_digest revision
  platform_digest="$(linux_amd64_manifest_digest "$image_reference")"
  revision="$(remote_oci_revision "${image_reference}@${platform_digest}")"
  validate_artifactory_mapping "$image_reference" "$remote_digest" "$revision"
}

capture_prior_images() {
  local index service image image_id backup_tag
  for index in "${!changed_services[@]}"; do
    service="${changed_services[$index]}"
    image="${changed_images[$index]}"
    image_id="${changed_image_ids[$index]}"
    backup_tag="${AUTOUPDATE_ROLLBACK_IMAGE_PREFIX}/${service}:${run_id}"
    docker image tag "$image_id" "$backup_tag" || die "could not retain prior image for $service"
    rollback_tags+=("$backup_tag")
    log info "status=retained service=$service previous_digest=${changed_current_digests[$index]}"
  done
}

restore_prior_images() {
  local index service image image_id
  for index in "${!changed_services[@]}"; do
    service="${changed_services[$index]}"
    image="${changed_images[$index]}"
    image_id="${changed_image_ids[$index]}"
    docker image tag "$image_id" "$image" || die "rollback could not restore prior image tag for $service"
  done
  run_app_command "$AUTOUPDATE_ROLLBACK_COMMAND" 1 "${changed_services[@]}" \
    || die "rollback command failed after restoring prior image tags"
  run_app_command "$AUTOUPDATE_HEALTH_COMMAND" 1 "${changed_services[@]}" \
    || die "rollback health command failed after restoring prior image tags"
  log warn "status=rolled-back services=$(IFS=,; printf '%s' "${changed_services[*]}")"
}

verify_pulled_digests() {
  local index actual_digest
  for index in "${!changed_services[@]}"; do
    actual_digest="$(digest_for_image_id "$(docker image inspect --format '{{.Id}}' "${changed_images[$index]}")" "${changed_images[$index]}")"
    if [[ "$actual_digest" != "${changed_remote_digests[$index]}" ]]; then
      log error "pulled image digest did not match the inspected remote manifest for ${changed_services[$index]}"
      return 1
    fi
  done
}

record_deployment() {
  local record_directory temporary_record index running_id deployed_digest
  record_directory="$(dirname -- "$AUTOUPDATE_DIGEST_RECORD_PATH")"
  mkdir -p -- "$record_directory"
  umask 077
  temporary_record="$(mktemp "${AUTOUPDATE_DIGEST_RECORD_PATH}.tmp.XXXXXX")"
  {
    printf '# recorded_at=%s profile=%s platform=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$AUTOUPDATE_REGISTRY_PROFILE" "$AUTOUPDATE_TARGET_PLATFORM"
    for index in "${!changed_services[@]}"; do
      running_id="$(running_image_id "${changed_services[$index]}")"
      deployed_digest="$(digest_for_image_id "$running_id" "${changed_images[$index]}")"
      printf '%s|%s|%s|%s|%s|%s\n' \
        "${changed_services[$index]}" \
        "${changed_images[$index]}" \
        "${changed_current_digests[$index]}" \
        "$deployed_digest" \
        "${changed_remote_digests[$index]}" \
        "${rollback_tags[$index]}"
    done
  } >"$temporary_record"
  mv -- "$temporary_record" "$AUTOUPDATE_DIGEST_RECORD_PATH"
}

prune_superseded_rollback_tags() {
  local recorded_service recorded_image recorded_current_digest recorded_deployed_digest
  local recorded_remote_digest recorded_tag extra_field
  local service repository listed_tags tag retained_count index next_tag swap
  local -a recorded_rollback_tags=()
  local -a service_rollback_tags=()
  local -a sorted_rollback_tags=()

  while IFS='|' read -r recorded_service recorded_image recorded_current_digest \
    recorded_deployed_digest recorded_remote_digest recorded_tag extra_field; do
    [[ -z "$recorded_service" || "$recorded_service" == \#* ]] && continue
    [[ -z "$extra_field" ]] || continue
    contains_value "$recorded_service" "${allowed_services[@]}" || continue
    is_rollback_tag_for_service "$recorded_tag" "$recorded_service" || continue
    contains_value "$recorded_tag" "${recorded_rollback_tags[@]:-}" \
      || recorded_rollback_tags+=("$recorded_tag")
  done <"$AUTOUPDATE_DIGEST_RECORD_PATH"

  for service in "${allowed_services[@]}"; do
    repository="${AUTOUPDATE_ROLLBACK_IMAGE_PREFIX}/${service}"
    if ! listed_tags="$(docker image ls --format '{{.Repository}}:{{.Tag}}' "$repository")"; then
      log warn "status=retention-prune-skipped service=$service reason=image-list-failed"
      continue
    fi

    service_rollback_tags=()
    while IFS= read -r tag || [[ -n "$tag" ]]; do
      tag="$(trim "$tag")"
      is_rollback_tag_for_service "$tag" "$service" || continue
      contains_value "$tag" "${service_rollback_tags[@]:-}" \
        || service_rollback_tags+=("$tag")
    done <<<"$listed_tags"
    ((${#service_rollback_tags[@]} > 0)) || continue

    sorted_rollback_tags=("${service_rollback_tags[@]}")
    for ((index = 0; index < ${#sorted_rollback_tags[@]}; index++)); do
      for ((next_tag = index + 1; next_tag < ${#sorted_rollback_tags[@]}; next_tag++)); do
        if [[ "${sorted_rollback_tags[$next_tag]}" > "${sorted_rollback_tags[$index]}" ]]; then
          swap="${sorted_rollback_tags[$index]}"
          sorted_rollback_tags[$index]="${sorted_rollback_tags[$next_tag]}"
          sorted_rollback_tags[$next_tag]="$swap"
        fi
      done
    done

    retained_count=0
    for tag in "${sorted_rollback_tags[@]}"; do
      if contains_value "$tag" "${recorded_rollback_tags[@]:-}"; then
        ((retained_count += 1))
        continue
      fi
      if ((retained_count < AUTOUPDATE_ROLLBACK_IMAGE_RETENTION)); then
        ((retained_count += 1))
        continue
      fi
      if docker image rm "$tag" >/dev/null; then
        log info "status=rollback-tag-pruned service=$service tag=$tag"
      else
        log warn "status=retention-prune-skipped service=$service tag=$tag reason=image-remove-failed"
      fi
    done
  done
}

run_cycle() {
  local service image current_id current_digest remote_digest
  changed_services=()
  changed_images=()
  changed_image_ids=()
  changed_current_digests=()
  changed_remote_digests=()
  rollback_tags=()

  validate_rendered_services
  for service in "${allowed_services[@]}"; do
    image="$(image_for_service "$service")"
    current_id="$(running_image_id "$service")"
    current_digest="$(digest_for_image_id "$current_id" "$image")"
    remote_digest="$(remote_manifest_digest "$image")"
    validate_remote_profile_contract "$image" "$remote_digest"
    if [[ "$current_digest" == "$remote_digest" ]]; then
      log info "status=noop service=$service digest=$current_digest"
      continue
    fi
    changed_services+=("$service")
    changed_images+=("$image")
    changed_image_ids+=("$current_id")
    changed_current_digests+=("$current_digest")
    changed_remote_digests+=("$remote_digest")
    log info "status=update-available service=$service current=$current_digest remote=$remote_digest"
  done

  if ((${#changed_services[@]} == 0)); then
    log info "status=noop reason=all-allowlisted-services-match-remote"
    return "$AUTOUPDATE_NOOP_EXIT"
  fi

  if "$DRY_RUN"; then
    log info "status=dry-run action=would-update services=$(IFS=,; printf '%s' "${changed_services[*]}")"
    return 0
  fi

  run_id="$(date -u +'%Y%m%dT%H%M%SZ')"
  capture_prior_images
  install_rollback_traps
  if ! run_compose pull "${changed_services[@]}"; then
    rollback_after_candidate_failure
    die "pull failed; prior image tags were restored"
  fi
  if ! verify_pulled_digests; then
    rollback_after_candidate_failure
    die "pulled images did not match inspected remote manifests; prior images were restored"
  fi
  if ! run_app_command "$AUTOUPDATE_UP_COMMAND" 0 "${changed_services[@]}"; then
    rollback_after_candidate_failure
    die "up command failed; prior images were restored"
  fi
  if ! run_app_command "$AUTOUPDATE_HEALTH_COMMAND" 0 "${changed_services[@]}"; then
    rollback_after_candidate_failure
    die "health command failed; prior images were restored"
  fi
  record_deployment
  prune_superseded_rollback_tags
  clear_rollback_traps
  log info "status=updated services=$(IFS=,; printf '%s' "${changed_services[*]}")"
}

parse_arguments() {
  while (($#)); do
    case "$1" in
      --config)
        (($# >= 2)) || die "--config requires a path"
        CONFIG_PATH="$2"
        shift 2
        ;;
      --once)
        RUN_ONCE=true
        shift
        ;;
      --dry-run)
        DRY_RUN=true
        RUN_ONCE=true
        shift
        ;;
      --interval)
        (($# >= 2)) || die "--interval requires seconds"
        INTERVAL_OVERRIDE="$2"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
}

main() {
  parse_arguments "$@"
  [[ -r "$CONFIG_PATH" ]] || die "configuration is unreadable: $CONFIG_PATH"
  set +x
  # Configuration is a locally reviewed deployment artifact, not a secret source.
  source "$CONFIG_PATH"

  declare -a compose_arguments=()
  declare -a allowed_services=()
  declare -a checked_services=()
  declare -a image_services=()
  declare -a image_references=()
  declare -a changed_services=()
  declare -a changed_images=()
  declare -a changed_image_ids=()
  declare -a changed_current_digests=()
  declare -a changed_remote_digests=()
  declare -a rollback_tags=()
  validate_configuration
  validate_tools

  local interval="${INTERVAL_OVERRIDE:-${AUTOUPDATE_INTERVAL_SECONDS:-0}}"
  [[ "$interval" =~ ^[0-9]+$ ]] || die "interval must be a non-negative integer"
  if [[ "$interval" == 0 ]]; then
    RUN_ONCE=true
  fi
  if ! "$DRY_RUN"; then
    mkdir -p -- "$(dirname -- "$AUTOUPDATE_LOCK_PATH")"
  fi
  exec {lock_fd}>"$AUTOUPDATE_LOCK_PATH"
  flock -n "$lock_fd" || {
    log error "status=error reason=concurrent-run"
    exit "$AUTOUPDATE_LOCKED_EXIT"
  }

  if "$RUN_ONCE"; then
    run_cycle
    return $?
  fi

  while true; do
    if run_cycle; then
      :
    else
      cycle_status=$?
      [[ "$cycle_status" == "$AUTOUPDATE_NOOP_EXIT" ]] || log error "status=cycle-failed exit=$cycle_status"
    fi
    sleep "$interval"
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
