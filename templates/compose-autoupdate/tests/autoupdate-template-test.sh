#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEMPLATE="${ROOT}/templates/compose-autoupdate/autoupdate.sh"
SERVICE_TEMPLATE="${ROOT}/templates/compose-autoupdate/systemd/autoupdate.service"
TEMPLATE_README="${ROOT}/templates/compose-autoupdate/README.md"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT

PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %s - %s\n' "$PASS_COUNT" "$1"
}

fail() {
  printf 'not ok %s - %s\n' "$((PASS_COUNT + 1))" "$1" >&2
  exit 1
}

assert_status() {
  local expected="$1"
  shift
  set +e
  "$@" >"$TEST_DIR/output" 2>&1
  local actual=$?
  set -e
  [[ "$actual" == "$expected" ]] || {
    cat "$TEST_DIR/output" >&2
    fail "expected exit $expected, got $actual"
  }
}

assert_contains() {
  local expected="$1"
  local file="$2"
  grep -F -- "$expected" "$file" >/dev/null || fail "expected '$expected' in $file"
}

make_fixture() {
  TEST_DIR="$(mktemp -d "${TMP_ROOT}/case.XXXXXX")"
  APP_DIR="${TEST_DIR}/app"
  BIN_DIR="${TEST_DIR}/bin"
  ACTION_LOG="${TEST_DIR}/actions"
  mkdir -p "$APP_DIR" "$BIN_DIR" "${TEST_DIR}/state"
  : >"$ACTION_LOG"
  : >"${APP_DIR}/compose.yaml"
  : >"${APP_DIR}/compose.env"

  cat >"${APP_DIR}/up.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'up rollback=%s services=%s platform=%s\n' "${AUTOUPDATE_ROLLBACK:-0}" "${AUTOUPDATE_SERVICES:-}" "${DOCKER_DEFAULT_PLATFORM:-}" >>"$ACTION_LOG"
SCRIPT
  cat >"${APP_DIR}/healthcheck.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'health rollback=%s services=%s\n' "${AUTOUPDATE_ROLLBACK:-0}" "${AUTOUPDATE_SERVICES:-}" >>"$ACTION_LOG"
[[ "${MOCK_HEALTH_FAIL:-0}" != 1 ]]
SCRIPT
  chmod +x "${APP_DIR}/up.sh" "${APP_DIR}/healthcheck.sh"

  cat >"${BIN_DIR}/docker" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
digest() {
  printf 'sha256:%064d' "$1"
}
case "$1" in
  compose)
    shift
    if [[ "$1" == version ]]; then
      exit 0
    fi
    command=""
    for token in "$@"; do
      case "$token" in config|ps|pull) command="$token"; break;; esac
    done
    case "$command" in
      config)
        if [[ " $* " == *" --services "* ]]; then
          printf 'api\n'
        elif [[ " $* " == *" --images "* ]]; then
          printf '%s\n' "${MOCK_RENDERED_IMAGE:-ghcr.io/example/example-app-api:dev}"
        else
          printf 'services:\n  api:\n'
          if [[ -n "${MOCK_RENDERED_PLATFORM:-}" ]]; then
            printf '    platform: %s\n' "$MOCK_RENDERED_PLATFORM"
          fi
        fi
        ;;
      ps) printf 'container-api\n' ;;
      pull) printf 'compose-pull\n' >>"$ACTION_LOG" ;;
    esac
    ;;
  buildx)
    [[ "$2" == version ]] && exit 0
    if [[ "$*" == *"org.opencontainers.image.revision"* ]]; then
      printf '%s\n' "${MOCK_REVISION:-deadbeef}"
    elif [[ "$*" == *".Manifest.MediaType"* ]]; then
      printf '%s\n' "application/vnd.oci.image.index.v1+json"
    elif [[ "$*" == *".Image.OS"* ]]; then
      printf '%s\n' "linux/amd64"
    else
      digest "${MOCK_REMOTE_DIGEST_NUMBER:-2}"
    fi
    ;;
  inspect)
    printf 'image-api\n'
    ;;
  image)
    case "$2" in
      inspect)
        if [[ "$*" == *"{{.Id}}"* ]]; then
          printf 'image-api\n'
        else
          active_digest_number="${MOCK_LOCAL_DIGEST_NUMBER:-1}"
          if grep -q '^compose-pull$' "$ACTION_LOG"; then
            active_digest_number="${MOCK_REMOTE_DIGEST_NUMBER:-2}"
          fi
          repository="${MOCK_RENDERED_IMAGE:-ghcr.io/example/example-app-api:dev}"
          repository="${repository%:*}"
          printf '%s@' "$repository"
          digest "$active_digest_number"
          printf '\n'
        fi
        ;;
      tag) printf 'image-tag\n' >>"$ACTION_LOG" ;;
    esac
    ;;
  *) exit 0 ;;
