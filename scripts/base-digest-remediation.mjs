#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OFFICIAL_SOURCE = Object.freeze({
  registry: 'registry-1.docker.io',
  auth: 'auth.docker.io',
  repository: 'library/node',
  image: 'node',
});
const DEFAULT_DEPLOYMENT_PLATFORM = 'linux/amd64';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const NODE_TAG_PATTERN = /^26(?:[-.][a-z0-9][a-z0-9._-]*)?$/;
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const NODE_FROM_PATTERN = /^\s*FROM\s+(?:--platform=[^\s]+\s+)?(node:([a-z0-9][a-z0-9._-]*)@(sha256:[a-f0-9]{64}))(?:\s+AS\s+([a-z0-9][a-z0-9_.-]*))?\s*(?:#.*)?$/im;
const IMAGE_MANIFEST_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const INDEX_MANIFEST_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const TRIVY_SEVERITIES = new Set(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const REMEDIATION_LABEL = 'base-digest-remediation';
const REMEDIATION_MARKER = '<!-- base-digest-remediation: verified dockerfile-only high-critical-remediation -->';

function fail(message) {
  throw new Error(`Base digest remediation failed: ${message}`);
}

function assertPlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value;
}

function assertDigest(value, field) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail(`${field} must be an exact lowercase sha256 digest`);
  }
  return value;
}

function assertNodeTag(value, field = 'Node tag') {
  if (typeof value !== 'string' || !NODE_TAG_PATTERN.test(value)) {
    fail(`${field} must be an allowlisted Node 26 tag`);
  }
  return value;
}

export function validateDeploymentPlatform(value) {
  if (typeof value !== 'string' || !PLATFORM_PATTERN.test(value) || value !== DEFAULT_DEPLOYMENT_PLATFORM) {
    fail(`deployment platform must be the explicit allowlisted value ${DEFAULT_DEPLOYMENT_PLATFORM}`);
  }
  const [os, architecture] = value.split('/');
  return { value, os, architecture };
}

function assertEvidenceText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\r\n\u0000]/.test(value)) {
    fail(`${field} must be a bounded single-line string`);
  }
  return value;
}

export function parsePinnedNodeDockerfile(source) {
  if (typeof source !== 'string' || source.length === 0) fail('Dockerfile must be non-empty text');
  const references = [];
  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!/^\s*FROM\s+(?:--platform=[^\s]+\s+)?node:/i.test(line)) continue;
    const match = line.match(NODE_FROM_PATTERN);
    if (!match) fail(`Dockerfile line ${index + 1} must pin node to an exact tag@sha256 digest`);
    const [, reference, tag, digest, stage = ''] = match;
    assertNodeTag(tag, `Dockerfile line ${index + 1} Node tag`);
    assertDigest(digest, `Dockerfile line ${index + 1} digest`);
    references.push({ reference, tag, digest, stage: stage.toLowerCase(), line: index + 1 });
  }
  if (references.length === 0) fail('Dockerfile must contain a pinned official node:26...@sha256 FROM line');
  const runtime = references.filter((entry) => entry.stage === 'runtime');
  if (runtime.length !== 1) fail('Dockerfile must contain exactly one pinned Node runtime stage');
  const { tag, digest } = runtime[0];
  if (!references.every((entry) => entry.tag === tag && entry.digest === digest)) {
    fail('all pinned Node build stages must use the exact runtime tag and digest');
  }
  return { tag, digest, references };
}

export function replacePinnedNodeDigest(source, expectedDigest, candidateDigest) {
  const parsed = parsePinnedNodeDockerfile(source);
  assertDigest(expectedDigest, 'expected digest');
  assertDigest(candidateDigest, 'candidate digest');
  if (parsed.digest !== expectedDigest) fail('Dockerfile digest does not match the expected current digest');
  if (expectedDigest === candidateDigest) fail('candidate digest must differ from the current digest');
  return source.replace(new RegExp(NODE_FROM_PATTERN.source, 'gim'), (line) => {
    const match = line.match(NODE_FROM_PATTERN);
    return line.replace(match[1], `node:${parsed.tag}@${candidateDigest}`);
  });
}

