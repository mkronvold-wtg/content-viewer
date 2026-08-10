# Phase 0 Operations and Security Guardrails

This document records the repository baseline and the deployment evidence that
is still pending. It is intentionally not evidence that the dockerhost, proxy,
registry, or GitHub settings have been inspected. No Phase 0 command in this
repository was run against a deployment target.

## Repository-verified baseline

| Source | Verified repository behavior |
| --- | --- |
| `Dockerfile` | Uses the official `node:26-alpine3.23` image pinned to an immutable digest for separate dependency and runtime stages. The runtime installs Git and CA certificates, retains only production dependencies and required server/theme assets, creates `/app/content` owned by `node`, runs as `USER node`, and health-checks `GET /api/health`. |
| `docker-compose.yml` | Local Compose builds the service, tags it `content-viewer:local`, binds `127.0.0.1:8080:8080`, and mounts the logical named volume `content-viewer-content` at `/app/content`. |
| `docker-compose.npm.yml` | The dockerhost/NPM-proxy target is image-only: it requires `CONTENT_VIEWER_IMAGE`, mounts the same logical volume at `/app/content`, exposes port `8080` only to Compose networks, and joins the external network named `npm-proxy`. It has no host `ports` mapping. |
| `README.md` | Documents the local build-oriented Compose command and links this runbook for the image-only Dockerhost procedure. |
| `package.json` | `npm run build` and `npm run check` syntax-check `server.mjs` using committed inputs. `npm run test:contracts` runs the explicit deterministic Node contract suite, and `npm run test:container` smoke-tests a supplied final image with an isolated no-network container and volume. Theme refresh is a separate maintenance action that requires an immutable full upstream commit SHA, as described in `README.md`. |
| `.env.example` | Configures the Git-backed content clone under `/app/content` and identifies `CONTENT_VIEWER_GITHUB_TOKEN` as a read-only content-repository credential. |
| `server.mjs` | Defines the routes and clone/refresh behavior in the route matrix below. |

## Compose targets and deployment boundary

| Target | Repository command or configuration | Boundary |
| --- | --- | --- |
| Local development | `docker compose up -d --build` from `README.md` with `docker-compose.yml` | Host-only port binding at `127.0.0.1:8080`; image tag is `content-viewer:local`. |
| Dockerhost behind NPM/proxy | `docker-compose.npm.yml` and `infra/docker/up.sh` | No host port is published by this file. The service is reachable on the external Compose network `npm-proxy` as `content-viewer:8080`. The Compose target is image-only and requires `CONTENT_VIEWER_IMAGE`; `up.sh` is the only repository restart path and never builds or removes the persistent volume. |

The logical volume declaration is `content-viewer-content` in both Compose
files. Because neither file sets a top-level Compose `name`, the physical
volume name is project-scoped and must be discovered on the dockerhost rather
than guessed from the logical name.

**Deployment-only operator action:** the dockerhost owner must preserve the
existing Compose project identity when deploying from the approved repository
directory. It must match the project that owns the physical content volume; do
not guess it from the logical `content-viewer-content` declaration. The
image-only wrapper is:

```sh
./infra/docker/up.sh --services content-viewer
```

This is an operator procedure, not a claim that the repository knows the
current project or deployment directory.

## Pending baseline evidence

Capture the following before any runtime, CI, scanner, or artifact-policy
change. Store raw evidence with its collection time, command, and operator;
record "not available" when a fact cannot be collected. Do not replace an
image digest with a mutable tag.

| Evidence | Required record | Deployment-only collection action |
| --- | --- | --- |
| Deployed image digest | Container image reference, immutable registry digest if present, and local image ID. | Inspect the running container's configured image and image ID with `docker inspect --format '{{.Config.Image}} {{.Image}}' "$CONTAINER"`, then inspect repository digests with `docker image inspect --format '{{json .RepoDigests}}' "$IMAGE"`. |
| Final-image scan JSON | Unmodified JSON, scanner/version and database metadata, image digest scanned, collection time, and result status. | Pending scanner ownership and configuration; Phase 0 does not install or run a scanner. |
| Lockfile scan JSON | Unmodified JSON for `package-lock.json`, scanner/version and database metadata, lockfile commit or SHA-256, collection time, and result status. | Pending scanner ownership and configuration; Phase 0 does not install or run a scanner. |
| Compose project and named volume | Actual project name, service container, physical volume name, mount destination, and volume labels. | Identify the mounted volume with `docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/app/content"}}{{.Name}}{{end}}{{end}}'`; inspect its labels with `docker volume inspect "$VOLUME"`. |
| Container user and group | Runtime `id` output plus the Dockerfile expectation (`node:node`). | Run `docker compose -p "$PROJECT" -f docker-compose.npm.yml exec -T content-viewer id`. |
| Health response | Raw HTTP status and response from `GET /api/health`. A healthy application response is JSON with `ok: true`; it also reports configured repositories and index state. | From the running container, request `http://127.0.0.1:8080/api/health` using the same endpoint as the `Dockerfile` health check. Capture the status and body. |

