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
   auto-merge or workflow write permissions. The repository's only source
   auto-merge lane is `Node base-image digest remediation`: GitHub
   administrators must enable repository auto-merge and required checks
   separately; this repository does not claim those settings are enabled.


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

## Base-image digest remediation

Keep `.github/workflows/base-digest-remediation.yml` limited to the scheduled,
same-tag official Node digest remediation lane. Its explicit deployment
platform is `linux/amd64`; never infer another platform from a runner or add a
mutable-tag fallback. The helper must use only HTTPS access to
`registry-1.docker.io/library/node`, validate the manifest index and selected
platform manifest, and reject untrusted tags, repositories, registries,
platforms, and digests. Keep its unit tests offline.

The workflow's default manual `dry_run=true` may resolve and report a
candidate, but must not build, scan, branch, create a PR, publish, or deploy.
A live scheduled/manual run may create a PR only after both final runtime
images pass the existing Trivy exception policy, the candidate removes an
accepted High/Critical finding with no new finding at any severity, and exact
local and remote checks prove that only `Dockerfile`'s digest changed.

Do not broaden its token permissions, use `pull_request_target`, secrets,
registry credentials, force pushes, or administrator merge bypasses. The
write job is only for its unique action-created branch/PR; the auto-merge job
must re-verify same-repository ownership, evidence marker, expected label,
scan delta, and the exact one-file remote diff, then use GitHub auto-merge so
required checks and merge queue remain in force. Forks must be refused. This
lane never deploys production or changes Compose, Artifactory, generic
Dependabot settings, or application runtime Git behavior.
