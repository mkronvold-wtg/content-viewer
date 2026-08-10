import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseDocument } from "yaml";

const root = resolve(process.cwd());
const execFileAsync = promisify(execFile);
const canonicalRevision = "8303ab1a7aaf87a3b2409e4fb9bd804a265746a6";
const templateHashes = {
  "README.md": "ea1106fb7100fadb1376c5641731838767630646bdbf0df79e656e4bc0606cc4",
  "autoupdate.artifactory-repo-ops.conf.example": "a2a26be638ea01ef6314fe502ccad2aed3fe8ec1d7765c29cbf863420a7bea7b",
  "autoupdate.conf.example": "3d111704c45c18b83db1d127aa19b129929c07e75e322cab4b227b075aaeac16",
  "autoupdate.sh": "bf49ed526042d95f796fb92b452c79560fd74fd16bd373db495dd34eeff3bd13",
  "repo-ops-mapping.txt.example": "d0c6f9d37e9c753d502bcb6339da8e576875d37ffefb7c200c43bc010a1b3bc5",
  "systemd/autoupdate.service": "9e990712491eefa366e702faaf77ee21f9c1b7bb7ea45b32af39c309756ab7b4",
  "systemd/autoupdate.timer": "c288fee94dcf0cf0be46680a01717e18f166cd130ad9ccaa725d4d778e2f90ed",
  "tests/autoupdate-template-test.sh": "4de36f35c6c146ceaf0d916170ece52216b56bfe302aca5a91ee143b9f184b77",
};

async function source(pathname) {
  return readFile(resolve(root, pathname), "utf8");
}

function parseYaml(sourceText, filename) {
  const document = parseDocument(sourceText);
  assert.equal(document.errors.length, 0, `${filename} must parse: ${document.errors.map((error) => error.message).join("; ")}`);
  return document.toJS();
}

function bashPath(pathname) {
  return pathname
    .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
    .replaceAll("\\", "/");
}

async function createBootstrapFixture(project = "content-viewer") {
  const fixture = await mkdtemp(join(root, ".content-viewer-bootstrap-"));
  const relativeFixture = relative(root, fixture).replaceAll("\\", "/");
  const bin = join(fixture, "bin");
  const state = join(fixture, "state");
  const actions = join(fixture, "actions.log");
  const record = join(state, "bootstrap.txt");
  const config = join(fixture, "autoupdate.conf");
  await mkdir(bin);
  await mkdir(state);
  await writeFile(join(fixture, ".env"), "CONTENT_VIEWER_IMAGE=ghcr.io/mkronvold-wtg/content-viewer:dev\n");
  await writeFile(join(fixture, "docker-compose.npm.yml"), "services: {}\n");
  await writeFile(actions, "");

  await writeFile(join(bin, "docker"), `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'docker %s\\n' "$*" >>"$ACTION_LOG"
case "$1" in
  compose)
    shift
    case " $* " in
      *" ps -q content-viewer "*) printf 'container-current\\n' ;;
      *" pull content-viewer "*) : ;;
      *" up -d --no-build --no-deps content-viewer "*) : ;;
      *" exec -T content-viewer "*) : ;;
      *) printf 'unexpected compose command: %s\\n' "$*" >&2; exit 1 ;;
    esac
    ;;
  inspect)
    if [[ "$3" == *".Mounts"* ]]; then
      printf 'content-viewer_content-viewer-content\\n'
    else
      printf 'build-origin-image-id\\n'
    fi
    ;;
  image)
    [[ "$2" == tag ]] || exit 1
    ;;
  *)
    printf 'unexpected docker command: %s\\n' "$*" >&2
    exit 1
    ;;
esac
`);
  await writeFile(join(bin, "curl"), `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'curl %s\\n' "$*" >>"$ACTION_LOG"
`);
  await chmod(join(bin, "docker"), 0o755);
  await chmod(join(bin, "curl"), 0o755);

  await writeFile(config, `AUTOUPDATE_WORKDIR=.
AUTOUPDATE_COMPOSE_FILES="docker-compose.npm.yml"
AUTOUPDATE_COMPOSE_ENV_FILES=".env"
AUTOUPDATE_PROJECT_NAME=${project}
export AUTOUPDATE_PROJECT_NAME
export COMPOSE_PROJECT_NAME="$AUTOUPDATE_PROJECT_NAME"
AUTOUPDATE_ALLOWED_SERVICES="content-viewer"
AUTOUPDATE_ALLOWED_IMAGES="
content-viewer=ghcr.io/mkronvold-wtg/content-viewer:dev
"
AUTOUPDATE_REGISTRY_PROFILE=ghcr-dev
AUTOUPDATE_GHCR_MUTABLE_TAG=dev
AUTOUPDATE_TARGET_PLATFORM=linux/amd64
AUTOUPDATE_BOOTSTRAP_ROLLBACK_IMAGE=content-viewer-bootstrap-rollback:pre-ghcr-dev
AUTOUPDATE_BOOTSTRAP_RECORD_PATH=${relativeFixture}/state/bootstrap.txt
AUTOUPDATE_BOOTSTRAP_PUBLIC_URL=https://kpe-content.dev.e2open.com/
`);

  return {
    fixture,
    bin,
    actions,
    config,
    record,
    relativeActions: `${relativeFixture}/actions.log`,
    relativeBin: `${relativeFixture}/bin`,
    relativeConfig: `${relativeFixture}/autoupdate.conf`,
    bashBin: bashPath(bin),
  };
}

