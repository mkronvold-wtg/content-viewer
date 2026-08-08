# Content Viewer

Markdown and CSV content viewer for browsing, searching, and presenting documents from a Git-backed content repository.

This repository includes:

- `server.mjs` - standalone Node HTTP server for Docker.
- `extension.mjs` - Copilot canvas extension source kept for side-panel usage.
- `theme.css` and `theme.json` - vendored shared theme standard from `mkronvold/themes`.
- `Dockerfile` and `docker-compose.yml` - first container deployment target.

## Features

- Markdown and CSV search across title, path, and raw document content; Markdown also includes frontmatter tags.
- `tag:KT`-style frontmatter tag filtering.
- Quoted phrase search, for example `"knowledge transfer"` keeps the phrase grouped.
- Generated layer/tag indexes, including Confluence labels as tags, with a right-side metadata rail, all-document/current-document scope switch, and clickable `layer:value` or `tag:value` filters.
- Local image/SVG asset resolution.
- Mermaid rendering.
- Tables, task lists, nested lists, blockquotes, code blocks, admonitions, links, bold, italic, and strikethrough.
- Reader content uses 90% of the available pane (full width on narrow screens); intrinsic-width Markdown and CSV tables scroll only when needed and can be copied as CSV.
- Presentation mode with heading or `---` pagination; direct document URLs with `?present=1` reopen in presentation mode.
- Per-tab search text restoration that reruns the normal search pipeline after a browser reload.
- Pin/unpin document navigation and tag sidebars with browser-stored flyout behavior and adjustable document navigation width.
- Shared canonical `mkronvold/themes` theme pack loaded from vendored theme metadata and selected from a theme pulldown.
- Multiple independent content repos addressed by URL prefix, for example `/kpe.content`.
- Optional per-repo base directories that enforce each repository's document index root while keeping that prefix out of document display and browser URLs.
- Direct document links with `repo/filename` page titles and a Share button that copies the current document URL.
- A Source button that copies the current document's source Git URL.
- On-demand refresh that runs `git pull --ff-only` and rebuilds the index.

## Build and theme updates

This project supports Node `>=26.0.0 <27.0.0`; `.node-version` selects the
baseline release. Run `npm run build` before committing or deploying. It uses
only committed inputs and runs the existing syntax checks.

