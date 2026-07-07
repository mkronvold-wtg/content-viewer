# Content Viewer

Session-scoped Copilot canvas extension for searching and presenting Markdown content from a local or disposable Git clone.

## Current state

- Provides a Copilot canvas extension in `extension.mjs`.
- Indexes Markdown files from `CONTENT_VIEWER_REPO_PATH` or a canvas `repoPath` input.
- Can clone/pull content when `CONTENT_VIEWER_REPO_URL` is set.
- Renders common Markdown features, local assets, SVGs, Mermaid diagrams, tables, presentation mode, and tag search.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CONTENT_VIEWER_REPO_PATH` | Local path to the disposable content clone. Defaults to `./content`. |
| `CONTENT_VIEWER_REPO_URL` | Git URL to clone when the local content path is missing. |
| `CONTENT_VIEWER_REPO_BRANCH` | Branch to clone. Defaults to `main`. |
| `CONTENT_VIEWER_PRIMARY_REPO_PATH` | Optional primary checkout path to redirect away from for safer refreshes. |

## Outline: standalone Docker container

1. Extract the HTTP server and Markdown renderer from the Copilot extension wrapper.
2. Replace `joinSession` and `createCanvas` with a normal Node entry point, for example `server.mjs`.
3. Split the monolithic file into modules: indexer, search query parser, asset resolver, Markdown renderer, git refresh service, and web UI.
4. Add an HTTP framework or keep `node:http`, then expose a fixed configurable port such as `8080`.
5. Replace canvas open input with environment variables and/or a small config file.
6. Serve the same HTML UI at `/`, JSON APIs at `/api/search`, `/api/doc`, `/api/refresh`, assets at `/asset`, and Mermaid vendor files under `/vendor`.
7. Add authentication if the container will be reachable outside localhost.
8. Decide how content is provided: mounted volume, init-time clone from `CONTENT_VIEWER_REPO_URL`, or sidecar/scheduled pull.
9. Add a `Dockerfile` using a slim Node image, install production dependencies, copy app files, expose the configured port, and run `node server.mjs`.
10. Add a `docker-compose.yml` example with a content volume and environment variables.
11. Add health/readiness endpoints and logging suitable for container platforms.
12. Add tests for Markdown rendering, search/tag filtering, asset resolution, and git refresh behavior.
13. Add CI to run tests, build the image, and optionally publish it to GHCR.

## First container milestone

Create a minimal standalone `server.mjs` that serves the current UI from a local content volume without Copilot canvas integration. After that works, add git clone/pull, Docker packaging, auth, and CI.
