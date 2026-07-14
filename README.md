# Content Viewer

Markdown content viewer for browsing, searching, and presenting documents from a Git-backed content repository.

This repository includes:

- `server.mjs` - standalone Node HTTP server for Docker.
- `extension.mjs` - Copilot canvas extension source kept for side-panel usage.
- `theme.css` and `theme.json` - vendored shared theme standard from `mkronvold/themes`.
- `Dockerfile` and `docker-compose.yml` - first container deployment target.

## Features

- Markdown search across title, path, body, and frontmatter tags.
- `tag:KT`-style frontmatter tag filtering.
- Quoted phrase search, for example `"knowledge transfer"` keeps the phrase grouped.
- Generated tag index with a right-side tag rail, all-document/current-document scope switch, and clickable `tag:value` filters.
- Local image/SVG asset resolution.
- Mermaid rendering.
- Tables, task lists, nested lists, blockquotes, code blocks, admonitions, links, bold, italic, and strikethrough.
- Presentation mode with heading or `---` pagination.
- Pin/unpin document navigation and tag sidebars with browser-stored flyout behavior.
- Shared canonical `mkronvold/themes` theme pack loaded from vendored theme metadata.
- Multiple independent content repos addressed by URL prefix, for example `/kpe.content`.
- Configurable per-repo base directory hiding, so `/data/Users/...` displays and shares as `Users/...`.
- Direct presentation links and a Share button that copies the current document URL.
- On-demand refresh that runs `git pull --ff-only` and rebuilds the index.

## Build and theme updates

Run `npm run build` before committing or deploying. The build script refreshes `theme.css` and `theme.json` from `mkronvold/themes`, then runs the existing syntax checks.

Theme refresh requires access to `mkronvold/themes` through `CONTENT_VIEWER_THEME_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, or an active `gh` login with access to that repository. Set `CONTENT_VIEWER_THEME_REF` to test a branch or tag other than `main`.

## Docker Compose quick start

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Edit `.env`:

   ```env
   CONTENT_VIEWER_REPO_NAME=kpe.content
   CONTENT_VIEWER_REPO_BASE_DIR=/data
   CONTENT_VIEWER_REPO_URL=https://github.com/OWNER/CONTENT_REPO.git
   CONTENT_VIEWER_REPO_BRANCH=main
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
| `CONTENT_VIEWER_REPO_NAME` | No | Single-repo URL slug. Defaults to `content`; use `kpe.content` for `/kpe.content/...` URLs. |
| `CONTENT_VIEWER_REPO_PATH` | No | Local path to the content clone. Defaults to `/app/content` in Docker. |
| `CONTENT_VIEWER_REPO_URL` | Yes for clone mode | Git URL for the Markdown content repo. |
| `CONTENT_VIEWER_REPO_BRANCH` | No | Branch to clone. Defaults to `main`. |
| `CONTENT_VIEWER_REPO_BASE_DIR` | No | Repo-relative directory to hide from display paths and shared URLs, for example `/data`. |
| `CONTENT_VIEWER_REPOS` | No | Comma-separated multi-repo slugs. When set, use per-repo variables below. |
| `CONTENT_VIEWER_REPO_<KEY>_PATH` | Yes for each multi repo | Local clone path. `<KEY>` is the slug uppercased with punctuation changed to `_`, e.g. `kpe.content` -> `KPE_CONTENT`. |
| `CONTENT_VIEWER_REPO_<KEY>_URL` | Yes for clone mode | Git URL for that repo. |
| `CONTENT_VIEWER_REPO_<KEY>_BRANCH` | No | Branch for that repo. Defaults to `main`. |
| `CONTENT_VIEWER_REPO_<KEY>_BASE_DIR` | No | Repo-relative directory hidden from that repo's displayed paths and URLs. |
| `CONTENT_VIEWER_REPO_<KEY>_LABEL` | No | Display label for that repo in the UI selector. |
| `CONTENT_VIEWER_GITHUB_TOKEN` | Yes for private GitHub repos | Token used by `git clone` and `git pull`. |
| `CONTENT_VIEWER_REFRESH_INTERVAL_SECONDS` | No | Optional scheduled pull/index refresh interval. |

Example multi-repo `.env`:

```env
CONTENT_VIEWER_REPOS=kpe.content,team.docs
CONTENT_VIEWER_REPO_KPE_CONTENT_PATH=/app/content/kpe.content
CONTENT_VIEWER_REPO_KPE_CONTENT_URL=https://github.com/wtg-e2open/kpe-content.git
CONTENT_VIEWER_REPO_KPE_CONTENT_BRANCH=main
CONTENT_VIEWER_REPO_KPE_CONTENT_BASE_DIR=/data
CONTENT_VIEWER_REPO_TEAM_DOCS_PATH=/app/content/team.docs
CONTENT_VIEWER_REPO_TEAM_DOCS_URL=https://github.com/OWNER/team-docs.git
CONTENT_VIEWER_REPO_TEAM_DOCS_BASE_DIR=/docs
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
| `GET /<repo>/<path-to-document.md>` | Direct document link; opens that document in presentation mode. |
| `GET /api/health` | Health/readiness details. |
| `GET /api/repos` | List configured repos. |
| `GET /api/search?repo=<repo>&q=...` | Search indexed Markdown. |
| `GET /api/doc?repo=<repo>&path=...` | Fetch one document by display path. |
| `POST /api/refresh?repo=<repo>` | Pull latest content and rebuild one repo index. |
| `GET /asset?repo=<repo>&doc=...&src=...` | Resolve local document assets. |

## Next hardening steps

1. Add tests for Markdown rendering, search/tag filtering, asset resolution, and git refresh behavior.
2. Move the browser renderer out of the template string into static files.
3. Add structured logging and request IDs.
4. Add optional reverse-proxy auth examples.
5. Add GHCR publishing workflow.
6. Add Kubernetes manifests if Docker Compose is no longer enough.