test("NPM Compose is image-only and preserves the proxy and content-volume contracts", async () => {
  const compose = parseYaml(await source("docker-compose.npm.yml"), "docker-compose.npm.yml");
  const service = compose.services?.["content-viewer"];

  assert.ok(service);
  assert.equal(Object.hasOwn(service, "build"), false);
  assert.equal(service.image, "${CONTENT_VIEWER_IMAGE:?CONTENT_VIEWER_IMAGE must be set}");
  assert.equal(service.restart, "unless-stopped");
  assert.deepEqual(service.ports ?? [], []);
  assert.deepEqual(service.volumes, ["content-viewer-content:/app/content"]);
  assert.ok(Object.hasOwn(service.networks ?? {}, "content-viewer-egress"));
  assert.equal(service.networks?.["npm-proxy"]?.aliases?.[0], "content-viewer");
  assert.equal(compose.networks?.["npm-proxy"]?.external, true);
  assert.equal(compose.networks?.["npm-proxy"]?.name, "npm-proxy");

  const environmentExample = await source(".env.example");
  assert.match(environmentExample, /^CONTENT_VIEWER_IMAGE=ghcr\.io\/mkronvold-wtg\/content-viewer:dev$/m);
});

test("content-viewer configuration permits only the explicit GHCR development image", async () => {
  const config = await source("infra/docker/content-viewer-autoupdate.conf.example");

  assert.doesNotMatch(config, /\r/);
  assert.match(config, /^AUTOUPDATE_WORKDIR=\.$/m);
  assert.match(config, /^AUTOUPDATE_COMPOSE_FILES="docker-compose\.npm\.yml"$/m);
  assert.match(config, /^AUTOUPDATE_COMPOSE_ENV_FILES="\.env"$/m);
  assert.match(config, /^AUTOUPDATE_PROJECT_NAME=content-viewer$/m);
  assert.match(config, /^export AUTOUPDATE_PROJECT_NAME$/m);
  assert.match(config, /^export COMPOSE_PROJECT_NAME="\$AUTOUPDATE_PROJECT_NAME"$/m);
  assert.match(config, /^AUTOUPDATE_ALLOWED_SERVICES="content-viewer"$/m);
  assert.match(config, /^content-viewer=ghcr\.io\/mkronvold-wtg\/content-viewer:dev$/m);
  assert.match(config, /^AUTOUPDATE_REGISTRY_PROFILE=ghcr-dev$/m);
  assert.match(config, /^AUTOUPDATE_GHCR_MUTABLE_TAG=dev$/m);
  assert.match(config, /^AUTOUPDATE_TARGET_PLATFORM=linux\/amd64$/m);
  assert.match(config, /^AUTOUPDATE_UP_COMMAND=\.\/infra\/docker\/up\.sh$/m);
  assert.match(config, /^AUTOUPDATE_HEALTH_COMMAND=\.\/infra\/docker\/healthcheck\.sh$/m);
  assert.match(config, /^AUTOUPDATE_ROLLBACK_COMMAND=\.\/infra\/docker\/up\.sh$/m);
  assert.match(config, /^AUTOUPDATE_BOOTSTRAP_ROLLBACK_IMAGE=content-viewer-bootstrap-rollback:pre-ghcr-dev$/m);
  assert.match(config, /^AUTOUPDATE_BOOTSTRAP_PUBLIC_URL=https:\/\/kpe-content\.dev\.e2open\.com\/$/m);
  assert.doesNotMatch(config, /latest|@sha256/);
});