function sameNodeStages(left, right) {
  return left.references.length === right.references.length
    && left.references.every((entry, index) => entry.tag === right.references[index].tag && entry.stage === right.references[index].stage);
}

export function verifyDigestOnlyDockerfileChange(baseline, candidate, resolution) {
  const validated = validateResolution(resolution);
  const before = parsePinnedNodeDockerfile(baseline);
  const after = parsePinnedNodeDockerfile(candidate);
  if (before.tag !== validated.tag || before.digest !== validated.current.digest) {
    fail('baseline Dockerfile does not match the resolved current Node image');
  }
  if (!validated.candidate) fail('a no-op resolution cannot produce a candidate Dockerfile');
  if (after.tag !== validated.tag || after.digest !== validated.candidate.digest || !sameNodeStages(before, after)) {
    fail('candidate Dockerfile must retain Node tag and stages while changing to the resolved digest');
  }
  const reversed = replacePinnedNodeDigest(candidate, validated.candidate.digest, validated.current.digest);
  if (reversed !== baseline) fail('candidate Dockerfile changes content other than the pinned Node digest');
  return true;
}

function manifestEndpoint(reference) {
  if (!(NODE_TAG_PATTERN.test(reference) || DIGEST_PATTERN.test(reference))) {
    fail('registry manifest reference must be an allowlisted Node tag or sha256 digest');
  }
  return new URL(`https://${OFFICIAL_SOURCE.registry}/v2/${OFFICIAL_SOURCE.repository}/manifests/${encodeURIComponent(reference)}`);
}

function tokenEndpoint() {
  const url = new URL(`https://${OFFICIAL_SOURCE.auth}/token`);
  url.searchParams.set('service', 'registry.docker.io');
  url.searchParams.set('scope', `repository:${OFFICIAL_SOURCE.repository}:pull`);
  return url;
}

function assertTrustedRegistryUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    fail('registry request must use a credential-free HTTPS URL');
  }
  const isToken = url.hostname === OFFICIAL_SOURCE.auth && url.pathname === '/token';
  const isManifest = url.hostname === OFFICIAL_SOURCE.registry
    && url.pathname.startsWith(`/v2/${OFFICIAL_SOURCE.repository}/manifests/`);
  if (!isToken && !isManifest) fail('registry request URL is not allowlisted');
  return url;
}

