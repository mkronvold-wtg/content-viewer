# Content Viewer contributor instructions

## Canonical validation

Use Node 26, as selected by `.node-version`.

```sh
npm ci
npm run build
npm test
docker build --tag content-viewer:ci .
npm run test:container
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


## Security scan and dependency review

Keep `Security scan` deterministic and unprivileged except for its
job-scoped `security-events: write` SARIF upload. It must scan both the
filesystem/lockfile and the final runtime image, retain JSON evidence, and run
`node scripts/enforce-trivy-policy.mjs` for each target. Do not add
`pull_request_target`, secrets, Artifactory credentials, registry publishing,
deployment behavior, or scanner bypasses. SARIF uploads may remain
best-effort for fork PRs; the scanner and policy must still run and fail there.

Every Trivy exception must pass `npm run security:exceptions` and be an exact,
matching entry in both `security/trivy-exceptions.json` and
`docs/security-exceptions.md`. Do not add a low/medium or speculative
exception. Keep dependency review SHA-pinned and limited to its read-only
contents permission; do not change explicit Dependabot auto-merge settings.

Administrators must require `Validate`, `Security scan / Trivy source and
final-image policy`, and `Dependency review / Review changed dependencies`
before merge. Branch protection and those required checks are external GitHub
settings, not evidence that this repository has configured them.
