import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkMaintenanceQueue,
  evaluateCandidateScanDelta,
  parsePinnedNodeDockerfile,
  replacePinnedNodeDigest,
  resolveDockerfileCandidate,
  selectPlatformDescriptor,
  validateDeploymentPlatform,
  verifyFreshMaintenanceGate,
  verifyPullRequestEvidence,
} from '../scripts/base-digest-remediation.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const currentDigest = digest('a');
const candidateDigest = digest('b');
const currentPlatformDigest = digest('c');
const candidatePlatformDigest = digest('d');
const currentConfigDigest = digest('e');
const candidateConfigDigest = digest('f');
const scannedBaseSha = '1'.repeat(40);
const dockerfile = [
  `FROM node:26-bookworm-slim@${currentDigest} AS dependencies`,
  'RUN true',
  `FROM node:26-bookworm-slim@${currentDigest} AS runtime`,
].join('\n');

function index(descriptorDigest) {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: descriptorDigest,
      platform: { os: 'linux', architecture: 'amd64' },
    }],
  };
}

function image(configDigest) {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: configDigest },
    layers: [{ digest: digest('1') }],
  };
}

function response(body, contentDigest, mediaType) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'docker-content-digest') return contentDigest;
        if (name.toLowerCase() === 'content-type') return mediaType;
        return null;
      },
    },
    json: async () => body,
  };
}

function registryFetch({ tagDigest = candidateDigest } = {}) {
  return async (url) => {
    if (url.hostname === 'auth.docker.io') {
      return response({ token: `token-${'a'.repeat(40)}` }, null, 'application/json');
    }
    const reference = decodeURIComponent(url.pathname.split('/').at(-1));
    if (reference === currentDigest) {
      return response(index(currentPlatformDigest), currentDigest, 'application/vnd.oci.image.index.v1+json');
    }
    if (reference === '26-bookworm-slim') {
      return response(index(tagDigest === currentDigest ? currentPlatformDigest : candidatePlatformDigest), tagDigest, 'application/vnd.oci.image.index.v1+json');
    }
    if (reference === currentPlatformDigest) {
      return response(image(currentConfigDigest), currentPlatformDigest, 'application/vnd.oci.image.manifest.v1+json');
    }
    if (reference === candidatePlatformDigest) {
      return response(image(candidateConfigDigest), candidatePlatformDigest, 'application/vnd.oci.image.manifest.v1+json');
    }
    throw new Error(`unexpected registry request for ${reference}`);
  };
}

function trivyEvidence(vulnerabilities) {
  return {
    SchemaVersion: 2,
    Results: [{
      Target: 'content-viewer:base-digest-remediation (debian 13.0)',
      Vulnerabilities: vulnerabilities,
    }],
  };
}

function finding(id, severity, installedVersion = '1.0.0') {
  return {
    VulnerabilityID: id,
    PkgName: 'test-package',
    InstalledVersion: installedVersion,
    Severity: severity,
  };
}