async function fetchJson(fetchImpl, url, options, description) {
  assertTrustedRegistryUrl(url);
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(`${description} request failed: ${error.message}`);
  }
  if (!response || !response.ok) {
    fail(`${description} request returned HTTP ${response?.status ?? 'unknown'}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    fail(`${description} response is not valid JSON: ${error.message}`);
  }
  return { response, body };
}

async function obtainRegistryToken(fetchImpl) {
  const { body } = await fetchJson(
    fetchImpl,
    tokenEndpoint(),
    { headers: { Accept: 'application/json' } },
    'official registry token',
  );
  assertPlainObject(body, 'official registry token response');
  const token = typeof body.token === 'string' ? body.token : body.access_token;
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{20,8192}$/.test(token)) {
    fail('official registry token response contains an invalid token');
  }
  return token;
}

function contentType(response) {
  const type = response.headers?.get?.('content-type');
  if (typeof type !== 'string' || type === '') fail('registry manifest response is missing Content-Type');
  return type.split(';', 1)[0].trim().toLowerCase();
}

async function obtainManifest(fetchImpl, token, reference) {
  const { response, body } = await fetchJson(
    fetchImpl,
    manifestEndpoint(reference),
    {
      headers: {
        Accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.v2+json',
        ].join(', '),
        Authorization: `Bearer ${token}`,
      },
    },
    `official Node manifest ${reference}`,
  );
  const digest = response.headers?.get?.('docker-content-digest');
  assertDigest(digest, `official Node manifest ${reference} Docker-Content-Digest`);
  if (DIGEST_PATTERN.test(reference) && digest !== reference) {
    fail(`official Node manifest digest response did not match requested ${reference}`);
  }
  return { digest, mediaType: contentType(response), body };
}

function assertManifestObject(value, field) {
  assertPlainObject(value, field);
  if (value.schemaVersion !== 2) fail(`${field} must have schemaVersion 2`);
  if (typeof value.mediaType === 'string' && value.mediaType.length > 160) fail(`${field} mediaType is malformed`);
}

export function selectPlatformDescriptor(index, platformValue) {
  const platform = validateDeploymentPlatform(platformValue);
  assertManifestObject(index, 'registry image index');
  const declaredType = index.mediaType;
  if (typeof declaredType !== 'string' || !INDEX_MANIFEST_TYPES.has(declaredType)) {
    fail('registry tag response must be an OCI or Docker manifest index');
  }
  if (!Array.isArray(index.manifests) || index.manifests.length === 0) {
    fail('registry image index must contain manifest descriptors');
  }
  const matches = [];
  for (const [position, descriptor] of index.manifests.entries()) {
    assertPlainObject(descriptor, `registry image index descriptor ${position}`);
    assertDigest(descriptor.digest, `registry image index descriptor ${position} digest`);
    if (!IMAGE_MANIFEST_TYPES.has(descriptor.mediaType)) {
      fail(`registry image index descriptor ${position} has an untrusted media type`);
    }
    assertPlainObject(descriptor.platform, `registry image index descriptor ${position} platform`);
    const { os, architecture } = descriptor.platform;
    if (typeof os !== 'string' || typeof architecture !== 'string') {
      fail(`registry image index descriptor ${position} platform is malformed`);
    }
    if (os === platform.os && architecture === platform.architecture) matches.push(descriptor);
  }
  if (matches.length !== 1) {
    fail(`registry image index must contain exactly one ${platform.value} image manifest`);
  }
  return matches[0];
}

function validatePlatformManifest(manifest, descriptor) {
  assertManifestObject(manifest, 'registry platform manifest');
  if (typeof manifest.mediaType !== 'string' || !IMAGE_MANIFEST_TYPES.has(manifest.mediaType)) {
    fail('registry platform manifest has an untrusted media type');
  }
  if (manifest.mediaType !== descriptor.mediaType) {
    fail('registry platform manifest media type differs from its index descriptor');
  }
  assertPlainObject(manifest.config, 'registry platform manifest config');
  assertDigest(manifest.config.digest, 'registry platform manifest config digest');
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    fail('registry platform manifest must contain layers');
  }
  for (const [index, layer] of manifest.layers.entries()) {
    assertPlainObject(layer, `registry platform manifest layer ${index}`);
    assertDigest(layer.digest, `registry platform manifest layer ${index} digest`);
  }
  return manifest.config.digest;
}

async function resolveManifestForPlatform(fetchImpl, token, reference, platformValue) {
  const index = await obtainManifest(fetchImpl, token, reference);
  if (!INDEX_MANIFEST_TYPES.has(index.mediaType) || index.body.mediaType !== index.mediaType) {
    fail(`official Node manifest ${reference} did not return a verified manifest index`);
  }
  const descriptor = selectPlatformDescriptor(index.body, platformValue);
  const platformManifest = await obtainManifest(fetchImpl, token, descriptor.digest);
  if (platformManifest.digest !== descriptor.digest || platformManifest.mediaType !== descriptor.mediaType) {
    fail('selected platform manifest does not match its signed index descriptor');
  }
  return {
    digest: index.digest,
    platformManifestDigest: descriptor.digest,
    configDigest: validatePlatformManifest(platformManifest.body, descriptor),
  };
}

export async function resolveDockerfileCandidate({ dockerfile, platform = DEFAULT_DEPLOYMENT_PLATFORM, fetchImpl = fetch }) {
  const parsed = parsePinnedNodeDockerfile(dockerfile);
  validateDeploymentPlatform(platform);
  if (typeof fetchImpl !== 'function') fail('registry fetch implementation must be a function');
  const token = await obtainRegistryToken(fetchImpl);
  const current = await resolveManifestForPlatform(fetchImpl, token, parsed.digest, platform);
  const fromTag = await resolveManifestForPlatform(fetchImpl, token, parsed.tag, platform);
  return {
    version: 1,
    source: {
      registry: OFFICIAL_SOURCE.registry,
      repository: OFFICIAL_SOURCE.repository,
      tag: parsed.tag,
      endpoint: `https://${OFFICIAL_SOURCE.registry}/v2/${OFFICIAL_SOURCE.repository}/manifests/${parsed.tag}`,
    },
    platform,
    tag: parsed.tag,
    current,
    candidate: fromTag.digest === parsed.digest ? null : fromTag,
  };
}

