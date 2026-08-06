# Content Viewer contributor instructions

## Canonical validation

Use Node 26, as selected by `.node-version`.

```sh
npm ci
npm run build
npm test
docker build --tag content-viewer:ci .
CONTENT_VIEWER_TEST_IMAGE=content-viewer:ci npm run test:container
```

`npm run build` performs the syntax checks and uses only committed theme inputs;
`npm run theme:update` is a separate, credentialed maintenance action. The
container smoke test requires an available Docker daemon, runs the final image
on an isolated no-network Docker network and volume, waits for `/api/health`,
verifies its runtime UID is non-root, and removes only the container and volume
it created.

## CI and trunk rules

The `Validate` workflow must stay deterministic: `npm ci`, build/check, the
explicit contract test file, final-image build, and final-image smoke test. Do
not add credentials, `pull_request_target`, public-network test dependencies,
or implicit shell test globs.

Branch from current `origin/main` and target `main`. Do not make stacked PRs or
base a PR on another unmerged branch. Keep runtime Git and Docker behavior
unchanged unless a non-behavioral test harness requires it.

## Administrator handoff

Repository administrators must still configure GitHub settings outside this
repository:

1. Require the `Validate` status check for `main` and enable/configure merge
   queue if the repository uses it.
2. Enable Dependabot alerts and Dependabot security updates.
3. Define a deliberately scoped auto-merge policy. Do not grant broad
   auto-merge or workflow write permissions; if auto-merge is allowed, limit it
   to reviewed Dependabot updates that have passed `Validate`, with explicit
   exclusions for runtime, Docker, and workflow changes as appropriate.