The commands in this table require dockerhost access and are not verified by
this repository. They are safe inspection guidance only after the operator
has supplied the actual `PROJECT`, `CONTAINER`, `IMAGE`, and `VOLUME` values.

## Persistent-volume safety contract

`/app/content` is persistent state: it holds the Git content clone used for
initial clone, `git pull --ff-only`, and indexing. Treat its physical named
volume as production data.

1. **Never run `docker compose down -v`** for either deployment target. The
   `-v` option removes named volumes and can destroy the content clone.
2. Identify the actual project and physical mounted volume using the
   inspection action in the evidence table. Do not infer either from
   `content-viewer-content` alone.
3. Before a runtime change, the dockerhost owner must make a restorable backup
   of that physical volume with an approved host backup procedure. Record the
   archive or snapshot identifier, source volume, creation time, checksum or
   storage integrity evidence, and restore procedure.
4. Before promotion, the dockerhost owner must restore that backup into a
   **copied, non-production volume** and perform a forward/rollback rehearsal:
   deploy the proposed runtime against the copy, collect the health response,
   exercise the expected clone/index behavior, redeploy the prior runtime
   against the same copy, and collect health again.
5. The rehearsal record must identify the source volume, copied-volume name,
   proposed and prior image digests, backup/restore evidence, health results,
   and the operator. A failed or missing rehearsal blocks the runtime change.

Backup, restore, copied-volume creation, and deployment switching are
deployment-only operator actions. This repository supplies no backup image,
host storage location, Compose override, or verified dockerhost command, so
it does not prescribe unverified commands for those destructive operations.

## Development Dockerhost auto-update (not installed)

This repository contains a **development-only mutable GHCR `:dev` channel**;
it is not installed by this change, is not a production promotion mechanism,
and has no Artifactory configuration. The Dockerhost target accepts only
`ghcr.io/mkronvold-wtg/content-viewer:dev` on `linux/amd64`. The updater
rejects `latest`, unrecognized rendered images, and immutable digest pins.