function validateManifestEvidence(value, field) {
  assertPlainObject(value, field);
  return {
    digest: assertDigest(value.digest, `${field}.digest`),
    platformManifestDigest: assertDigest(value.platformManifestDigest, `${field}.platformManifestDigest`),
    configDigest: assertDigest(value.configDigest, `${field}.configDigest`),
  };
}

export function validateResolution(value) {
  assertPlainObject(value, 'resolution');
  if (value.version !== 1) fail('resolution version must be 1');
  assertPlainObject(value.source, 'resolution.source');
  if (value.source.registry !== OFFICIAL_SOURCE.registry || value.source.repository !== OFFICIAL_SOURCE.repository) {
    fail('resolution source is not the allowlisted official Node registry');
  }
  const tag = assertNodeTag(value.tag, 'resolution.tag');
  if (value.source.tag !== tag || value.source.endpoint !== `https://${OFFICIAL_SOURCE.registry}/v2/${OFFICIAL_SOURCE.repository}/manifests/${tag}`) {
    fail('resolution source does not prove the resolved Node tag');
  }
  validateDeploymentPlatform(value.platform);
  const current = validateManifestEvidence(value.current, 'resolution.current');
  const candidate = value.candidate === null ? null : validateManifestEvidence(value.candidate, 'resolution.candidate');
  if (candidate && candidate.digest === current.digest) fail('resolution candidate digest must differ from current digest');
  return {
    version: 1,
    source: { ...value.source },
    platform: value.platform,
    tag,
    current,
    candidate,
  };
}

function parseTrivyFindings(evidence, name) {
  assertPlainObject(evidence, `${name} Trivy evidence`);
  if ((typeof evidence.SchemaVersion !== 'number' && typeof evidence.SchemaVersion !== 'string') || !Array.isArray(evidence.Results)) {
    fail(`${name} Trivy evidence is malformed`);
  }
  const findings = new Map();
  for (const [resultIndex, result] of evidence.Results.entries()) {
    assertPlainObject(result, `${name} Trivy result ${resultIndex}`);
    const target = assertEvidenceText(result.Target, `${name} Trivy result ${resultIndex} target`);
    if (result.Vulnerabilities === undefined || result.Vulnerabilities === null) continue;
    if (!Array.isArray(result.Vulnerabilities)) fail(`${name} Trivy result ${resultIndex} vulnerabilities are malformed`);
    for (const [findingIndex, finding] of result.Vulnerabilities.entries()) {
      assertPlainObject(finding, `${name} Trivy finding ${resultIndex}:${findingIndex}`);
      const id = assertEvidenceText(finding.VulnerabilityID, `${name} Trivy finding ${resultIndex}:${findingIndex} id`);
      const packageName = assertEvidenceText(finding.PkgName, `${name} Trivy finding ${resultIndex}:${findingIndex} package`);
      const installedVersion = assertEvidenceText(finding.InstalledVersion, `${name} Trivy finding ${resultIndex}:${findingIndex} installed version`);
      if (typeof finding.Severity !== 'string' || !TRIVY_SEVERITIES.has(finding.Severity)) {
        fail(`${name} Trivy finding ${resultIndex}:${findingIndex} has an invalid severity`);
      }
      const key = [target, id, packageName, installedVersion].join('\u0000');
      const normalized = { id, target, packageName, installedVersion, severity: finding.Severity };
      const existing = findings.get(key);
      if (existing && existing.severity !== normalized.severity) {
        fail(`${name} Trivy evidence has conflicting severities for the same finding`);
      }
      findings.set(key, normalized);
    }
  }
  return findings;
}