Theme refresh is an explicit maintenance action, not part of the build. It
requires a full immutable commit SHA and access to `mkronvold/themes` through
`CONTENT_VIEWER_THEME_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, or an active
`gh` login with access to that repository:

```sh
CONTENT_VIEWER_THEME_COMMIT=<40-character-upstream-commit-sha> npm run theme:update
```

The refresh command rejects branch names, tags, abbreviated SHAs, and an unset
commit. Review and commit the resulting `theme.css` and `theme.json`.

## Validation and CI

Use Node 26 and run the deterministic contributor gate:

```sh
npm ci
npm run build
npm test
docker build --tag content-viewer:ci .
npm run test:container
```

The final-image smoke test requires a reachable Docker daemon. It runs the
already-built image with an isolated volume and no Docker network, waits for
the local health endpoint instead of sleeping, verifies the actual service UID
is non-root, and cleans up only its own container and volume. It needs no
content-repository credentials.

`.github/workflows/validate.yml` runs this gate for pull requests to and pushes
to `main`. GitHub branch protection, required checks, merge queue, Dependabot
alerts/security updates, and any narrowly-scoped Dependabot auto-merge policy
remain administrator actions; this repository does not claim they are enabled.

## Security scanning and exception governance

The **Security scan** workflow scans the filesystem/lockfile and the locally
built final runtime image with Trivy on pull requests and pushes to `main`,
and weekly so the current vulnerability database is reapplied. It preserves JSON
and SARIF evidence as a workflow artifact. SARIF uploads are attempted for
trusted repository contexts; fork pull requests still execute and enforce the
scan policy, but do not attempt a permission that forks do not receive.

Run the local governance checks with:

```sh
npm run security:exceptions
npm run test:security-exceptions
```

The scanner itself requires Docker and Trivy (or the pinned GitHub Action). The
workflow fails when either scanner is unavailable or produces malformed evidence;
it blocks unapproved High/Critical findings in both scan targets. Approved,
short-lived exceptions must be represented identically in
`security/trivy-exceptions.json` and
[`docs/security-exceptions.md`](docs/security-exceptions.md); the validator
rejects expired, wildcard, incomplete, or divergent entries. No exception is
currently approved.

Repository administrators must require **Validate**, **Security scan / Trivy
source and final-image policy**, and **Dependency review / Review changed
dependencies** for `main`. This repository does not configure branch
protection, registry publishing, Artifactory, or Xray.

## Node base-image digest remediation

`Node base-image digest remediation` runs only on its Tuesday `schedule`.
GitHub evaluates scheduled workflows from the trusted default branch; there is
no manual-dispatch path, reusable workflow entry point, or branch-selectable
event that can receive the workflow's write token. Its deployment platform is
explicitly fixed to `linux/amd64`; it is neither inferred from a GitHub runner
nor intended to describe every developer machine. The workflow parses the
pinned `node:26...` reference actually present in `Dockerfile`, then contacts
only Docker Hub's official `registry-1.docker.io/library/node` endpoint for
that **same tag**. It verifies the tag's manifest index and the selected
`linux/amd64` child manifest before considering a new digest.

For an offline, no-network parsing dry run:

```sh
node scripts/base-digest-remediation.mjs inspect --dockerfile Dockerfile --platform linux/amd64
npm run test:base-digest-remediation
```

A scheduled run creates no PR unless all of the following are true:

1. The official same-tag manifest digest differs from the pinned digest and
   contains exactly one verified `linux/amd64` manifest.
2. No open dependency, release-pin, or prior base-digest remediation PR is
   is being serialized ahead of it, including in a fresh check immediately
   after the candidate scan.
3. Both current and candidate **final runtime** images build for the recorded
   platform, scan successfully with the committed Trivy exception policy, and
   pass all helper tests and policy checks.
4. The candidate removes at least one currently accepted High/Critical
   finding and introduces no finding at any severity.
5. The freshly re-fetched `origin/main` SHA still exactly matches the SHA used
   for the scan. A unique branch is created from that exact SHA, never reused
   or force-pushed, and must reconstruct as an exact `Dockerfile`
   digest-only change.
6. The remote PR is still based on that SHA; its changed-file list is exactly
   `Dockerfile`, and its base/head Dockerfile bytes semantically prove the
   resolved old-to-new pinned digest transformation.

The PR carries the `base-digest-remediation` label and records old/new tag and
platform-manifest digests, the official manifest endpoint, target platform,
and scan delta. Registry, manifest, build, scanner, or policy failures fail
the workflow and retain evidence where available; a correctly completed
no-candidate or non-qualifying scan simply creates no PR.

The workflow's write job can run only from that scheduled trusted workflow,
uses a unique action-owned branch, refuses forks, and never force-pushes or
overwrites a branch. Qualifying PRs retain the scoped
`base-digest-remediation` label and the scan/registry evidence in their body.

**Auto-merge is not active.** The repository currently reports
`allow_auto_merge: false`, so this workflow deliberately never requests a
merge and leaves every PR open for review. A future trusted auto-merge design
requires the repository to support and enable auto-merge **and** for
administrators to enforce the required checks/rulesets (and merge queue, if
used) outside this repository. This repository cannot configure those
controls and does not claim they are enabled. The scheduled lane is strictly a
source-maintenance lane: it performs no production deployment, Compose change,
registry publication, or Artifactory operation.

## Current deployment

The current shared deployment runs on `dockerhost` and is served at:

```text
https://kpe-content.dev.e2open.com/
```

## Phase 0 operations and security baseline

The repository's deployment and rollback guardrails are in
[`docs/operations.md`](docs/operations.md). They distinguish the local Compose
target from the dockerhost NPM/proxy target, define the required pending
baseline evidence, and protect the persistent content-clone volume.

`POST /api/refresh` intentionally remains public at the application layer
behind the existing trusted proxy/network boundary. Proxy authorization and
rate-limit verification are external operator responsibilities; this
repository does not configure or verify either control.

No automatic image promotion is authorized until later phases supply the
required scan, immutable-image, health, and copied-volume rehearsal evidence
described in the runbook.

## Docker Compose quick start

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Edit `.env`:

   ```env
   CONTENT_VIEWER_REPOS=kpe.content,team.docs
   CONTENT_VIEWER_REPO_KPE_CONTENT_PATH=/app/content/kpe.content
   CONTENT_VIEWER_REPO_KPE_CONTENT_URL=https://github.com/OWNER/kpe-content.git
   CONTENT_VIEWER_REPO_KPE_CONTENT_BRANCH=main
   CONTENT_VIEWER_REPO_KPE_CONTENT_BASE_DIR=/data/
   CONTENT_VIEWER_REPO_TEAM_DOCS_PATH=/app/content/team.docs
   CONTENT_VIEWER_REPO_TEAM_DOCS_URL=https://github.com/OWNER/team-docs.git
   CONTENT_VIEWER_REPO_TEAM_DOCS_BRANCH=main
   CONTENT_VIEWER_REPO_TEAM_DOCS_BASE_DIR=/docs/
   CONTENT_VIEWER_GITHUB_TOKEN=...
   ```

3. Start it:

   ```sh
   docker compose up -d --build
   ```

4. Open:

   ```text
   http://127.0.0.1:8080/
   ```

The compose file binds to `127.0.0.1:8080` by default so it is not exposed on every network interface. Put a VPN, SSH tunnel, or reverse proxy in front of it if other users need access.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | HTTP port inside the container. Defaults to `8080`. |
| `HOST` | No | Bind address inside the container. Defaults to `0.0.0.0`. |
| `CONTENT_VIEWER_REPO_PATH` | No | Local path to the content clone. Defaults to `/app/content` in Docker. |
| `CONTENT_VIEWER_REPO_URL` | Yes for clone mode | Git URL for the content repo. |
| `CONTENT_VIEWER_REPO_BRANCH` | No | Branch to clone. Defaults to `main`. |
| `CONTENT_VIEWER_REPO_BASE_DIR` | No | Optional repository-relative document index root for single-repository mode. Defaults to the repository root; it must exist as a directory in the checked-out content repository. |
| `CONTENT_VIEWER_REPOS` | Yes for multi-repository mode | Ordered, comma-separated repository slug list. |
| `CONTENT_VIEWER_REPO_<KEY>_PATH` | No | Local clone path. Defaults to `<content-root>/<slug>`. `<KEY>` is the slug uppercased with punctuation changed to `_`, e.g. `kpe.content` -> `KPE_CONTENT`. |
| `CONTENT_VIEWER_REPO_<KEY>_URL` | Only when cloning | Git URL used to clone when the configured path does not already contain a Git clone. |
| `CONTENT_VIEWER_REPO_<KEY>_BRANCH` | No | Branch to use for cloning and pulling. Defaults to `main`. |
| `CONTENT_VIEWER_REPO_<KEY>_BASE_DIR` | No | Optional repository-relative document index root. Defaults to the repository root. Leading and trailing `/` are normalized; when set, it must exist as a directory in the checked-out content repository. |
| `CONTENT_VIEWER_REPO_<KEY>_LABEL` | No | Display label for that repo in the UI selector. |
| `CONTENT_VIEWER_GITHUB_TOKEN` | Yes for private GitHub repos | Token used by `git clone` and `git pull`. |
| `CONTENT_VIEWER_REFRESH_INTERVAL_SECONDS` | No | Optional scheduled pull/index refresh interval. |

For each slug in `CONTENT_VIEWER_REPOS`, only the slug itself is required.
`PATH` defaults to `<content-root>/<slug>`, `BRANCH` defaults to `main`, and
`BASE_DIR` defaults to empty. Set `URL` when the app must clone the repository;
it is not needed when the configured path already contains a Git clone.

`BASE_DIR` is an enforced indexing boundary, not merely a display prefix. The
app walks only that repository-relative directory; `/data/` and `data` select
the same directory. A configured directory that is missing, is not a
directory, traverses outside the repository, or resolves through a symlink
outside it is an index error and does not fall back to indexing the repository
root. Documents, titles, search/navigation results, Share links, and browser
routes use paths relative to `BASE_DIR`; Source links and local asset resolution
retain the actual repository-relative source path, including `BASE_DIR`.

Example multi-repository `.env`:

```env
CONTENT_VIEWER_REPOS=kpe.content,team.docs
CONTENT_VIEWER_REPO_KPE_CONTENT_PATH=/app/content/kpe.content
CONTENT_VIEWER_REPO_KPE_CONTENT_URL=https://github.com/wtg-e2open/kpe-content.git
CONTENT_VIEWER_REPO_KPE_CONTENT_BRANCH=main
CONTENT_VIEWER_REPO_KPE_CONTENT_BASE_DIR=/data/
CONTENT_VIEWER_REPO_TEAM_DOCS_PATH=/app/content/team.docs
CONTENT_VIEWER_REPO_TEAM_DOCS_URL=https://github.com/OWNER/team-docs.git
CONTENT_VIEWER_REPO_TEAM_DOCS_BRANCH=main
CONTENT_VIEWER_REPO_TEAM_DOCS_BASE_DIR=/docs/
```

Repo slugs are reserved for app routes, so do not use `api`, `asset`, `vendor`, or `favicon.ico`.

## Authentication and access requirements

The first container version intentionally has **no application-level user authentication**. It assumes access is controlled by network placement.

Required controls:

1. Run it on a private host, private subnet, VPN-only network, or behind an authenticated reverse proxy.
2. Do not publish the container port directly to the public internet.
3. Store `CONTENT_VIEWER_GITHUB_TOKEN` as a Docker/Compose secret or protected environment variable, not in source control.
4. Use a read-only GitHub token:
   - Fine-grained PAT: grant **Contents: read** on the content repository only.
   - Classic PAT, if required by policy: use the minimum repo read permission available for private repo cloning.
5. Rotate the token regularly and revoke it if the host is replaced or compromised.
6. Keep the content clone volume private because it contains a working copy of the content repository.

If public or broad internal access is needed later, add auth before widening the bind address. Suitable options are:

- Reverse proxy SSO/OIDC in front of the app.
- GitHub OAuth with org/team allow-list.
- Basic auth at a reverse proxy for a small trusted group.

## Container architecture

Current single-container design:

1. Node server serves the UI and JSON APIs.
2. The same container owns the content clone or clones under `/app/content`.
3. Refresh requests run `git pull --ff-only`, rebuild the in-memory index, and keep serving.
4. Mermaid assets are served from installed `node_modules`.

Separate containers are not required initially. Split later only if you want a dedicated git-sync sidecar, external auth proxy, or shared persistent content volume across replicas.

## API endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Web UI. |
| `GET /<repo>` | Web UI scoped to one configured repo. |
| `GET /<repo>/<path-to-document.{md,csv}>` | Direct document link; opens that document in the regular reading view. |
| `GET /api/health` | Health/readiness details. |
| `GET /api/repos` | List configured repos. |
| `GET /api/search?repo=<repo>&q=...` | Search indexed Markdown and CSV documents. |
| `GET /api/doc?repo=<repo>&path=...` | Fetch one document by display path. Responses include `format` (`markdown` or `csv`); CSV content is returned as raw text and rendered by the browser as a plain-text table. |
| `POST /api/refresh?repo=<repo>` | Pull latest content and rebuild one repo index. |
| `GET /asset?repo=<repo>&doc=...&src=...` | Resolve local document assets. |

## Next hardening steps

1. Add tests for Markdown rendering, search/tag filtering, asset resolution, and git refresh behavior.
2. Move the browser renderer out of the template string into static files.
3. Add structured logging and request IDs.
4. Add optional reverse-proxy auth examples.
5. Add GHCR publishing workflow.
6. Add Kubernetes manifests if Docker Compose is no longer enough.
