# Phase 0 Operations and Security Guardrails

This document records the repository baseline and the deployment evidence that
is still pending. It is intentionally not evidence that the dockerhost, proxy,
registry, or GitHub settings have been inspected. No Phase 0 command in this
repository was run against a deployment target.

## Repository-verified baseline

| Source | Verified repository behavior |
| --- | --- |
| `Dockerfile` | Uses the official `node:26-bookworm-slim` image pinned to an immutable digest for separate dependency and runtime stages. The runtime installs Git and CA certificates, retains only production dependencies and required server/theme assets, creates `/app/content` owned by `node`, runs as `USER node`, and health-checks `GET /api/health`. |
| `docker-compose.yml` | Local Compose builds the service, tags it `content-viewer:local`, binds `127.0.0.1:8080:8080`, and mounts the logical named volume `content-viewer-content` at `/app/content`. |
| `docker-compose.npm.yml` | The dockerhost/NPM-proxy target builds the service, mounts the same logical volume at `/app/content`, exposes port `8080` only to Compose networks, and joins the external network named `npm-proxy`. It has no host `ports` mapping. |
| `README.md` | Documents the local command `docker compose up -d --build`; it does not define an authoritative dockerhost project name or invocation. |
| `package.json` | `npm run build` and `npm run check` syntax-check `server.mjs` and `extension.mjs` using committed inputs. `npm run test:contracts` runs the explicit deterministic Node contract suite, and `npm run test:container` smoke-tests a supplied final image with an isolated no-network container and volume. Theme refresh is a separate maintenance action that requires an immutable full upstream commit SHA, as described in `README.md`. |
| `.env.example` | Configures the Git-backed content clone under `/app/content` and identifies `CONTENT_VIEWER_GITHUB_TOKEN` as a read-only content-repository credential. |
| `server.mjs` | Defines the routes and clone/refresh behavior in the route matrix below. |

## Compose targets and deployment boundary

| Target | Repository command or configuration | Boundary |
| --- | --- | --- |
| Local development | `docker compose up -d --build` from `README.md` with `docker-compose.yml` | Host-only port binding at `127.0.0.1:8080`; image tag is `content-viewer:local`. |
| Dockerhost behind NPM/proxy | `docker-compose.npm.yml` | No host port is published by this file. The service is reachable on the external Compose network `npm-proxy` as `content-viewer:8080`. The actual Compose project name, proxy routing, and dockerhost invocation are not in this repository. |

The logical volume declaration is `content-viewer-content` in both Compose
files. Because neither file sets a top-level Compose `name`, the physical
volume name is project-scoped and must be discovered on the dockerhost rather
than guessed from the logical name.

**Deployment-only operator action:** when the dockerhost owner has confirmed
the approved project name, use that explicit name in deployment commands, for
example:

```sh
docker compose -p "$PROJECT" -f docker-compose.npm.yml up -d --build
```

This is an operator procedure, not a claim that `$PROJECT` is the current
deployment value.

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
automatic remediation, auto-merge, or deployment behavior.