export function evaluateCandidateScanDelta(currentEvidence, candidateEvidence) {
  const current = parseTrivyFindings(currentEvidence, 'current');
  const candidate = parseTrivyFindings(candidateEvidence, 'candidate');
  const introduced = [...candidate.entries()]
    .filter(([key]) => !current.has(key))
    .map(([, finding]) => finding);
  const removedAcceptedHighCritical = [...current.entries()]
    .filter(([key, finding]) => ['HIGH', 'CRITICAL'].includes(finding.severity) && !candidate.has(key))
    .map(([, finding]) => finding);
  return {
    version: 1,
    currentFindingCount: current.size,
    candidateFindingCount: candidate.size,
    introduced,
    removedAcceptedHighCritical,
    qualifies: introduced.length === 0 && removedAcceptedHighCritical.length > 0,
  };
}

function validateScanDelta(value) {
  assertPlainObject(value, 'scan delta');
  if (value.version !== 1 || !Number.isInteger(value.currentFindingCount) || !Number.isInteger(value.candidateFindingCount)
    || !Array.isArray(value.introduced) || !Array.isArray(value.removedAcceptedHighCritical) || typeof value.qualifies !== 'boolean') {
    fail('scan delta is malformed');
  }
  const validateFinding = (finding, field) => {
    assertPlainObject(finding, field);
    const normalized = {
      id: assertEvidenceText(finding.id, `${field}.id`),
      target: assertEvidenceText(finding.target, `${field}.target`),
      packageName: assertEvidenceText(finding.packageName, `${field}.packageName`),
      installedVersion: assertEvidenceText(finding.installedVersion, `${field}.installedVersion`),
      severity: finding.severity,
    };
    if (!TRIVY_SEVERITIES.has(normalized.severity)) fail(`${field}.severity is invalid`);
    return normalized;
  };
  const introduced = value.introduced.map((finding, index) => validateFinding(finding, `scan delta introduced ${index}`));
  const removedAcceptedHighCritical = value.removedAcceptedHighCritical
    .map((finding, index) => validateFinding(finding, `scan delta removed ${index}`));
  if (removedAcceptedHighCritical.some((finding) => !['HIGH', 'CRITICAL'].includes(finding.severity))) {
    fail('scan delta remediation findings must be High or Critical');
  }
  if (value.qualifies !== (introduced.length === 0 && removedAcceptedHighCritical.length > 0)) {
    fail('scan delta qualification does not match its findings');
  }
  return {
    version: 1,
    currentFindingCount: value.currentFindingCount,
    candidateFindingCount: value.candidateFindingCount,
    introduced,
    removedAcceptedHighCritical,
    qualifies: value.qualifies,
  };
}

function flattenPullRequests(value, accumulator = []) {
  if (Array.isArray(value)) {
    for (const entry of value) flattenPullRequests(entry, accumulator);
    return accumulator;
  }
  if (value !== null && typeof value === 'object') accumulator.push(value);
  return accumulator;
}

export function checkMaintenanceQueue(value) {
  const blockers = [];
  for (const pull of flattenPullRequests(value)) {
    const labels = Array.isArray(pull.labels)
      ? pull.labels.map((label) => label?.name).filter((name) => typeof name === 'string')
      : [];
    const ref = typeof pull.head?.ref === 'string' ? pull.head.ref : '';
    const conflicts = labels.includes('dependencies') || labels.includes('release-pin') || labels.includes(REMEDIATION_LABEL)
      || /^(?:dependabot|release-pin|base-digest-remediation)\//.test(ref);
    if (conflicts) {
      blockers.push({
        number: typeof pull.number === 'number' ? pull.number : null,
        ref: ref || null,
        labels: labels.filter((label) => ['dependencies', 'release-pin', REMEDIATION_LABEL].includes(label)),
      });
    }
  }
  return { version: 1, clear: blockers.length === 0, blockers };
}

