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
3. The repository currently reports `allow_auto_merge: false`. Keep the
   `Node base-image digest remediation` lane PR-only; it must not request or
   enable auto-merge. A future trusted auto-merge design requires repository
   support and enabled auto-merge plus administrator-enforced required
   checks/rulesets (and merge queue if used), all configured separately.


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

Keep `.github/workflows/base-digest-remediation.yml` limited to its trusted
default-branch schedule and the same-tag official Node digest remediation
lane. Do not add `workflow_dispatch`, `workflow_call`, branch-selectable
events, or any other route from untrusted branch-controlled workflow code to
its write job. Its explicit deployment platform is `linux/amd64`; never infer
another platform from a runner or add a mutable-tag fallback. The helper must use only HTTPS access to
`registry-1.docker.io/library/node`, validate the manifest index and selected
platform manifest, and reject untrusted tags, repositories, registries,
platforms, and digests. Keep its unit tests offline.

Only the scheduled run may create a PR, and only after both final runtime
images pass the existing Trivy exception policy, the candidate removes an
accepted High/Critical finding with no new finding at any severity, and exact
local and remote checks prove that only `Dockerfile`'s digest changed. After
the scan, re-fetch `origin/main` and the maintenance queue; refuse PR creation
unless the scanned base SHA remains current and the queue is clear. Create a
new branch from that exact SHA; never update or reuse an existing branch.

Do not broaden its token permissions, use `pull_request_target`, secrets,
registry credentials, force pushes, or administrator merge bypasses. The
write job is only for its unique action-created branch/PR; it must re-verify
same-repository ownership, evidence marker, expected label, scan delta, exact
base SHA, and the exact one-file remote semantic diff. Forks must be refused.
This lane never deploys production, requests a merge, or changes Compose,
Artifactory, generic Dependabot settings, or application runtime Git behavior.
