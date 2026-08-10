# Compose auto-update template

This is the canonical, **vendored** host-side template for the optional mutable
Compose channel. Copy one reviewed, versioned copy into an application under
`infra/docker/`; sync future changes through a reviewed application pull
request. A runtime host never downloads this script, `up.sh`, or any other code.

It deliberately updates only explicit app services. Immutable Compose and
Kubernetes release pins remain the required deployment channel; see
[`../../lcm.md`](../../lcm.md).

It requires Bash 4+, Docker Compose v2 with Buildx, and Linux `flock`.

## Install

1. Copy `autoupdate.sh`, this configuration shape, and the matching app-local
   `up.sh`/health script into the application's Compose directory. Mark scripts
   executable.
2. Create a host-owned `autoupdate.conf` from
   [`autoupdate.conf.example`](./autoupdate.conf.example) for `ghcr-dev` or
   [`autoupdate.artifactory-repo-ops.conf.example`](./autoupdate.artifactory-repo-ops.conf.example)
   for the protected Artifactory profile, preferably mode 0600. It is
   configuration, not a token store. Docker's standard credential store supplies
   private-registry pull credentials.
3. Run `./autoupdate.sh --config /path/to/autoupdate.conf --dry-run`, then
   `--once`. The script returns `10` for a logged no-op and `75` if another
   run owns the lock.
4. Enable lingering for the deployment user before enabling a user timer. This
   is required for unattended runs to survive logout and boot:

   ```bash
   deployment_user=<deployment-user>
   sudo loginctl enable-linger "$deployment_user"
   test "$(loginctl show-user "$deployment_user" -p Linger --value)" = yes
   ```

   Use the equivalent host-approved user-session persistence mechanism only if
   `loginctl` is unavailable.
5. Substitute the absolute application paths in
   [`systemd/autoupdate.service`](./systemd/autoupdate.service) and enable the
   copied user timer:

   ```bash
   mkdir -p ~/.config/systemd/user
   cp autoupdate.service autoupdate.timer ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now autoupdate.timer
   ```

   A user timer runs `--once`; do not enable both the timer and a nonzero
   `AUTOUPDATE_INTERVAL_SECONDS`.

## Config and app-script contract

`AUTOUPDATE_WORKDIR`, Compose files, Compose env files, service-to-image
allowlist, registry profile, target platform, command paths, lock path, digest
record path, and rollback image prefix are required. `ghcr-dev` additionally
requires `AUTOUPDATE_GHCR_MUTABLE_TAG`; it has no default and may be `latest`
only when the application explicitly sets it. Compose and env paths are whitespace-free relative paths beneath
`AUTOUPDATE_WORKDIR`. Commands are local `./` executable paths beneath the
same working directory and do not take inline arguments; use small reviewed
wrappers when arguments are needed.

`AUTOUPDATE_ROLLBACK_IMAGE_RETENTION` is optional and defaults to `3`. It must
be an integer from `1` through `10`; use it to set the finite number of
timestamped rollback tags retained for each allowlisted service. An invalid
value is rejected before Docker is invoked.

`AUTOUPDATE_ALLOWED_IMAGES` is one `service=image:tag` mapping per line. The
rendered Compose image for each allowed service must match exactly. The
template never calls pull, restart, health, or rollback with any service not in
that list. Non-app services may remain in the same Compose project, but must
not appear in this configuration.

`up.sh`, the health command, and the rollback command must accept:

```text
--services api web
AUTOUPDATE_SERVICES=api,web
DOCKER_DEFAULT_PLATFORM=linux/amd64
```

For a normal update, `up.sh` may perform the application's existing safe
startup work only for those services. For `AUTOUPDATE_ROLLBACK=1`, it must not
pull; it must recreate only the requested services from the local tags the
template restored. This is how a failed post-update health check returns to the
previous running image without touching a database, proxy, or sidecar.
The updater exports `DOCKER_DEFAULT_PLATFORM` to every app command and rejects
an explicit rendered Compose `platform:` that conflicts with the configured
target.

Before pulling, the updater records each running image ID under a local
rollback tag. It compares the running manifest digest with the manifest digest
resolved remotely for `AUTOUPDATE_TARGET_PLATFORM`; only changed app services
are pulled. It verifies the pulled digest, invokes `up.sh`, runs health, writes
the digest record atomically, then prunes superseded, timestamped rollback tags
only for allowlisted services beyond
`AUTOUPDATE_ROLLBACK_IMAGE_RETENTION`. The rollback tag recorded for the
successful deployment is never pruned. No rollback tag is removed until health
has succeeded and the replacement record is durable. The updater restores the
prior tags plus the app rollback path when either command fails.

Once prior image tags are retained, the updater arms bounded `TERM`, `INT`, and
`HUP` handling. An interruption ignores repeated signals, restores prior tags,
and invokes the same allowlisted rollback/health path before exiting with the
signal status. This prevents an interrupted mutable candidate from becoming a
later no-op baseline. The supplied service bounds this recovery with
`TimeoutStopSec=2min`; set a deliberate equivalent limit when adapting it.

The script uses `flock -n`. It fails closed on missing runtime services,
unrecognized rendered images, immutable `@sha256` pins, missing manifest
digests, registry/auth/manifest failures, invalid configuration, or a
concurrent invocation. It never runs `docker login`, prints configuration or
environment values, or handles registry tokens.

The supplied user service treats no-op exit `10` as successful
(`SuccessExitStatus=10`).

## Registry profiles

| Profile | Allowed runtime image refs | Additional enforcement |
| --- | --- | --- |
| `ghcr-dev` | Exact `ghcr.io/<namespace>/<image>:${AUTOUPDATE_GHCR_MUTABLE_TAG}` only | Linux target; the application must explicitly configure its mutable tag (the canonical content-viewer example uses `:dev`); Docker credential store handles optional private GHCR pulls |
| `artifactory-repo-ops` | Exact `repo.ops/<path>:<mutable-tag>` only | Exact `linux/amd64`, protected source-to-pull mapping, and matching OCI revision |

For `artifactory-repo-ops`, `AUTOUPDATE_ARTIFACTORY_MAPPING_PATH` is required.
Each non-comment line is (see
[`repo-ops-mapping.txt.example`](./repo-ops-mapping.txt.example)):

```text
repo.ops/team/app-api:latest|sha256:<repo-ops-manifest>|sv4.art/repo.ops/team/app-api@sha256:<source-manifest>|sha256:<source-manifest>|linux/amd64|<org.opencontainers.image.revision>
```

The mapping is published or provisioned only after protected-source publication,
Trivy/Xray policy success, platform verification, and source-to-pull digest
recording. The updater independently resolves a Linux/amd64 child manifest,
reads its OCI revision, and compares the tag's remote manifest digest against
the mapping. It queries and pulls only `repo.ops`; `sv4.art` is accepted only
as provenance text in the local mapping and is never a runtime pull host. The
runtime Docker identity is pull-only.

## Validation

Run the portable tests from repository root:

```bash
bash templates/compose-autoupdate/tests/autoupdate-template-test.sh
```

They replace Docker and `flock` with local fakes, so no Docker daemon, registry,
or network access is required.
