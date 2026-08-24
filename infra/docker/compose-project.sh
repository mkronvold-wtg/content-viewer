#!/usr/bin/env bash

# Shared by Dockerhost-only wrappers before any Compose command is issued.
readonly CONTENT_VIEWER_DEPLOYMENT_PROJECT=content-viewer

validate_project_name() {
  local candidate="${AUTOUPDATE_PROJECT_NAME:-}"

  [[ "$candidate" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || {
    printf 'AUTOUPDATE_PROJECT_NAME must be a valid Compose project name.\n' >&2
    return 2
  }
  [[ "$candidate" == "$CONTENT_VIEWER_DEPLOYMENT_PROJECT" ]] || {
    printf 'AUTOUPDATE_PROJECT_NAME must be %s to reuse the existing persistent volume.\n' "$CONTENT_VIEWER_DEPLOYMENT_PROJECT" >&2
    return 2
  }

  PROJECT="$candidate"
  export PROJECT
}
