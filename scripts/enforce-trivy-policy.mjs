#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadAndValidateExceptions } from './security-exceptions.mjs';

function fail(message) {
  throw new Error(`Trivy policy enforcement failed: ${message}`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) fail(`missing ${name}`);
  return process.argv[index + 1];
}

function requireSha256(value, field) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) fail(`${field} must be an exact sha256 digest`);
}

function findingsFromEvidence(evidence, scanner) {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) fail('JSON evidence must be an object');
  if (typeof evidence.SchemaVersion !== 'number' && typeof evidence.SchemaVersion !== 'string') fail('JSON evidence is missing SchemaVersion');
  if (typeof evidence.ArtifactName !== 'string' || evidence.ArtifactName.trim() === '') fail('JSON evidence is missing ArtifactName');
  if (typeof evidence.ArtifactType !== 'string' || evidence.ArtifactType.trim() === '') fail('JSON evidence is missing ArtifactType');
  if (scanner === 'filesystem' && evidence.ArtifactType !== 'filesystem') fail(`filesystem evidence has unexpected ArtifactType ${evidence.ArtifactType}`);
  if (scanner === 'image' && evidence.ArtifactType !== 'container_image') fail(`image evidence has unexpected ArtifactType ${evidence.ArtifactType}`);
  if (!Array.isArray(evidence.Results)) fail('JSON evidence Results must be an array');
  const findings = [];
  for (const [resultIndex, result] of evidence.Results.entries()) {
    if (result === null || typeof result !== 'object' || typeof result.Target !== 'string' || result.Target.trim() === '') {
      fail(`JSON evidence result ${resultIndex} is missing an exact Target`);
    }
    if (result.Vulnerabilities === undefined || result.Vulnerabilities === null) continue;
    if (!Array.isArray(result.Vulnerabilities)) fail(`JSON evidence result ${resultIndex} has malformed Vulnerabilities`);
    for (const [findingIndex, finding] of result.Vulnerabilities.entries()) {
      if (finding === null || typeof finding !== 'object') fail(`JSON evidence finding ${resultIndex}:${findingIndex} is malformed`);
      const severity = finding.Severity;
      if (!['HIGH', 'CRITICAL'].includes(severity)) continue;
      for (const field of ['VulnerabilityID', 'PkgName', 'InstalledVersion']) {
        if (typeof finding[field] !== 'string' || finding[field] === '') fail(`JSON evidence high/critical finding ${resultIndex}:${findingIndex} is missing ${field}`);
      }
      findings.push({
        id: finding.VulnerabilityID,
        target: result.Target,
        packageName: finding.PkgName,
        installedVersion: finding.InstalledVersion,
        severity,
      });
    }
  }
  return findings;
}

try {
  const scanner = argument('--scan');
  if (!['filesystem', 'image'].includes(scanner)) fail('--scan must be filesystem or image');
  const inputPath = resolve(argument('--input'));
  const root = resolve(import.meta.dirname, '..');
  const exceptions = await loadAndValidateExceptions({
    configPath: resolve(argument('--exceptions')),
    registerPath: resolve(root, 'docs/security-exceptions.md'),
  });
  const digest = scanner === 'image' ? argument('--image-digest') : null;
  if (digest !== null) requireSha256(digest, '--image-digest');
  let evidence;
  try {
    evidence = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch (error) {
    fail(`cannot parse evidence ${inputPath}: ${error.message}`);
  }
  const findings = findingsFromEvidence(evidence, scanner);
  const unapproved = findings.filter((finding) => !exceptions.some((exception) =>
    exception.findingId === finding.id
    && exception.scanner === scanner
    && exception.target === finding.target
    && exception.packageName === finding.packageName
    && exception.installedVersion === finding.installedVersion
    && exception.imageDigest === digest));
  if (unapproved.length > 0) {
    const report = unapproved.map((finding) => `${finding.severity} ${finding.id} ${finding.packageName}@${finding.installedVersion} in ${finding.target}`).join('; ');
    fail(`unapproved high/critical finding(s): ${report}`);
  }
  console.log(`Trivy ${scanner} policy passed: ${findings.length} high/critical finding(s), all approved or none present.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
