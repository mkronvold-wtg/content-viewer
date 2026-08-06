import { readFile } from 'node:fs/promises';

const humanHeaders = [
  'Exception ID', 'Finding ID', 'Scanner', 'Target', 'Package', 'Installed version',
  'Image digest', 'Owner', 'Rationale', 'Compensating control', 'Expires at (UTC)',
  'Renewal authority', 'Renewal by (UTC)', 'Renewal evidence', 'Approval evidence',
];

const requiredTextFields = [
  'id', 'findingId', 'owner', 'rationale', 'compensatingControl',
  'renewalAuthority', 'renewalEvidence', 'approvalEvidence',
];

const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const imageDigest = /^sha256:[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`Security exception validation failed: ${message}`);
}

function requireText(value, field, id) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${id}: ${field} must be a non-empty string`);
  }
  if (value.includes('*') || value.includes('|') || value.includes('\n')) {
    fail(`${id}: ${field} must not contain wildcards, table separators, or newlines`);
  }
}

function requireFutureInstant(value, field, id, now) {
  requireText(value, field, id);
  if (!isoInstant.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${id}: ${field} must be an ISO-8601 UTC instant with seconds`);
  }
  if (Date.parse(value) <= now.getTime()) {
    fail(`${id}: ${field} is expired or due now`);
  }
}

function normalizeException(entry, now = new Date()) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail('each machine exception must be an object');
  }
  for (const field of requiredTextFields) requireText(entry[field], field, entry.id || '<unknown>');
  const id = entry.id;
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) {
    fail(`${id}: id must be a lowercase, hyphenated identifier`);
  }
  if (!['filesystem', 'image'].includes(entry.scanner)) {
    fail(`${id}: scanner must be filesystem or image`);
  }
  if (entry.scope === null || typeof entry.scope !== 'object' || Array.isArray(entry.scope)) {
    fail(`${id}: scope must be an object`);
  }
  const { target, package: packageName, installedVersion, imageDigest: scopedDigest } = entry.scope;
  requireText(target, 'scope.target', id);
  requireText(packageName, 'scope.package', id);
  requireText(installedVersion, 'scope.installedVersion', id);
  if (target.includes('..') || target.startsWith('/') || target.startsWith('\\')) {
    fail(`${id}: scope.target must be a repository-relative scanner target`);
  }
  if (entry.scanner === 'filesystem') {
    if (scopedDigest !== null) fail(`${id}: filesystem exceptions must set scope.imageDigest to null`);
  } else if (typeof scopedDigest !== 'string' || !imageDigest.test(scopedDigest)) {
    fail(`${id}: image exceptions must scope an exact sha256 image digest`);
  }
  requireFutureInstant(entry.expiresAt, 'expiresAt', id, now);
  requireFutureInstant(entry.renewalBy, 'renewalBy', id, now);
  if (Date.parse(entry.renewalBy) > Date.parse(entry.expiresAt)) {
    fail(`${id}: renewalBy must be on or before expiresAt`);
  }
  return {
    id,
    findingId: entry.findingId,
    scanner: entry.scanner,
    target,
    packageName,
    installedVersion,
    imageDigest: scopedDigest,
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

export function parseHumanRegister(markdown) {
  const start = '<!-- EXCEPTION-REGISTER-START -->';
  const end = '<!-- EXCEPTION-REGISTER-END -->';
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    fail('human register must contain one marked exception table');
  }
  if (markdown.indexOf(start, startIndex + start.length) >= 0 || markdown.indexOf(end, endIndex + end.length) >= 0) {
    fail('human register markers must appear exactly once');
  }
  const tableLines = markdown.slice(startIndex + start.length, endIndex)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));
  if (tableLines.length < 2) fail('human register must include a header and separator row');
  const splitRow = (line) => line.slice(1, -1).split('|').map((cell) => cell.trim());
  const headers = splitRow(tableLines[0]);
  if (JSON.stringify(headers) !== JSON.stringify(humanHeaders)) {
    fail('human register table headers do not match the required schema');
  }
  if (!splitRow(tableLines[1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
    fail('human register table separator is invalid');
  }
  return tableLines.slice(2).map((line, index) => {
    const cells = splitRow(line);
    if (cells.length !== humanHeaders.length) fail(`human register row ${index + 1} has the wrong number of columns`);
    return {
      id: cells[0], findingId: cells[1], scanner: cells[2], target: cells[3], packageName: cells[4],
      installedVersion: cells[5], imageDigest: cells[6] === 'null' ? null : cells[6], owner: cells[7],
      rationale: cells[8], compensatingControl: cells[9], expiresAt: cells[10], renewalAuthority: cells[11],
      renewalBy: cells[12], renewalEvidence: cells[13], approvalEvidence: cells[14],
    };
  });
}

export function validateExceptions(config, humanRecords, now = new Date()) {
  if (config === null || typeof config !== 'object' || Array.isArray(config) || config.version !== 1 || !Array.isArray(config.exceptions)) {
    fail('machine configuration must be an object with version 1 and an exceptions array');
  }
  const normalized = config.exceptions.map((entry) => normalizeException(entry, now));
  const seenIds = new Set();
  const seenScopes = new Set();
  for (const entry of normalized) {
    if (seenIds.has(entry.id)) fail(`${entry.id}: duplicate exception id`);
    seenIds.add(entry.id);
    const scopeKey = [entry.findingId, entry.scanner, entry.target, entry.packageName, entry.installedVersion, entry.imageDigest].join('\u0000');
    if (seenScopes.has(scopeKey)) fail(`${entry.id}: duplicate finding scope`);
    seenScopes.add(scopeKey);
  }
  if (!Array.isArray(humanRecords)) fail('human register records must be an array');
  const machineById = new Map(normalized.map((entry) => [entry.id, entry]));
  const humanById = new Map();
  for (const record of humanRecords) {
    if (!record.id || humanById.has(record.id)) fail(`human register has duplicate or blank id ${record.id || '<blank>'}`);
    humanById.set(record.id, record);
  }
  if (machineById.size !== humanById.size) fail('machine configuration and human register have different exception counts');
  for (const [id, entry] of machineById) {
    const record = humanById.get(id);
    if (!record) fail(`${id}: missing from human register`);
    if (JSON.stringify(entry) !== JSON.stringify(record)) fail(`${id}: machine configuration and human register diverge`);
  }
  return normalized;
}

export async function loadAndValidateExceptions({ configPath, registerPath, now = new Date() }) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    fail(`cannot parse machine configuration ${configPath}: ${error.message}`);
  }
  let register;
  try {
    register = await readFile(registerPath, 'utf8');
  } catch (error) {
    fail(`cannot read human register ${registerPath}: ${error.message}`);
  }
  return validateExceptions(config, parseHumanRegister(register), now);
}
