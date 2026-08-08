import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseHumanRegister, validateExceptions } from '../scripts/security-exceptions.mjs';

const root = resolve(import.meta.dirname, '..');
const future = '2999-01-01T00:00:00Z';
const digest = `sha256:${'a'.repeat(64)}`;
const execFileAsync = promisify(execFile);

function exception(overrides = {}) {
  return {
    id: 'test-advisory-001',
    findingId: 'TEST-ADVISORY-001',
    scanner: 'image',
    scope: {
      target: 'content-viewer:security-test (debian 13.0)',
      package: 'test-package',
      installedVersion: '1.2.3',
      imageDigest: digest,
    },
    owner: 'security-test-owner',
    rationale: 'Synthetic test record only.',
    compensatingControl: 'Synthetic test control only.',
    expiresAt: future,
    renewalAuthority: 'security-test-approver',
    renewalBy: future,
    renewalEvidence: 'https://example.invalid/renewal',
    approvalEvidence: 'https://example.invalid/approval',
    ...overrides,
  };
}

function humanRecord(entry) {
  return {
    id: entry.id,
    findingId: entry.findingId,
    scanner: entry.scanner,
    target: entry.scope.target,
    packageName: entry.scope.package,
    installedVersion: entry.scope.installedVersion,
    imageDigest: entry.scope.imageDigest,
    owner: entry.owner,
    rationale: entry.rationale,
    compensatingControl: entry.compensatingControl,
    expiresAt: entry.expiresAt,
    renewalAuthority: entry.renewalAuthority,
    renewalBy: entry.renewalBy,
    renewalEvidence: entry.renewalEvidence,
    approvalEvidence: entry.approvalEvidence,
  };
}

test('the committed empty exception state is valid', async () => {
  const config = JSON.parse(await readFile(resolve(root, 'security/trivy-exceptions.json'), 'utf8'));
  const register = await readFile(resolve(root, 'docs/security-exceptions.md'), 'utf8');
  assert.deepEqual(validateExceptions(config, parseHumanRegister(register)), []);
});

test('an expired exception is rejected', () => {
  const record = exception({ expiresAt: '2000-01-01T00:00:00Z', renewalBy: '2000-01-01T00:00:00Z' });
  assert.throws(() => validateExceptions({ version: 1, exceptions: [record] }, [humanRecord(record)]), /expired/);
});

test('a broad or divergent exception is rejected', () => {
  const record = exception({ scope: { target: 'package-lock.json', package: 'test-*', installedVersion: '1.2.3', imageDigest: null }, scanner: 'filesystem' });
  assert.throws(() => validateExceptions({ version: 1, exceptions: [record] }, [humanRecord(record)]), /wildcards/);

  const exact = exception();
  assert.throws(() => validateExceptions(
    { version: 1, exceptions: [exact] },
    [{ ...humanRecord(exact), owner: 'different-owner' }],
  ), /diverge/);
});

test('filesystem policy accepts the current Trivy repository artifact output only', async () => {
  const testDirectory = resolve(root, '.t-trivy-policy');
  const evidencePath = resolve(testDirectory, 'evidence.json');
  await mkdir(testDirectory, { recursive: true });
  try {
    const runPolicy = async (artifactType) => {
      await writeFile(evidencePath, JSON.stringify({
        SchemaVersion: 2,
        ArtifactName: '.',
        ArtifactType: artifactType,
        Results: [],
      }));
      return execFileAsync(process.execPath, [
        'scripts/enforce-trivy-policy.mjs',
        '--scan', 'filesystem',
        '--input', evidencePath,
        '--exceptions', 'security/trivy-exceptions.json',
      ], { cwd: root });
    };

    await assert.doesNotReject(runPolicy('repository'));
    await assert.rejects(runPolicy('container_image'), /filesystem evidence has unexpected ArtifactType container_image/);
  } finally {
    await rm(testDirectory, { recursive: true, force: true });
  }
});