esac
SCRIPT
  cat >"${BIN_DIR}/flock" <<'SCRIPT'
#!/usr/bin/env bash
exit "${MOCK_FLOCK_EXIT:-0}"
SCRIPT
  chmod +x "${BIN_DIR}/docker" "${BIN_DIR}/flock"

  cat >"${TEST_DIR}/autoupdate.conf" <<EOF
AUTOUPDATE_WORKDIR=$APP_DIR
AUTOUPDATE_COMPOSE_FILES="compose.yaml"
AUTOUPDATE_COMPOSE_ENV_FILES="compose.env"
AUTOUPDATE_ALLOWED_SERVICES="api"
AUTOUPDATE_ALLOWED_IMAGES="
api=ghcr.io/example/example-app-api:dev
"
AUTOUPDATE_REGISTRY_PROFILE=ghcr-dev
AUTOUPDATE_GHCR_MUTABLE_TAG=dev
AUTOUPDATE_TARGET_PLATFORM=linux/amd64
AUTOUPDATE_UP_COMMAND=./up.sh
AUTOUPDATE_HEALTH_COMMAND=./healthcheck.sh
AUTOUPDATE_ROLLBACK_COMMAND=./up.sh
AUTOUPDATE_LOCK_PATH=$TEST_DIR/state/update.lock
AUTOUPDATE_DIGEST_RECORD_PATH=$TEST_DIR/state/digests.txt
AUTOUPDATE_ROLLBACK_IMAGE_PREFIX=autoupdate-rollback/example
AUTOUPDATE_INTERVAL_SECONDS=0
EOF
}

run_template() {
  PATH="${BIN_DIR}:${PATH}" ACTION_LOG="$ACTION_LOG" "$TEMPLATE" --config "${TEST_DIR}/autoupdate.conf" "$@"
}

make_fixture
printf '\nAUTOUPDATE_WORKDIR=/not/a/working/directory\n' >>"${TEST_DIR}/autoupdate.conf"
assert_status 1 run_template --once
assert_contains "AUTOUPDATE_WORKDIR does not exist" "${TEST_DIR}/output"
pass "requires an existing working directory"

make_fixture
assert_status 1 run_template --not-a-mode
assert_contains "unknown argument: --not-a-mode" "${TEST_DIR}/output"
pass "rejects unknown arguments"

make_fixture
cat >>"${TEST_DIR}/autoupdate.conf" <<'EOF'
AUTOUPDATE_ALLOWED_IMAGES="
api=ghcr.io/example/example-app-api:latest@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
"
EOF
assert_status 1 run_template --once
assert_contains "immutable digest pins" "${TEST_DIR}/output"
pass "rejects immutable digest pins"

make_fixture
MOCK_RENDERED_IMAGE="ghcr.io/example/untrusted:dev" assert_status 1 run_template --once
assert_contains "rendered image is not the allowlisted image" "${TEST_DIR}/output"
pass "rejects unrecognized rendered images"

make_fixture
MOCK_RENDERED_PLATFORM=linux/arm64 assert_status 1 run_template --once
assert_contains "rendered service platform conflicts with AUTOUPDATE_TARGET_PLATFORM" "${TEST_DIR}/output"
pass "rejects a rendered Compose platform conflict"

make_fixture
MOCK_LOCAL_DIGEST_NUMBER=2 assert_status 10 run_template --once
assert_contains "status=noop reason=all-allowlisted-services-match-remote" "${TEST_DIR}/output"
pass "accepts the explicitly configured dev tag and returns the documented no-op status"

make_fixture
cat >>"${TEST_DIR}/autoupdate.conf" <<'EOF'
AUTOUPDATE_ALLOWED_IMAGES="
api=ghcr.io/example/example-app-api:latest
"
EOF
MOCK_RENDERED_IMAGE="ghcr.io/example/example-app-api:latest" assert_status 1 run_template --once
assert_contains "must use explicitly configured mutable tag dev" "${TEST_DIR}/output"
pass "rejects latest without an explicit latest allowlist"

make_fixture
cat >>"${TEST_DIR}/autoupdate.conf" <<'EOF'
AUTOUPDATE_ALLOWED_IMAGES="
api=ghcr.io/example/example-app-api:latest
"
AUTOUPDATE_GHCR_MUTABLE_TAG=latest
EOF
MOCK_RENDERED_IMAGE="ghcr.io/example/example-app-api:latest" MOCK_LOCAL_DIGEST_NUMBER=2 assert_status 10 run_template --once
assert_contains "status=noop reason=all-allowlisted-services-match-remote" "${TEST_DIR}/output"
pass "allows latest only after explicit configuration"