The reusable updater is vendored without modification from
[`mkronvold/techstack`](https://github.com/mkronvold/techstack/tree/8303ab1a7aaf87a3b2409e4fb9bd804a265746a6/templates/compose-autoupdate)
at `8303ab1a7aaf87a3b2409e4fb9bd804a265746a6`, from
`templates/compose-autoupdate` on its synchronized `main` branch. The
`test/dev-autoupdate.test.mjs` integrity check records every vendored file's
SHA-256. Future updates must copy a reviewed template revision and update this
provenance and its test together; do not edit its safety logic locally.

### Required host preparation

Before enabling a timer, the Dockerhost operator must:

1. Complete the copied-volume forward/rollback rehearsal in the
   [persistent-volume safety contract](#persistent-volume-safety-contract).
   The existing physical `/app/content` volume and Compose project identity
   must remain unchanged.
2. Keep the deployment checkout at `%h/content-viewer`, or consistently adjust
   the copied user unit's `%h/content-viewer` paths. The unit is parameterized
   with `%h`; it contains no username, secret, or host-specific absolute home
   path.
3. Create the deployment directory's uncommitted `.env` from `.env.example`,
   preserving its content-repository settings and setting
   `CONTENT_VIEWER_IMAGE=ghcr.io/mkronvold-wtg/content-viewer:dev`.
4. Authenticate as the deployment user with the host-local Docker credential
   store for `ghcr.io`. The updater configuration contains no registry token
   and never runs `docker login`.
5. Copy `infra/docker/content-viewer-autoupdate.conf.example` to
   `~/.config/content-viewer/autoupdate.conf`, retain the exact allowlist, and
   restrict it to mode `0600`.

The config uses `docker-compose.npm.yml` and `.env`, permits only the
`content-viewer` service, and calls the exact vendored
`templates/compose-autoupdate/autoupdate.sh` entrypoint. `up.sh` is the only
repository restart path. It recreates that one service with `--no-build` and
`--no-deps`; the updater itself handles the approved image acquisition and
rollback tags. It neither builds nor removes the named volume.

Run the no-Docker-daemon template tests and the deployment-config dry run
before enabling the timer:

```sh
bash templates/compose-autoupdate/tests/autoupdate-template-test.sh
templates/compose-autoupdate/autoupdate.sh --config ~/.config/content-viewer/autoupdate.conf --dry-run
```

### User timer installation, disablement, and rollback

Only after the copied-volume rehearsal succeeds, enable lingering for the
deployment user so the user timer survives logout and boot:

```sh
sudo loginctl enable-linger <deployment-user>
test "$(loginctl show-user <deployment-user> -p Linger --value)" = yes
```

Install the parameterized user units and enable the 30-minute timer. The unit
runs `autoupdate.sh --once`, treats no-op exit `10` as successful, bounds stop
recovery at two minutes, and uses a persistent timer with a five-minute
randomized delay:

```sh
mkdir -p ~/.config/systemd/user ~/.config/content-viewer
cp infra/docker/systemd/content-viewer-autoupdate.service ~/.config/systemd/user/
cp infra/docker/systemd/content-viewer-autoupdate.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now content-viewer-autoupdate.timer
```

This procedure is documentation only; it does not claim that a timer is
installed on Dockerhost. To stop future development-channel updates, run:

```sh
systemctl --user disable --now content-viewer-autoupdate.timer
```

On an update or health failure, the canonical updater restores its retained
local image tag and invokes `up.sh` and `healthcheck.sh` in rollback mode. For
a manual recovery, disable the timer first and restore the approved local image
tag using the recorded update evidence; then run only:

```sh
AUTOUPDATE_ROLLBACK=1 AUTOUPDATE_SERVICES=content-viewer ./infra/docker/up.sh --services content-viewer
AUTOUPDATE_ROLLBACK=1 AUTOUPDATE_SERVICES=content-viewer ./infra/docker/healthcheck.sh --services content-viewer
```

Use `./infra/docker/down.sh` only to stop the Compose target. It rejects
`-v`/`--volumes`, and **never run `docker compose down -v`**: the persistent
content clone volume must survive both update and rollback.

## Route and mutation matrix

Source: `server.mjs` `handleRequest`, `ensureIndex`, and
`updateDisposableClone`.

| Method and route | Purpose | Persistent-state effect |
| --- | --- | --- |
| `GET /` | Main viewer UI. | No direct route mutation. Startup and lazy indexing can create a missing configured clone under `/app/content`. |
| `GET /<repo>` and `GET /<repo>/<path>` | Repository-scoped UI and direct document view. | No direct route mutation. |
| `GET /favicon.ico` | Empty favicon response. | None. |
| `GET /theme.css`, `GET /theme.json` | Vendored theme assets. | None. |
| `GET /vendor/mermaid.esm.min.mjs` and `GET /vendor/chunks/mermaid.esm.min/<chunk>` | Mermaid assets from installed dependencies. | None. |
| `GET /asset?repo=&doc=&src=` | Local document asset. | May lazily initialize a missing clone/index before serving. |
| `GET /api/health` | Health and per-repository index status. | None. |
| `GET /api/repos` | Public configured repository metadata. | None. |
| `GET /api/search?repo=&q=&limit=` | Indexed Markdown search. | May lazily initialize a missing clone/index. |
| `GET /api/doc?repo=&path=` | One indexed document. | May lazily initialize a missing clone/index. |
| `POST /api/refresh?repo=` | Runs `git pull --ff-only`, clears the in-memory index, and rebuilds it. | **Mutates the persistent clone and in-memory index.** |

The approved Phase 0 application policy is that `POST /api/refresh` remains
public behind the existing trusted proxy/network boundary. Do not add an
application token in this phase. The dockerhost/proxy owner must separately
verify proxy authorization, network exposure, and rate limiting; this
repository neither configures nor proves those controls.

## Promotion gates and external handoffs

Phase 0 does not authorize automatic promotion. The repository now supplies a
deterministic validation workflow, but it does not configure GitHub repository
settings or authorize automatic promotion. A later CI/artifact phase may enable
promotion only after the evidence checklist and copied-volume rehearsal are
available, and only when required checks and immutable digest handling are
enforced by the owners below.

| External owner | Required capability or decision | Phase 0 status |
| --- | --- | --- |
| GitHub administrators | Require the `Validate` status check for `main`; enable and configure merge queue if used; enable Dependabot alerts and security updates; and decide a narrowly scoped auto-merge policy. Do not grant broad workflow write or auto-merge privileges. | External handoff required; no GitHub repository settings were inspected or changed. |
| Registry/Xray owner | Provide a registry namespace and immutable-digest or immutable-tag policy; permit CI to publish and retrieve the final image by digest; configure Xray or the approved scanner to emit final-image JSON and policy status; define retention and access controls for scan evidence. | External handoff required; no registry, Xray, or scan result was inspected. |
| Dockerhost/proxy owner | Supply the actual Compose project, service container, and physical volume; own backup/restore and copied-volume rehearsal; verify proxy authorization, rate limits, TLS/routing, and the trusted network boundary for public refresh; deploy only approved immutable digests once available. | External handoff required; no dockerhost or proxy was accessed. |

Security exceptions, if later needed for a scanner finding or temporary
control gap, must use [`docs/security-exceptions.md`](security-exceptions.md).


## Phase 2 scanner evidence and handoff

The repository now supplies the `Security scan` workflow. It builds the final
runtime image without publishing it, scans the filesystem/lockfile and local
final image with Trivy, preserves JSON/SARIF evidence as a GitHub Actions
artifact, and enforces the approved-exception policy against High/Critical
findings. For the unpushed CI image, the workflow records Docker's immutable
image content ID; it does not claim a registry manifest digest exists.

The workflow's SARIF upload is best-effort only where GitHub grants
`security-events: write`; fork pull requests skip the upload while still
running the scanner and enforcement. The SHA-pinned dependency-review action
reads its policy configuration from the immutable pull-request base SHA, while
the action evaluates the pull request through GitHub's API. It blocks newly
introduced high/critical runtime dependency vulnerabilities without trusting
fork-supplied configuration.

GitHub administrators must require the three named checks documented in the
README before treating them as a merge gate. This repository has not inspected
or configured branch protection, Xray, Artifactory, registry publishing,
or deployment behavior.

## Scheduled base-image digest remediation

`Node base-image digest remediation` is a scheduled source-maintenance
workflow, not a deployment workflow. It has no `workflow_dispatch` or other
branch-selectable entry point: GitHub evaluates its Tuesday schedule from the
trusted default branch, which is the only event allowed to reach its
branch/PR-writing job. Its target platform is explicitly recorded as
`linux/amd64`; it must not infer the platform from the hosted runner. It reads
the actual pinned Node tag and digest from `Dockerfile`, obtains a public token
over HTTPS, and resolves only the same tag through the allowlisted official
Docker Hub repository `registry-1.docker.io/library/node`. The workflow
verifies both the tag manifest index and its selected `linux/amd64` platform
manifest before a candidate can proceed.

Local contributors can verify the offline parser contract with:

```sh
node scripts/base-digest-remediation.mjs inspect --dockerfile Dockerfile --platform linux/amd64
npm run test:base-digest-remediation
```

The scheduled lane serializes with open dependency, release-pin, and prior
remediation work. It builds and Trivy scans both current and candidate final
runtime images for the recorded platform, enforces the committed exception
policy for each, and retains registry/scan evidence. A candidate must remove
one or more accepted High/Critical findings, add no finding at any severity,
keep the same Node tag and approved publisher, and produce an exact
`Dockerfile`-only digest change. Otherwise no PR is created. A registry,
manifest, build, Trivy, or policy failure is a failed workflow rather than a
success-shaped no-op.

Immediately after scanning, the write job re-fetches `origin/main` and the
open-maintenance queue. It refuses PR creation if the scanned base SHA no
longer matches current `main` or a dependency, release-pin, or digest
maintenance PR is open. It creates a unique, non-reused branch from that exact
SHA, verifies the local one-file semantic digest substitution before pushing,
then verifies the remote PR's exact one-file list, base SHA, and base/head
Dockerfile bytes. Qualifying PRs are labelled `base-digest-remediation` and
retain old/new digest, platform-manifest, and scan-delta evidence.

The repository currently reports `allow_auto_merge: false`; therefore this
workflow has no auto-merge job and never asks GitHub to merge a PR. A future
trusted auto-merge design requires repository support and enabled auto-merge,
plus administrator-enforced required checks/rulesets (and a merge queue if
used). Those external controls are absent from this repository today. This
phase never changes Compose, deployment, runtime Git policy, registry
credentials, Artifactory, or a production container.