function validateQueueStatus(value) {
  assertPlainObject(value, 'maintenance queue status');
  if (value.version !== 1 || typeof value.clear !== 'boolean' || !Array.isArray(value.blockers)) {
    fail('maintenance queue status is malformed');
  }
  return value;
}

function assertRepository(value) {
  if (value !== 'mkronvold-wtg/content-viewer') {
    fail('automatic remediation is restricted to mkronvold-wtg/content-viewer');
  }
  return value;
}

export function verifyPullRequestEligibility({ pullRequest, changedFiles, repository, branch, resolution, scanDelta }) {
  assertRepository(repository);
  if (typeof branch !== 'string' || !/^base-digest-remediation\/[1-9][0-9]*$/.test(branch)) {
    fail('automatic remediation branch name is invalid');
  }
  const verifiedResolution = validateResolution(resolution);
  const verifiedDelta = validateScanDelta(scanDelta);
  if (!verifiedResolution.candidate || !verifiedDelta.qualifies) {
    fail('automatic remediation requires a qualifying candidate and scan delta');
  }
  assertPlainObject(pullRequest, 'pull request');
  if (pullRequest.headRepository?.nameWithOwner !== repository || pullRequest.headRefName !== branch || pullRequest.baseRefName !== 'main') {
    fail('automatic remediation requires an action-created same-repository branch targeting main');
  }
  const labels = Array.isArray(pullRequest.labels) ? pullRequest.labels.map((label) => label?.name) : [];
  if (!labels.includes(REMEDIATION_LABEL)) fail(`pull request is missing the ${REMEDIATION_LABEL} label`);
  if (typeof pullRequest.body !== 'string' || !pullRequest.body.includes(REMEDIATION_MARKER)
    || !pullRequest.body.includes(verifiedResolution.current.digest)
    || !pullRequest.body.includes(verifiedResolution.candidate.digest)
    || !pullRequest.body.includes(verifiedResolution.platform)) {
    fail('pull request is missing required remediation evidence');
  }
  if (typeof pullRequest.title !== 'string' || !pullRequest.title.startsWith('chore: remediate node:')) {
    fail('pull request title is not a remediation title');
  }
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (files.length !== 1 || files[0]?.filename !== 'Dockerfile' || files[0]?.status !== 'modified') {
    fail('automatic remediation requires an exact Dockerfile-only pull request');
  }
  return true;
}

function remediationMetadata(resolution, scanDelta) {
  const verifiedResolution = validateResolution(resolution);
  const verifiedDelta = validateScanDelta(scanDelta);
  if (!verifiedResolution.candidate || !verifiedDelta.qualifies) {
    fail('cannot create metadata for a non-qualifying candidate');
  }
  const { current, candidate } = verifiedResolution;
  const removed = verifiedDelta.removedAcceptedHighCritical
    .map((finding) => `${finding.severity} ${finding.id} (${finding.packageName}@${finding.installedVersion})`)
    .join('; ');
  const title = `chore: remediate node:${verifiedResolution.tag} base digest ${current.digest.slice(7, 19)} to ${candidate.digest.slice(7, 19)}`;
  const body = [
    '# Node base-image digest remediation',
    '',
    'This pull request was created by the scheduled, registry-verified remediation workflow.',
    '',
    '| Evidence | Value |',
    '| --- | --- |',
    `| Node tag | \`node:${verifiedResolution.tag}\` |`,
    `| Target deployment platform | \`${verifiedResolution.platform}\` |`,
    `| Official source | \`${verifiedResolution.source.endpoint}\` |`,
    `| Current tag-manifest digest | \`${current.digest}\` |`,
    `| Candidate tag-manifest digest | \`${candidate.digest}\` |`,
    `| Current ${verifiedResolution.platform} manifest | \`${current.platformManifestDigest}\` |`,
    `| Candidate ${verifiedResolution.platform} manifest | \`${candidate.platformManifestDigest}\` |`,
    `| Current config digest | \`${current.configDigest}\` |`,
    `| Candidate config digest | \`${candidate.configDigest}\` |`,
    `| Current final-image findings | ${verifiedDelta.currentFindingCount} |`,
    `| Candidate final-image findings | ${verifiedDelta.candidateFindingCount} |`,
    `| New findings at any severity | ${verifiedDelta.introduced.length} |`,
    `| Removed accepted High/Critical findings | ${removed} |`,
    '',
    'Both final runtime images were built for the recorded platform and scanned with the committed Trivy exception policy.',
    'The only repository change is the pinned Node digest in `Dockerfile`; this workflow does not publish or deploy an image.',
    '',
    REMEDIATION_MARKER,
  ].join('\n');
  return { title, body };
}