make_fixture
cat >>"${TEST_DIR}/autoupdate.conf" <<'EOF'
AUTOUPDATE_ALLOWED_IMAGES="
api=ghcr.io/example/example-app-api:candidate
"
EOF
MOCK_RENDERED_IMAGE="ghcr.io/example/example-app-api:candidate" assert_status 1 run_template --once
assert_contains "must use explicitly configured mutable tag dev" "${TEST_DIR}/output"
pass "rejects an unallowlisted mutable tag"

make_fixture
cat >>"${TEST_DIR}/autoupdate.conf" <<EOF
AUTOUPDATE_ALLOWED_IMAGES="
api=repo.ops/team/example-app-api:latest
"
AUTOUPDATE_REGISTRY_PROFILE=artifactory-repo-ops
AUTOUPDATE_ARTIFACTORY_MAPPING_PATH=${TEST_DIR}/repo-ops-mapping.txt
EOF
printf 'repo.ops/team/example-app-api:latest|sha256:%064d|sv4.art/repo.ops/team/example-app-api@sha256:%064d|sha256:%064d|linux/amd64|deadbeef\n' 2 42 42 >"${TEST_DIR}/repo-ops-mapping.txt"
MOCK_RENDERED_IMAGE="repo.ops/team/example-app-api:latest" assert_status 0 run_template --dry-run
assert_contains "status=dry-run action=would-update" "${TEST_DIR}/output"
pass "accepts only protected repo.ops Artifactory runtime mappings"

make_fixture
cat >>"${TEST_DIR}/autoupdate.conf" <<EOF
AUTOUPDATE_ALLOWED_IMAGES="
api=sv4.art/repo.ops/team/example-app-api:latest
"
AUTOUPDATE_REGISTRY_PROFILE=artifactory-repo-ops
AUTOUPDATE_ARTIFACTORY_MAPPING_PATH=${TEST_DIR}/repo-ops-mapping.txt
EOF
: >"${TEST_DIR}/repo-ops-mapping.txt"
assert_status 1 run_template --once
assert_contains "runtime pulls must use repo.ops" "${TEST_DIR}/output"
pass "rejects sv4.art as an Artifactory runtime pull host"

make_fixture
assert_status 0 run_template --dry-run
assert_contains "status=dry-run action=would-update" "${TEST_DIR}/output"
[[ ! -s "$ACTION_LOG" ]] || fail "dry run performed an action"
pass "dry run performs no pull, restart, or tag"

make_fixture
MOCK_HEALTH_FAIL=1 assert_status 1 run_template --once
assert_contains "up rollback=0 services=api platform=linux/amd64" "$ACTION_LOG"
assert_contains "up rollback=1 services=api" "$ACTION_LOG"
assert_contains "image-tag" "$ACTION_LOG"
pass "health failure restores prior image tags and invokes rollback"

make_fixture
set +e
PATH="${BIN_DIR}:${PATH}" ACTION_LOG="$ACTION_LOG" bash -c '
  source "$1"
  source "$2"
  changed_services=(api)
  changed_images=(ghcr.io/example/example-app-api:dev)
  changed_image_ids=(image-api)
  changed_current_digests=(sha256:0000000000000000000000000000000000000000000000000000000000000001)
  changed_remote_digests=(sha256:0000000000000000000000000000000000000000000000000000000000000002)
  rollback_tags=(autoupdate-rollback/example/api:prior)
  install_rollback_traps
  handle_interrupted_update TERM
' bash "$TEMPLATE" "${TEST_DIR}/autoupdate.conf" >"${TEST_DIR}/output" 2>&1
signal_status=$?
set -e
[[ "$signal_status" == 143 ]] || fail "expected signal rollback exit 143, got $signal_status"
assert_contains "status=interrupted signal=TERM action=restore-prior-images" "${TEST_DIR}/output"
assert_contains "up rollback=1 services=api platform=linux/amd64" "$ACTION_LOG"
assert_contains "image-tag" "$ACTION_LOG"
pass "TERM rollback restores prior tags through the configured rollback path"

make_fixture
MOCK_FLOCK_EXIT=1 assert_status 75 run_template --once
assert_contains "reason=concurrent-run" "${TEST_DIR}/output"
pass "rejects concurrent runs"

assert_contains "SuccessExitStatus=10" "$SERVICE_TEMPLATE"
assert_contains "TimeoutStopSec=2min" "$SERVICE_TEMPLATE"
assert_contains "loginctl enable-linger" "$TEMPLATE_README"
assert_contains "trap 'handle_interrupted_update TERM' TERM" "$TEMPLATE"
pass "documents durable user timer operation and no-op service success"

printf '1..%s\n' "$PASS_COUNT"