test("vendored updater matches the recorded techstack main template revision", async () => {
  const operations = await source("docs/operations.md");
  assert.match(operations, new RegExp(canonicalRevision));
  assert.match(operations, /mkronvold\/techstack.*templates\/compose-autoupdate/s);

  for (const [relativePath, expectedHash] of Object.entries(templateHashes)) {
    const contents = await source(`templates/compose-autoupdate/${relativePath}`);
    const actualHash = createHash("sha256").update(contents.replace(/\r\n/g, "\n")).digest("hex");
    assert.equal(actualHash, expectedHash, `templates/compose-autoupdate/${relativePath} must remain the canonical vendor copy`);
  }
});

test("application wrappers preserve image-only and named-volume safety", async () => {
  const [project, up, down, health, updater, bootstrap] = await Promise.all([
    source("infra/docker/compose-project.sh"),
    source("infra/docker/up.sh"),
    source("infra/docker/down.sh"),
    source("infra/docker/healthcheck.sh"),
    source("infra/docker/autoupdate.sh"),
    source("infra/docker/bootstrap-ghcr-dev.sh"),
  ]);

  assert.match(project, /^#!\/usr\/bin\/env bash/m);
  assert.doesNotMatch(project, /\r/);
  for (const script of [up, down, health, updater, bootstrap]) {
    assert.doesNotMatch(script, /\r/);
    assert.match(script, /^#!\/usr\/bin\/env bash\r?\n\r?\nset -Eeuo pipefail/m);
  }
  for (const script of [up, down, health]) {
    assert.match(script, /--env-file \.env -f docker-compose\.npm\.yml/);
    assert.match(script, /-p "\$PROJECT"/);
  }
  for (const script of [up, health]) {
    assert.match(script, /--services content-viewer/);
  }

  assert.match(project, /CONTENT_VIEWER_DEPLOYMENT_PROJECT=content-viewer/);
  assert.match(project, /AUTOUPDATE_PROJECT_NAME must be a valid Compose project name/);
  assert.match(project, /AUTOUPDATE_PROJECT_NAME must be %s to reuse the existing persistent volume/);
  assert.match(up, /up -d --no-build --no-deps/);
  assert.doesNotMatch(up, /\s--build(?:\s|$)/);
  assert.doesNotMatch(up, /\bpull\b|\brestart\b/);
  assert.match(down, /-v\|--volumes\|--volumes=\*/);
  assert.match(down, /Refusing to remove persistent volumes/);
  assert.doesNotMatch(down, /down\s+.*(?:-v|--volumes)/);
  assert.match(health, /\/api\/health/);
  assert.match(health, /MAX_ATTEMPTS=20/);
  assert.match(health, /RETRY_SECONDS=3/);
  assert.match(updater, /source "\$CONFIG_PATH"/);
  assert.match(updater, /validate_project_name/);
  assert.match(updater, /export COMPOSE_PROJECT_NAME="\$PROJECT"/);
  assert.match(updater, /templates\/compose-autoupdate\/autoupdate\.sh/);
  assert.match(updater, /"\$\{ORIGINAL_ARGS\[@\]\}"/);

  assert.match(bootstrap, /AUTOUPDATE_BOOTSTRAP_ROLLBACK_IMAGE/);
  assert.match(bootstrap, /EXPECTED_VOLUME="\$\{PROJECT\}_content-viewer-content"/);
  assert.match(bootstrap, /run_compose pull content-viewer/);
  assert.match(bootstrap, /run_compose up -d --no-build --no-deps content-viewer/);
  assert.match(bootstrap, /curl --fail --silent --show-error --max-time 20/);
  assert.match(bootstrap, /docker image tag "\$prior_image_id" "\$ROLLBACK_IMAGE"/);
  assert.match(bootstrap, /docker image tag "\$prior_image_id" "\$EXPECTED_IMAGE"/);
  assert.match(bootstrap, /mv -- "\$temporary_record" "\$RECORD_PATH"/);
  assert.doesNotMatch(bootstrap, /run_compose down|\s--build(?:\s|$)/);
});

test("bootstrap preserves the discovered project, volume, and rollback image without Docker", async () => {
  const fixture = await createBootstrapFixture();

  try {
    await execFileAsync("bash", ["-c", `PATH='${fixture.bashBin}':"$PATH"; export PATH; ACTION_LOG='${fixture.relativeActions}'; export ACTION_LOG; exec bash infra/docker/bootstrap-ghcr-dev.sh --config ${fixture.relativeConfig}`], {
      cwd: root,
      env: process.env,
    });

    const [actions, record] = await Promise.all([
      readFile(fixture.actions, "utf8"),
      readFile(fixture.record, "utf8"),
    ]);
    assert.match(actions, /docker compose -p content-viewer --env-file \.env -f docker-compose\.npm\.yml pull content-viewer/);
    assert.match(actions, /docker compose -p content-viewer --env-file \.env -f docker-compose\.npm\.yml up -d --no-build --no-deps content-viewer/);
    assert.match(actions, /docker image tag build-origin-image-id content-viewer-bootstrap-rollback:pre-ghcr-dev/);
    assert.match(actions, /curl --fail --silent --show-error --max-time 20 https:\/\/kpe-content\.dev\.e2open\.com\//);
    assert.doesNotMatch(actions, /\bdown\b|\s--build(?:\s|$)/);
    assert.match(record, /^project=content-viewer$/m);
    assert.match(record, /^volume=content-viewer_content-viewer-content$/m);
    assert.match(record, /^rollback_image=content-viewer-bootstrap-rollback:pre-ghcr-dev$/m);
  } finally {
    await rm(fixture.fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("bootstrap rejects any project other than the discovered Dockerhost project before Compose runs", async () => {
  const fixture = await createBootstrapFixture("another-project");

  try {
    await assert.rejects(
      execFileAsync("bash", ["-c", `PATH='${fixture.bashBin}':"$PATH"; export PATH; ACTION_LOG='${fixture.relativeActions}'; export ACTION_LOG; exec bash infra/docker/bootstrap-ghcr-dev.sh --config ${fixture.relativeConfig}`], {
        cwd: root,
        env: process.env,
      }),
      /AUTOUPDATE_PROJECT_NAME must be content-viewer/,
    );
    assert.equal(await readFile(fixture.actions, "utf8"), "");
  } finally {
    await rm(fixture.fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("user systemd templates run one safe cycle on the intended cadence", async () => {
  const [service, timer] = await Promise.all([
    source("infra/docker/systemd/content-viewer-autoupdate.service"),
    source("infra/docker/systemd/content-viewer-autoupdate.timer"),
  ]);

  assert.match(service, /^Type=oneshot$/m);
  assert.doesNotMatch(service, /\r/);
  assert.doesNotMatch(timer, /\r/);
  assert.match(service, /^SuccessExitStatus=10$/m);
  assert.match(service, /^TimeoutStopSec=2min$/m);
  assert.match(service, /^WorkingDirectory=%h\/content-viewer$/m);
  assert.match(service, /^Environment=HOME=%h$/m);
  assert.match(service, /^ExecStart=%h\/content-viewer\/infra\/docker\/autoupdate\.sh --config %h\/\.config\/content-viewer\/autoupdate\.conf --once$/m);
  assert.doesNotMatch(service, /\/home\/|token|password|secret/i);
  assert.match(timer, /^OnCalendar=\*:0\/30$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^RandomizedDelaySec=5m$/m);
  assert.match(timer, /^Unit=content-viewer-autoupdate\.service$/m);
});

test("operator documentation keeps the development channel and volume safety explicit", async () => {
  const [readme, operations] = await Promise.all([
    source("README.md"),
    source("docs/operations.md"),
  ]);

  const documentation = `${readme}\n${operations}`;
  assert.match(documentation, /development-only mutable GHCR.*:dev/i);
  assert.match(documentation, /Docker credential\s+store/i);
  assert.match(documentation, /loginctl enable-linger <deployment-user>/);
  assert.match(documentation, /content-viewer-autoupdate\.timer/);
  assert.match(documentation, /copied-volume rehearsal/i);
  assert.match(documentation, /Never run `docker compose down -v`/);
  assert.match(documentation, /not installed/i);
  assert.match(documentation, /content-viewer_content-viewer-content/);
  assert.match(documentation, /AUTOUPDATE_PROJECT_NAME=content-viewer/);
  assert.match(documentation, /First image-only cutover \(one time\)/);

  const bootstrapIndex = documentation.indexOf("./infra/docker/bootstrap-ghcr-dev.sh --config");
  const dryRunIndex = documentation.indexOf("./infra/docker/autoupdate.sh --config");
  const timerIndex = documentation.indexOf("systemctl --user enable --now content-viewer-autoupdate.timer");
  assert.notEqual(bootstrapIndex, -1);
  assert.ok(dryRunIndex > bootstrapIndex, "the bootstrap must precede updater dry run");
  assert.ok(timerIndex > dryRunIndex, "the dry run must precede timer enablement");
});