async function readText(path, field) {
  try {
    return await readFile(resolve(path), 'utf8');
  } catch (error) {
    fail(`cannot read ${field} ${path}: ${error.message}`);
  }
}

async function readJson(path, field) {
  try {
    return JSON.parse(await readText(path, field));
  } catch (error) {
    if (error.message.startsWith('Base digest remediation failed:')) throw error;
    fail(`cannot parse ${field} ${path}: ${error.message}`);
  }
}

async function writeJson(path, value) {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseOptions(argv) {
  const [command, ...remaining] = argv;
  if (!command) fail('missing command');
  const options = new Map();
  for (let index = 0; index < remaining.length; index += 2) {
    const name = remaining[index];
    const value = remaining[index + 1];
    if (!/^--[a-z-]+$/.test(name) || value === undefined || options.has(name)) {
      fail('arguments must be unique --name value pairs');
    }
    options.set(name, value);
  }
  return { command, options };
}

function option(options, name, { required = true } = {}) {
  const value = options.get(name);
  if (required && (!value || value.startsWith('--'))) fail(`missing ${name}`);
  return value;
}

function rejectUnknown(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) fail(`unsupported option ${name}`);
  }
}

async function main() {
  const { command, options } = parseOptions(process.argv.slice(2));
  if (command === 'inspect') {
    rejectUnknown(options, ['--dockerfile', '--platform', '--output']);
    const dockerfile = await readText(option(options, '--dockerfile'), 'Dockerfile');
    const parsed = parsePinnedNodeDockerfile(dockerfile);
    const platform = validateDeploymentPlatform(option(options, '--platform')).value;
    const report = {
      version: 1,
      mode: 'offline-inspection',
      source: OFFICIAL_SOURCE,
      tag: parsed.tag,
      currentDigest: parsed.digest,
      platform,
      candidateResolution: 'not-requested',
    };
    const output = option(options, '--output', { required: false });
    if (output) await writeJson(output, report);
    else console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === 'resolve') {
    rejectUnknown(options, ['--dockerfile', '--platform', '--output', '--expect-candidate-digest']);
    const dockerfile = await readText(option(options, '--dockerfile'), 'Dockerfile');
    const report = await resolveDockerfileCandidate({ dockerfile, platform: option(options, '--platform') });
    const expected = option(options, '--expect-candidate-digest', { required: false });
    if (expected) {
      assertDigest(expected, '--expect-candidate-digest');
      if (!report.candidate || report.candidate.digest !== expected) {
        fail('official registry candidate changed during this workflow run');
      }
    }
    await writeJson(option(options, '--output'), report);
    return;
  }
  if (command === 'create-candidate') {
    rejectUnknown(options, ['--dockerfile', '--resolution', '--output']);
    const dockerfile = await readText(option(options, '--dockerfile'), 'Dockerfile');
    const resolution = validateResolution(await readJson(option(options, '--resolution'), 'resolution'));
    if (!resolution.candidate) fail('cannot create a candidate when the tag digest is unchanged');
    const candidate = replacePinnedNodeDigest(dockerfile, resolution.current.digest, resolution.candidate.digest);
    verifyDigestOnlyDockerfileChange(dockerfile, candidate, resolution);
    await writeFile(resolve(option(options, '--output')), candidate, 'utf8');
    return;
  }
  if (command === 'verify-candidate') {
    rejectUnknown(options, ['--baseline', '--candidate', '--resolution']);
    const resolution = await readJson(option(options, '--resolution'), 'resolution');
    verifyDigestOnlyDockerfileChange(
      await readText(option(options, '--baseline'), 'baseline Dockerfile'),
      await readText(option(options, '--candidate'), 'candidate Dockerfile'),
      resolution,
    );
    console.log('Candidate Dockerfile is an exact digest-only change.');
    return;
  }
  if (command === 'scan-delta') {
    rejectUnknown(options, ['--current', '--candidate', '--output']);
    const delta = evaluateCandidateScanDelta(
      await readJson(option(options, '--current'), 'current Trivy evidence'),
      await readJson(option(options, '--candidate'), 'candidate Trivy evidence'),
    );
    await writeJson(option(options, '--output'), delta);
    return;
  }
  if (command === 'queue-status') {
    rejectUnknown(options, ['--input', '--output']);
    await writeJson(option(options, '--output'), checkMaintenanceQueue(await readJson(option(options, '--input'), 'open pull requests')));
    return;
  }
  if (command === 'workflow-outputs') {
    rejectUnknown(options, ['--resolution', '--queue', '--scan-delta']);
    const resolution = validateResolution(await readJson(option(options, '--resolution'), 'resolution'));
    const queue = options.has('--queue') ? validateQueueStatus(await readJson(option(options, '--queue'), 'maintenance queue status')) : null;
    const delta = options.has('--scan-delta') ? validateScanDelta(await readJson(option(options, '--scan-delta'), 'scan delta')) : null;
    console.log(`resolution=${JSON.stringify(resolution)}`);
    console.log(`candidate_available=${String(Boolean(resolution.candidate))}`);
    console.log(`candidate_digest=${resolution.candidate?.digest ?? ''}`);
    if (queue) console.log(`queue_clear=${String(queue.clear)}`);
    if (delta) {
      console.log(`scan_delta=${JSON.stringify(delta)}`);
      console.log(`scan_qualifies=${String(delta.qualifies)}`);
    }
    return;
  }
  if (command === 'write-pr-metadata') {
    rejectUnknown(options, ['--resolution-json', '--scan-delta-json', '--body-output', '--title-output']);
    let resolution;
    let delta;
    try {
      resolution = JSON.parse(option(options, '--resolution-json'));
      delta = JSON.parse(option(options, '--scan-delta-json'));
    } catch (error) {
      fail(`cannot parse pull request metadata input: ${error.message}`);
    }
    const metadata = remediationMetadata(resolution, delta);
    await writeFile(resolve(option(options, '--body-output')), `${metadata.body}\n`, 'utf8');
    await writeFile(resolve(option(options, '--title-output')), `${metadata.title}\n`, 'utf8');
    return;
  }
  if (command === 'verify-pr') {
    rejectUnknown(options, ['--pull-request', '--files', '--repository', '--branch', '--resolution-json', '--scan-delta-json']);
    let resolution;
    let delta;
    try {
      resolution = JSON.parse(option(options, '--resolution-json'));
      delta = JSON.parse(option(options, '--scan-delta-json'));
    } catch (error) {
      fail(`cannot parse pull request verification input: ${error.message}`);
    }
    verifyPullRequestEligibility({
      pullRequest: await readJson(option(options, '--pull-request'), 'pull request'),
      changedFiles: await readJson(option(options, '--files'), 'pull request files'),
      repository: option(options, '--repository'),
      branch: option(options, '--branch'),
      resolution,
      scanDelta: delta,
    });
    console.log('Pull request is eligible for GitHub auto-merge.');
    return;
  }
  fail(`unknown command ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
