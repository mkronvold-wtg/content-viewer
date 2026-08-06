import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateCandidateScanDelta,
  parsePinnedNodeDockerfile,
  replacePinnedNodeDigest,
  resolveDockerfileCandidate,
  selectPlatformDescriptor,
  validateDeploymentPlatform,
  verifyPullRequestEligibility,
} from '../scripts/base-digest-remediation.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const currentDigest = digest('a');
const candidateDigest = digest('b');
const currentPlatformDigest = digest('c');
const candidatePlatformDigest = digest('d');
const currentConfigDigest = digest('e');
const candidateConfigDigest = digest('f');
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

test('auto-merge eligibility requires same-repository Dockerfile-only evidence', () => {
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
    headRepository: { nameWithOwner: 'mkronvold-wtg/content-viewer' },
    headRefName: 'base-digest-remediation/123',
    baseRefName: 'main',
    labels: [{ name: 'base-digest-remediation' }],
    title: 'chore: remediate node:26-bookworm-slim base digest',
    body: [
      currentDigest,
      candidateDigest,
      'linux/amd64',
      '<!-- base-digest-remediation: verified dockerfile-only high-critical-remediation -->',
    ].join('\n'),
  };
  assert.equal(verifyPullRequestEligibility({
    pullRequest,
    changedFiles: [{ filename: 'Dockerfile', status: 'modified' }],
    repository: 'mkronvold-wtg/content-viewer',
    branch: 'base-digest-remediation/123',
    resolution,
    scanDelta,
  }), true);
  assert.throws(() => verifyPullRequestEligibility({
    pullRequest,
    changedFiles: [{ filename: 'Dockerfile', status: 'modified' }, { filename: 'README.md', status: 'modified' }],
    repository: 'mkronvold-wtg/content-viewer',
    branch: 'base-digest-remediation/123',
    resolution,
    scanDelta,
  }), /Dockerfile-only/);
});