function yamlMappingBlock(source, declaration) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => declaration.test(line));
  assert.notEqual(start, -1, `Missing YAML declaration matching ${declaration}`);
  const indentation = lines[start].match(/^(\s*)/)[1].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*(?:#.*)?$/.test(lines[index])) continue;
    if (lines[index].match(/^(\s*)/)[1].length <= indentation) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function yamlDirectMapping(block) {
  const lines = block.split('\n');
  const firstEntry = lines.find((line) => /^\s*[^#\s][^:]*:\s*/.test(line));
  assert.ok(firstEntry, 'Expected YAML mapping entries');
  const indentation = firstEntry.match(/^(\s*)/)[1].length;
  return Object.fromEntries(lines.flatMap((line) => {
    const match = line.match(new RegExp(`^\\s{${indentation}}([^:#\\s]+)\\s*:\\s*([^#\\s]+)`));
    if (!match) return [];
    return [[match[1], match[2].replace(/^['"]|['"]$/g, '')]];
  }));
}

function yamlDirectKeys(block) {
  const lines = block.split('\n');
  const firstEntry = lines.find((line) => /^\s*[^#\s][^:]*:/.test(line));
  assert.ok(firstEntry, 'Expected YAML mapping entries');
  const indentation = firstEntry.match(/^(\s*)/)[1].length;
  return lines.flatMap((line) => {
    const match = line.match(new RegExp(`^\\s{${indentation}}([^:#\\s]+)\\s*:`));
    return match ? [match[1]] : [];
  });
}

test('parses the actual pinned runtime tag and changes only its digest', () => {
  const parsed = parsePinnedNodeDockerfile(dockerfile);
  assert.equal(parsed.tag, '26-bookworm-slim');
  assert.equal(parsed.digest, currentDigest);
  assert.equal(parsed.references.length, 2);
  const candidate = replacePinnedNodeDigest(dockerfile, currentDigest, candidateDigest);
  assert.equal(candidate.includes(currentDigest), false);
  assert.equal((candidate.match(new RegExp(candidateDigest, 'g')) ?? []).length, 2);
});

test('rejects malformed Dockerfile and unapproved platform input', () => {
  assert.throws(
    () => parsePinnedNodeDockerfile('FROM node:26-bookworm-slim AS runtime'),
    /exact tag@sha256 digest/,
  );
  assert.throws(() => validateDeploymentPlatform('linux/arm64'), /explicit allowlisted value/);
  assert.throws(() => validateDeploymentPlatform('linux/amd64;rm'), /explicit allowlisted value/);
});

test('resolves only the selected official platform manifest', async () => {
  const result = await resolveDockerfileCandidate({
    dockerfile,
    platform: 'linux/amd64',
    fetchImpl: registryFetch(),
  });
  assert.equal(result.current.digest, currentDigest);
  assert.equal(result.current.platformManifestDigest, currentPlatformDigest);
  assert.equal(result.candidate.digest, candidateDigest);
  assert.equal(result.candidate.platformManifestDigest, candidatePlatformDigest);
  assert.throws(
    () => selectPlatformDescriptor({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [],
    }, 'linux/amd64'),
    /must contain manifest descriptors/,
  );
});

test('reports a tag digest already in use as a no-op', async () => {
  const result = await resolveDockerfileCandidate({
    dockerfile,
    platform: 'linux/amd64',
    fetchImpl: registryFetch({ tagDigest: currentDigest }),
  });
  assert.equal(result.candidate, null);
});

test('qualifies only a High or Critical remediation with no new findings', () => {
  const current = trivyEvidence([
    finding('CVE-removed', 'HIGH'),
    finding('CVE-retained', 'MEDIUM'),
  ]);
  const qualified = evaluateCandidateScanDelta(current, trivyEvidence([finding('CVE-retained', 'MEDIUM')]));
  assert.equal(qualified.qualifies, true);
  assert.equal(qualified.removedAcceptedHighCritical[0].id, 'CVE-removed');

  const rejected = evaluateCandidateScanDelta(
    current,
    trivyEvidence([finding('CVE-retained', 'MEDIUM'), finding('CVE-new', 'LOW')]),
  );
  assert.equal(rejected.qualifies, false);
  assert.equal(rejected.introduced[0].id, 'CVE-new');
});

test('PR evidence requires the scanned base and exact Dockerfile digest substitution', () => {
  const resolution = {
    version: 1,
    source: {
      registry: 'registry-1.docker.io',
      repository: 'library/node',
      tag: '26-bookworm-slim',
      endpoint: 'https://registry-1.docker.io/v2/library/node/manifests/26-bookworm-slim',
    },
    platform: 'linux/amd64',
    tag: '26-bookworm-slim',
    current: {
      digest: currentDigest,
      platformManifestDigest: currentPlatformDigest,
      configDigest: currentConfigDigest,
    },
    candidate: {
      digest: candidateDigest,
      platformManifestDigest: candidatePlatformDigest,
      configDigest: candidateConfigDigest,
    },
  };
  const scanDelta = {
    version: 1,
    currentFindingCount: 1,
    candidateFindingCount: 0,
    introduced: [],
    removedAcceptedHighCritical: [{
      id: 'CVE-removed',
      target: 'content-viewer:base-digest-remediation (debian 13.0)',
      packageName: 'test-package',
      installedVersion: '1.0.0',
      severity: 'HIGH',
    }],
    qualifies: true,
  };
  const pullRequest = {
    head: {
      repo: { full_name: 'mkronvold-wtg/content-viewer' },
      ref: 'base-digest-remediation/123',
      sha: '2'.repeat(40),
    },
    base: {
      ref: 'main',
      sha: scannedBaseSha,
    },
    labels: [{ name: 'base-digest-remediation' }],
    title: 'chore: remediate node:26-bookworm-slim base digest',
    body: [
      currentDigest,
      candidateDigest,
      'linux/amd64',
      '<!-- base-digest-remediation: verified dockerfile-only high-critical-remediation -->',
    ].join('\n'),
  };
  const candidateDockerfile = replacePinnedNodeDigest(dockerfile, currentDigest, candidateDigest);
  assert.equal(verifyPullRequestEvidence({
    pullRequest,
    changedFiles: [{ filename: 'Dockerfile', status: 'modified' }],
    baselineDockerfile: dockerfile,
    candidateDockerfile,
    repository: 'mkronvold-wtg/content-viewer',
    branch: 'base-digest-remediation/123',
    expectedBaseSha: scannedBaseSha,
    resolution,
    scanDelta,
  }), true);
  assert.throws(() => verifyPullRequestEvidence({
    pullRequest,
    changedFiles: [{ filename: 'Dockerfile', status: 'modified' }, { filename: 'README.md', status: 'modified' }],
    baselineDockerfile: dockerfile,
    candidateDockerfile,
    repository: 'mkronvold-wtg/content-viewer',
    branch: 'base-digest-remediation/123',
    expectedBaseSha: scannedBaseSha,
    resolution,
    scanDelta,
  }), /Dockerfile-only/);
  assert.throws(() => verifyPullRequestEvidence({
    pullRequest,
    changedFiles: [{ filename: 'Dockerfile', status: 'modified' }],
    baselineDockerfile: dockerfile,
    candidateDockerfile: candidateDockerfile.replace('RUN true', 'RUN false'),
    repository: 'mkronvold-wtg/content-viewer',
    branch: 'base-digest-remediation/123',
    expectedBaseSha: scannedBaseSha,
    resolution,
    scanDelta,
  }), /other than the pinned Node digest/);
});

test('rejects a stale scanned base or newly occupied maintenance queue', () => {
  const clearQueue = checkMaintenanceQueue([]);
  assert.equal(verifyFreshMaintenanceGate({
    scannedBaseSha,
    currentBaseSha: scannedBaseSha,
    queue: clearQueue,
  }), true);
  assert.throws(() => verifyFreshMaintenanceGate({
    scannedBaseSha,
    currentBaseSha: '3'.repeat(40),
    queue: clearQueue,
  }), /main changed after the candidate was scanned/);
  const blockedQueue = checkMaintenanceQueue([{
    number: 9,
    head: { ref: 'dependabot/npm_and_yarn/mermaid-11.13.0' },
    labels: [],
  }]);
  assert.equal(blockedQueue.clear, false);
  assert.throws(() => verifyFreshMaintenanceGate({
    scannedBaseSha,
    currentBaseSha: scannedBaseSha,
    queue: blockedQueue,
  }), /blocks creation/);
});

test('remediation workflow accepts only scheduled trusted execution and never enables auto-merge', async () => {
  const root = resolve(process.cwd());
  const workflow = await readFile(resolve(root, '.github/workflows/base-digest-remediation.yml'), 'utf8');
  assert.match(workflow, /^on:\r?\n  schedule:/m);
  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/m);
  assert.match(workflow, /create-pull-request:[\s\S]*?github\.event_name == 'schedule'/);
  assert.doesNotMatch(workflow, /enable-auto-merge|gh pr merge|--auto/);
  const globalPermissions = yamlDirectMapping(
    yamlMappingBlock(workflow, /^permissions\s*:\s*(?:#.*)?$/m),
  );
  assert.deepEqual(globalPermissions, {
    contents: 'read',
    'pull-requests': 'read',
  });
  const jobs = yamlMappingBlock(workflow, /^jobs\s*:\s*(?:#.*)?$/m);
  const scan = yamlMappingBlock(jobs, /^\s+scan\s*:\s*(?:#.*)?$/m);
  assert.equal(yamlDirectKeys(scan).includes('permissions'), false);
  assert.match(
    scan,
    /Check out current main with read-only fetch credentials[\s\S]*?persist-credentials:\s*true[\s\S]*?git fetch --no-tags origin main/,
  );
  assert.doesNotMatch(
    scan,
    /(?:token\s*:\s*\$\{\{[^}]+\}\}|https:\/\/[^@\s]+@github\.com)/,
  );
  const actions = [...workflow.matchAll(/^\s*uses:\s*[^@\s]+@([a-f0-9]{40})(?:\s+#.*)?$/gm)];
  assert.ok(actions.length > 0);
  assert.equal(actions.every(([, pin]) => /^[a-f0-9]{40}$/.test(pin)), true);
});
