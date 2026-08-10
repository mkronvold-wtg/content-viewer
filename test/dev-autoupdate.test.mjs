import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

const root = resolve(process.cwd());
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
  assert.match(config, /^AUTOUPDATE_ALLOWED_SERVICES="content-viewer"$/m);
  assert.match(config, /^content-viewer=ghcr\.io\/mkronvold-wtg\/content-viewer:dev$/m);
  assert.match(config, /^AUTOUPDATE_REGISTRY_PROFILE=ghcr-dev$/m);
  assert.match(config, /^AUTOUPDATE_GHCR_MUTABLE_TAG=dev$/m);
  assert.match(config, /^AUTOUPDATE_TARGET_PLATFORM=linux\/amd64$/m);
  assert.match(config, /^AUTOUPDATE_UP_COMMAND=\.\/infra\/docker\/up\.sh$/m);
  assert.match(config, /^AUTOUPDATE_HEALTH_COMMAND=\.\/infra\/docker\/healthcheck\.sh$/m);
  assert.match(config, /^AUTOUPDATE_ROLLBACK_COMMAND=\.\/infra\/docker\/up\.sh$/m);
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
  const [up, down, health] = await Promise.all([
    source("infra/docker/up.sh"),
    source("infra/docker/down.sh"),
    source("infra/docker/healthcheck.sh"),
  ]);

  for (const script of [up, down, health]) {
    assert.doesNotMatch(script, /\r/);
    assert.match(script, /^#!\/usr\/bin\/env bash\r?\n\r?\nset -Eeuo pipefail/m);
    assert.match(script, /--env-file \.env -f docker-compose\.npm\.yml/);
  }
  for (const script of [up, health]) {
    assert.match(script, /--services content-viewer/);
  }

  assert.match(up, /up -d --no-build --no-deps/);
  assert.doesNotMatch(up, /\s--build(?:\s|$)/);
  assert.doesNotMatch(up, /\bpull\b|\brestart\b/);
  assert.match(down, /-v\|--volumes\|--volumes=\*/);
  assert.match(down, /Refusing to remove persistent volumes/);
  assert.doesNotMatch(down, /down\s+.*(?:-v|--volumes)/);
  assert.match(health, /\/api\/health/);
  assert.match(health, /MAX_ATTEMPTS=20/);
  assert.match(health, /RETRY_SECONDS=3/);
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
  assert.match(service, /^ExecStart=%h\/content-viewer\/templates\/compose-autoupdate\/autoupdate\.sh --config %h\/\.config\/content-viewer\/autoupdate\.conf --once$/m);
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
});
